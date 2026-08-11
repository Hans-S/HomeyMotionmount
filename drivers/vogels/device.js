'use strict';

const { Device } = require('homey');

// Debounce window for slider changes, so dragging a slider results in a single
// BLE write at the end instead of one write per intermediate value.
const SET_POSITION_DEBOUNCE_MS = 500;

// Upper bound on a single BLE find/connect, so onInit and reconnect can never
// hang indefinitely on an unresponsive peripheral.
const BLE_CONNECT_TIMEOUT_MS = 15000;

// Upper bound on a single characteristic read/write. The SDK's own read timeout
// is ~30s, during which the BLE mutex stays held and every queued command
// stalls. A short bound fails fast (e.g. when another central has grabbed the
// single-connection mount mid-operation) and frees the lock. See _withTimeout.
const BLE_READ_TIMEOUT_MS = 7000;

// Upper bound on a disconnect. An un-timed disconnect that hangs would hold the
// BLE mutex forever and leave the mount's single connection slot half-open.
const BLE_DISCONNECT_TIMEOUT_MS = 8000;

// Backstop: hard cap on any single locked BLE operation. The per-call timeouts
// already bound each step, so this only catches an unforeseen hang and keeps the
// mutex from ever jamming permanently.
const BLE_OP_TIMEOUT_MS = 150000;

class MotionMountDevice extends Device {

  async onInit() {
    this.advertisement = undefined;
    this.peripheral = undefined;
    this.presetCharacteristics = [];
    this.presets = [];

    // Serializes all BLE access so commands and polling can never run
    // concurrently on the same peripheral (#3).
    this._bleLock = Promise.resolve();

    // Polling loop bookkeeping (#2).
    this._timerId = null;
    this._pollEpoch = 0;

    // Debounce timer for slider-driven position writes.
    this._setPositionTimer = null;

    // Register all capability listeners once, here in onInit. Doing this in
    // initialize() meant a later reconnect() -> initialize() re-registered them,
    // which the SDK rejects (#2).
    if (this.hasCapability('preset')) {
      this.registerCapabilityListener('preset', async value => {
        return this.onCapabilityPreset(value);
      });
    } else {
      this.error('No preset capability present, this should not happen');
    }

    this.registerCapabilityListener('set_extend', async value => {
      if (value >= 0 && value <= 100) {
        this.extendPosition = Buffer.from([0x00, value]);
        this._scheduleSetPosition();
        return;
      }
      this.log(`Invalid extend position ${value}. Must be between 0 and 100`);
    });

    this.registerCapabilityListener('set_turn', async value => {
      if (value >= -100 && value <= 100) {
        if (value < 0) {
          this.turnPosition = Buffer.from([0xff, 255 + value]);
        } else {
          this.turnPosition = Buffer.from([0x00, value]);
        }
        this._scheduleSetPosition();
        return;
      }
      this.log(`Invalid turn position ${value}. Must be between -100 and 100`);
    });

    this.setUnavailable('Awaiting initial connect');

    try {
      await this.connect();
      await this.loadPresets();
      await this.updatePresetCapabilityOptions();
      this.setAvailable();
      // initialize() reads the initial position: immediately via _startPolling()
      // when polling is on, or once directly when it's off.
      this.initialize();
      this.log('MotionMountDevice has been initialized');
    } catch (error) {
      this.error(`Error in initial connect: ${error}`);
      this.setUnavailable(`Initial connection to device failed: ${error}`);

      setTimeout(() => {
        this.reconnect();
      }, 30000);
    }
  }

  async initialize() {
    // polling_interval is configured in seconds (see driver.settings.compose.json).
    // This used to multiply by 60000 here while onSettings used 1000, so the
    // interval changed by 60x the first time settings were touched (#1).
    this._pollingInterval = this.getSettings().polling_interval * 1000;

    if (this.getSettings().polling === true) {
      this.log(`Polling enabled every ${this._pollingInterval / 1000}s, initial position check`);
      this._startPolling();
    } else {
      this._stopPolling();
      // With polling off, nothing else refreshes the position, so read it once
      // here to seed the sliders and tiles. After this they only update when the
      // mount is moved from within the app (optimistic updates in setPosition /
      // gotoPreset). External changes won't be reflected until polling is on.
      await this.getPosition();
      this.log('Device initialize phase two complete, polling disabled');
    }
  }

  async reconnect() {
    // This is used if initial connection fails as a retry mechanism
    try {
      await this.connect();
      this.setAvailable();
      this.initialize();
    } catch (error) {
      this.error(`Error on reconnect: ${error}`);
      this.setUnavailable(`Reconnect to device failed: ${error}`);

      setTimeout(() => {
        this.reconnect();
      }, 30000);
    }
  }

  // Connect to the peripheral and discover the characteristics we use.
  // Throws on failure so callers (onInit, reconnect) can rely on the rejection
  // to drive their retry logic (#4).
  async connect() {
    if (!this.advertisement) {
      try {
        this.advertisement = await this._withTimeout(
          this.homey.ble.find(this.getStore().peripheralUuid),
          BLE_CONNECT_TIMEOUT_MS,
          'BLE find',
        );
        this.log('Peripheral found');
      } catch (error) {
        this.log(`BLE find error: ${error}`);
        throw error;
      }
    }

    if (!this.peripheral) {
      this.log('Initial connect');
      await this.internalConnect();

      if (!this.peripheral.isConnected) {
        throw new Error('Could not make initial BLE connection');
      }

      try {
        this.service = await this._withTimeout(
          this.peripheral.getService('3e6fe65ded7811e4895e00026fd5c52c'),
          BLE_CONNECT_TIMEOUT_MS,
          'BLE getService',
        );

        const characteristics = await this._withTimeout(
          this.service.discoverCharacteristics(),
          BLE_CONNECT_TIMEOUT_MS,
          'BLE discoverCharacteristics',
        );
        characteristics.forEach(characteristic => {
          if (characteristic.uuid === 'c005fa0006514800b000000000000000') {
            this.extendPositionCharacteristic = characteristic;
          } else if (characteristic.uuid === 'c005fa0106514800b000000000000000') {
            this.turnPositionCharacteristic = characteristic;
          } else if (characteristic.uuid === 'c005fa2106514800b000000000000000') {
            this.moveCharacteristic = characteristic;
          }

          // Store preset slot characteristics (0x0a..0x13)
          if (characteristic.uuid.startsWith('c005fa')) {
            const byteVal = parseInt(characteristic.uuid.substring(6, 8), 16);

            if (byteVal >= 0x0a && byteVal <= 0x13) {
              this.presetCharacteristics.push(characteristic);
              this.log('Found possible preset characteristic:', characteristic.uuid);
            }
          }
        });

        this.peripheral.on('disconnect', () => {
          this.log(`disconnected: ${this.getName()}`);
        });
      } catch (err) {
        // We connected but couldn't finish discovery. Release the link and drop
        // the handle so we don't leak a half-open connection or get stuck with a
        // connected-but-undiscovered peripheral. Next connect() rebuilds fresh.
        this.log(`Discovery failed, releasing connection: ${err}`);
        await this.disconnect();
        this._resetConnection();
        throw err;
      }
    } else {
      this.log(`Peripheral known, isConnected: ${this.peripheral.isConnected}`);
      this.log(`State: ${this.peripheral.state}`);

      if (!this.peripheral.isConnected) {
        this.log('Peripheral already known, connecting...');
        await this.internalConnect();
      } else {
        this.log('Already connected');
      }
    }
  }

  async internalConnect() {
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.log(`connect attempt ${attempt}`);

        // Wait until the peripheral has finished disconnecting
        if (this.peripheral && this.peripheral.state === 'disconnecting') {
          this.log('waiting for disconnect to finish');
          await this.sleep(1000);
        }

        if (!this.peripheral) {
          this.peripheral = await this._withTimeout(this.advertisement.connect(), BLE_CONNECT_TIMEOUT_MS, 'BLE connect');
        } else {
          await this._withTimeout(this.peripheral.connect(), BLE_CONNECT_TIMEOUT_MS, 'BLE connect');
        }

        if (!this.peripheral.isConnected) {
          throw new Error('connect returned but not connected');
        }
        this.log('BLE connected');
        return;
      } catch (err) {
        this.log('connect failed:', err.message);
        if (this.peripheral) {
          try {
            await this._withTimeout(this.peripheral.disconnect(), BLE_DISCONNECT_TIMEOUT_MS, 'BLE disconnect');
          } catch (e) {
            // ignore: we're already handling a failed connect
          }
        }
        if (attempt === MAX_RETRIES) {
          throw err;
        }
        await this.sleep(500);
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Runs fn after any in-flight BLE operation has finished, so reads (polling)
  // and writes (commands) never overlap on the peripheral (#3). Failures are
  // isolated so one rejected operation doesn't break the queue for the next.
  _runExclusive(fn) {
    const result = this._bleLock
      .then(() => this._withTimeout(fn(), BLE_OP_TIMEOUT_MS, 'BLE operation'))
      .catch(err => {
        // Backstop: if a locked op blew the hard cap, the connection may be
        // wedged. Discard it so the next op rebuilds cleanly.
        if (err && /BLE operation timed out/.test(err.message)) {
          this.error('BLE operation exceeded hard cap; resetting connection', err);
          this._resetConnection();
        }
        throw err;
      });
    // Keep the chain alive even if this operation rejected.
    this._bleLock = result.then(() => {}, () => {});
    return result;
  }

  // Discards the current BLE handle and cached characteristics so the next
  // connect() rebuilds from scratch (fresh connect + rediscovery). Used to
  // self-heal when a disconnect/discovery fails and the peripheral may be
  // wedged or half-open. this.presets (the loaded preset data) is kept.
  _resetConnection() {
    this.peripheral = undefined;
    this.service = undefined;
    this.extendPositionCharacteristic = undefined;
    this.turnPositionCharacteristic = undefined;
    this.moveCharacteristic = undefined;
    this.presetCharacteristics = [];
  }

  // Rejects if the wrapped promise doesn't settle within ms, so a hung BLE call
  // can't stall onInit / reconnect / the command queue forever.
  _withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    // If the original settles after we've already timed out, swallow its result
    // so a late rejection doesn't surface as an unhandled promise rejection.
    promise.catch(() => {});
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // Coalesces rapid slider changes into a single BLE write once the user stops
  // moving the slider for SET_POSITION_DEBOUNCE_MS.
  _scheduleSetPosition() {
    if (this._setPositionTimer) {
      clearTimeout(this._setPositionTimer);
    }
    this._setPositionTimer = setTimeout(() => {
      this._setPositionTimer = null;
      this.setPosition().catch(err => this.error('Debounced setPosition failed', err));
    }, SET_POSITION_DEBOUNCE_MS);
  }

  async disconnect() {
    if (!this.peripheral) {
      this.log('Not disconnecting, no peripheral to disconnect');
      return;
    }
    try {
      await this._withTimeout(this.peripheral.disconnect(), BLE_DISCONNECT_TIMEOUT_MS, 'BLE disconnect');
    } catch (error) {
      // A hung/failed disconnect can leave the mount's single connection slot
      // occupied. Drop the handle so the next connect() rebuilds cleanly instead
      // of reusing a wedged peripheral (self-heal).
      this.log(`Error disconnecting, discarding peripheral handle: ${error}`);
      this._resetConnection();
    }
  }

  async loadPresets() {
    return this._runExclusive(() => this._loadPresetsLocked());
  }

  async _loadPresetsLocked() {
    this.log('Loading presets from MotionMount…');

    await this.connect();

    const presets = [];

    for (const characteristic of this.presetCharacteristics) {
      const { uuid } = characteristic;

      if (!this.peripheral || !this.peripheral.isConnected) {
        this.log('loadPresets: peripheral not connected, reconnecting...');
        await this.connect();
      }

      let buf;

      try {
        buf = await this._withTimeout(characteristic.read(), BLE_READ_TIMEOUT_MS, 'Preset read');
      } catch (err) {
        this.log('Error reading preset characteristic', uuid, err);
        continue;
      }

      // Check if we have a valid preset. Valid presets start with 0x01
      if (!buf || buf.length < 6 || buf[0] !== 0x01) {
        continue;
      }

      const moveBuffer = buf.slice(1, 5);

      // name from bytes [6..] until 0x00
      let name = '';
      for (let i = 5; i < buf.length; i++) {
        const b = buf[i];
        if (b === 0x00) break;
        name += String.fromCharCode(b);
      }
      if (!name) {
        name = `Preset ${presets.length}`;
      }

      presets.push({
        name,
        moveBuffer,
        uuid,
      });
    }

    this.presets = presets;
    this.log('Presets loaded:', this.presets.map(p => p.name).join(', '));
  }

  async updatePresetCapabilityOptions() {
    if (!this.hasCapability('preset')) {
      this.log('updatePresetCapabilityOptions: No preset capability!');
      return;
    }

    // The picker is a momentary action list: it always sits on the neutral
    // "Select preset…" entry when idle, and is reset back to it after each
    // selection (see onCapabilityPreset). That way selecting any preset — even
    // the one shown last time — always registers as a change and fires a move.
    // The app can't reliably know which preset the mount is physically on, so
    // the picker doesn't try to display it; the position tiles/sliders do.
    const values = [
      { id: 'none', title: { en: 'Select preset…', nl: 'Kies preset…' } },
      ...this.presets.map((preset, index) => ({
        id: String(index),
        title: {
          en: preset.name,
          nl: preset.name,
        },
      })),
    ];

    await this.setCapabilityOptions('preset', { values });
    await this.setCapabilityValue('preset', 'none').catch(err => this.error('Failed to reset preset picker', err));
  }

  async onCapabilityPreset(value) {
    // The neutral entry is not an action.
    if (value === 'none') {
      return;
    }

    const index = Number(value);
    this.log('Preset capability changed to index', index);

    if (Number.isNaN(index) || index < 0 || index >= this.presets.length) {
      this.log('Invalid preset index', value);
      return;
    }

    await this.gotoPreset(index);

    // Reset to the neutral entry so re-selecting the same preset fires again.
    await this.setCapabilityValue('preset', 'none').catch(err => this.error('Failed to reset preset picker', err));
  }

  async gotoPreset(index) {
    return this._runExclusive(() => this._gotoPresetLocked(index));
  }

  async _gotoPresetLocked(index) {
    const preset = this.presets[index];
    if (!preset) {
      this.log('Preset not found for index', index);
      return;
    }

    this.log('Going to preset', index, preset.name);

    try {
      await this.connect();

      if (!this.moveCharacteristic) {
        this.log('moveCharacteristic not set');
        return;
      }

      // moveBuffer = 4 bytes [extendMSB, extendLSB, turnMSB, turnLSB]
      await this._withTimeout(this.moveCharacteristic.write(preset.moveBuffer), BLE_READ_TIMEOUT_MS, 'Preset write');

      // Keep the position cache in sync with the preset we just moved to, so a
      // later single-axis slider change doesn't re-send a stale value for the
      // other axis and move it back. See setPosition (#1).
      this.extendPosition = Buffer.from([preset.moveBuffer[0], preset.moveBuffer[1]]);
      this.turnPosition = Buffer.from([preset.moveBuffer[2], preset.moveBuffer[3]]);

      // Optimistically reflect the preset's position in the sliders and tiles.
      await this._publishExtend(this.extendPosition);
      await this._publishTurn(this.turnPosition);
    } catch (err) {
      this.error('Error writing preset move buffer', err);
    } finally {
      try {
        if (this.peripheral?.isConnected) {
          await this.disconnect();
        }
      } catch (e) {
        this.error('Disconnect after preset move failed', e);
      }
    }
  }

  async setPosition() {
    return this._runExclusive(() => this._setPositionLocked());
  }

  async _setPositionLocked() {
    this.log('setPosition entry');

    if (!this.extendPosition || !this.turnPosition) {
      this.log('setPosition: extend/turn position not initialised yet, skipping');
      return;
    }

    try {
      const newPosition = Buffer.from([
        this.extendPosition[0],
        this.extendPosition[1],
        this.turnPosition[0],
        this.turnPosition[1],
      ]);
      this.log(newPosition);

      this.log('setPosition: Connecting...');
      await this.connect();

      if (!this.moveCharacteristic) {
        this.log('moveCharacteristic not set, cannot write position');
        return;
      }

      this.log('setPosition: Writing new position');
      await this._withTimeout(this.moveCharacteristic.write(newPosition), BLE_READ_TIMEOUT_MS, 'Position write');

      // Optimistically reflect the position we just commanded, so the sliders
      // and tiles are correct immediately without waiting for the next poll.
      await this._publishExtend(this.extendPosition);
      await this._publishTurn(this.turnPosition);
    } catch (error) {
      this.error('Error in setPosition:', error);
    } finally {
    // Disconnect inside the locked operation instead of a detached 5s timer.
    // The old setTimeout disconnect could fire mid-read during a poll, which is
    // what produced the "Error: Not connected" in getPosition (#3).
      try {
        if (this.peripheral?.isConnected) {
          await this.disconnect();
        }
      } catch (e) {
        this.error('Error disconnecting after setPosition:', e);
      }
    }
  }

  // Pushes an extend buffer ([0x00, value]) to the slider + info tiles. Used
  // both after a poll read and to optimistically reflect an app-issued move.
  async _publishExtend(buf) {
    const extendInt = parseInt(buf.toString('hex'), 16);
    await this.setCapabilityValue('set_extend', extendInt).catch(err => this.error('set_extend failed', err));
    // current_* shows a readable decimal rather than the raw hex buffer
    await this.setCapabilityValue('current_extend', String(extendInt)).catch(err => this.error('current_extend failed', err));
  }

  // Pushes a turn buffer to the slider + info tiles. The mount encodes negative
  // turn as 0xffXX, which decodes back to a signed -100..100 value.
  async _publishTurn(buf) {
    let turnInt = parseInt(buf.toString('hex'), 16);
    if (turnInt > 100) {
      turnInt = (65535 - turnInt) * -1;
    }
    await this.setCapabilityValue('set_turn', turnInt).catch(err => this.error('set_turn failed', err));
    await this.setCapabilityValue('current_turn', String(turnInt)).catch(err => this.error('current_turn failed', err));
  }

  async getPosition() {
    return this._runExclusive(() => this._getPositionLocked());
  }

  async _getPositionLocked() {
    try {
      this.log('getPosition: Connecting...');
      await this.connect();

      if (!this.peripheral?.isConnected) {
        this.log('Cannot read position, connection failed');
        return;
      }

      this.log('Connected');

      // ----- EXTEND -----

      if (this.extendPositionCharacteristic) {
        const buf = await this._withTimeout(this.extendPositionCharacteristic.read(), BLE_READ_TIMEOUT_MS, 'Extend read');
        this.log('Extend position:', buf);
        this.extendPosition = buf;
        await this._publishExtend(buf);
      } else {
        this.log('extendPositionCharacteristic is null');
      }

      // ----- TURN -----

      if (this.turnPositionCharacteristic) {
        const buf = await this._withTimeout(this.turnPositionCharacteristic.read(), BLE_READ_TIMEOUT_MS, 'Turn read');
        this.log('Turn position:', buf);
        this.turnPosition = buf;
        await this._publishTurn(buf);
      } else {
        this.log('turnPositionCharacteristic is null');
      }
    } catch (err) {
      this.error('Error reading position', err);
    } finally {
      try {
        if (this.peripheral?.isConnected) {
          this.log('Disconnecting...');
          await this.disconnect();
        }
      } catch (e) {
        this.error('Disconnect failed', e);
      }
    }
  }

  _startPolling() {
    this._stopPolling();
    const epoch = ++this._pollEpoch;

    const loop = async () => {
      if (epoch !== this._pollEpoch) return;
      try {
        await this.getPosition();
      } catch (err) {
        // Never let a failed poll stop the loop (e.g. the hard-cap watchdog).
        this.error('Poll failed', err);
      }
      // Re-check after the await: the loop may have been stopped/restarted
      // while getPosition was running, which is how the old refresh() leaked
      // stacked timers on every reconnect (#2).
      if (epoch !== this._pollEpoch) return;
      this._timerId = setTimeout(loop, this._pollingInterval);
    };

    loop();
  }

  _stopPolling() {
    // Bumping the epoch invalidates any loop iteration still in flight.
    this._pollEpoch++;
    if (this._timerId) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
  }

  async onGotoPosition({ extend, turn }) {
    this.log('Flow: goto_position', extend, turn);

    if (extend < 0 || extend > 100) {
      this.log('Invalid extend position', extend);
      return;
    }
    if (turn < -100 || turn > 100) {
      this.log('Invalid turn position', turn);
      return;
    }

    this.extendPosition = Buffer.from([0x00, extend]);

    if (turn < 0) {
      this.turnPosition = Buffer.from([0xff, 255 + turn]);
    } else {
      this.turnPosition = Buffer.from([0x00, turn]);
    }

    await this.setPosition();
  }

  async onGotoPreset(presetIndex) {
    const index = Number(presetIndex);
    this.log('Flow: goto_preset', index);

    if (Number.isNaN(index) || index < 0 || index >= this.presets.length) {
      this.log('Invalid preset index in flow', presetIndex);
      return;
    }

    await this.gotoPreset(index);

    // Keep the picker on its neutral entry (see onCapabilityPreset).
    await this.setCapabilityValue('preset', 'none').catch(err => this.error('Failed to reset preset picker', err));
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('polling_interval')) {
      this._pollingInterval = newSettings.polling_interval * 1000;
      this.log(`Polling interval changed to ${this._pollingInterval / 1000}s`);
    }

    if (changedKeys.includes('polling') || changedKeys.includes('polling_interval')) {
      if (newSettings.polling === true) {
        this.log('Polling enabled');
        this._startPolling();
      } else {
        this.log('Polling disabled');
        this._stopPolling();
      }
    }
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('MotionMountDevice has been added');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log(`MotionMountDevice was renamed to ${name}`);
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this._stopPolling();
    if (this._setPositionTimer) {
      clearTimeout(this._setPositionTimer);
      this._setPositionTimer = null;
    }
    this.log('MotionMountDevice has been deleted');
  }

}

module.exports = MotionMountDevice;
