'use strict';

const { Device } = require('homey');

const SERVICE_UUID = '3e6fe65ded7811e4895e00026fd5c52c';
const MOVE_CHARACTERISTIC_UUID = 'c005fa2106514800b000000000000000';

// One timeout per connect attempt: increasing, and the number of entries is the
// attempt limit. A failed connect walks down the list, then gives up.
const CONNECT_TIMEOUTS_MS = [6000, 12000, 20000];

// Fixed timeout for the find and for every GATT call (discover/read/write/disconnect).
const BLE_TIMEOUT_MS = 8000;

class MotionMountDevice extends Device {

  async onInit() {
    this.presets = [];
    // Serializes BLE access so two operations never overlap on the mount.
    this._chain = Promise.resolve();

    await this._syncCapabilities();

    this.registerCapabilityListener('preset', value => this.onPreset(value));
    this.registerCapabilityListener('retry_setup', () => this.setup());

    // Clear any stale "unavailable" state left by older versions of the app.
    this.setAvailable().catch(() => {});

    this.setup();
  }

  // Reconcile a device upgraded from an older version with the current manifest:
  // drop the removed extend/turn/position capabilities and add the reconnect
  // button. A device paired on this version already matches, so this is a no-op.
  async _syncCapabilities() {
    const wanted = ['preset', 'retry_setup'];
    for (const capability of this.getCapabilities()) {
      if (!wanted.includes(capability)) {
        this.log('Removing stale capability', capability);
        await this.removeCapability(capability).catch(err => this.error('removeCapability', capability, err));
      }
    }
    for (const capability of wanted) {
      if (!this.hasCapability(capability)) {
        this.log('Adding capability', capability);
        await this.addCapability(capability).catch(err => this.error('addCapability', capability, err));
      }
    }
  }

  // Connect once, read the presets, and fill the preset picker. Runs at startup
  // and whenever the "Reconnect" button is pressed. On failure it sets a warning
  // (rather than going unavailable) so the button stays pressable.
  async setup() {
    try {
      await this._exclusive(() => this._withConnection(async peripheral => {
        this.presets = await this._readPresets(peripheral);
      }));
      await this._updatePresetOptions();
      await this.unsetWarning().catch(() => {});
      this.log('Setup complete. Presets:', this.presets.map(p => p.name).join(', '));
    } catch (err) {
      this.error('Setup failed:', err);
      await this.setWarning('Could not connect to the MotionMount. Press "Reconnect" to try again.').catch(() => {});
    }
  }

  // Preset picker (UI): move, then reset to the neutral entry so selecting the
  // same preset again fires another move.
  async onPreset(value) {
    if (value === 'none') {
      return;
    }
    await this.gotoPreset(Number(value));
    await this.setCapabilityValue('preset', 'none').catch(() => {});
  }

  // Flow card: goto_preset.
  async onGotoPreset(index) {
    await this.gotoPreset(index);
  }

  async gotoPreset(index) {
    const preset = this.presets[index];
    if (!preset) {
      this.log('Unknown preset index', index);
      return;
    }
    this.log('Going to preset', index, preset.name);
    await this._exclusive(() => this._withConnection(async peripheral => {
      const move = await this._getCharacteristic(peripheral, MOVE_CHARACTERISTIC_UUID);
      await this._withTimeout(move.write(preset.moveBuffer), BLE_TIMEOUT_MS, 'preset write');
    }));
  }

  // --- BLE helpers ---

  // Runs fn after any in-flight BLE operation has finished.
  _exclusive(fn) {
    const result = this._chain.then(fn);
    this._chain = result.catch(() => {});
    return result;
  }

  // Rejects if a BLE call doesn't settle within ms.
  _withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    promise.catch(() => {}); // swallow a late rejection after we've timed out
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // Find + connect (retrying with increasing timeouts), run fn(peripheral), then
  // always disconnect. A new peripheral is used per attempt and the failed one is
  // disconnected before the next try, so nothing is left hanging.
  async _withConnection(fn) {
    const advertisement = await this._withTimeout(
      this.homey.ble.find(this.getStore().peripheralUuid), BLE_TIMEOUT_MS, 'find',
    );

    let peripheral;
    let lastErr;
    for (const timeout of CONNECT_TIMEOUTS_MS) {
      try {
        peripheral = await this._withTimeout(advertisement.connect(), timeout, 'connect');
        if (!peripheral.isConnected) {
          throw new Error('connect returned but not connected');
        }
        break;
      } catch (err) {
        lastErr = err;
        this.log(`Connect failed (timeout ${timeout}ms): ${err.message}`);
        if (peripheral) {
          try {
            await this._withTimeout(peripheral.disconnect(), BLE_TIMEOUT_MS, 'disconnect');
          } catch (e) { /* ignore, we're already failing */ }
          peripheral = undefined;
        }
      }
    }
    if (!peripheral) {
      throw lastErr || new Error('could not connect');
    }

    try {
      return await fn(peripheral);
    } finally {
      try {
        await this._withTimeout(peripheral.disconnect(), BLE_TIMEOUT_MS, 'disconnect');
      } catch (e) {
        this.log('Disconnect failed:', e.message);
      }
    }
  }

  async _discover(peripheral) {
    const service = await this._withTimeout(peripheral.getService(SERVICE_UUID), BLE_TIMEOUT_MS, 'getService');
    return this._withTimeout(service.discoverCharacteristics(), BLE_TIMEOUT_MS, 'discoverCharacteristics');
  }

  async _getCharacteristic(peripheral, uuid) {
    const characteristic = (await this._discover(peripheral)).find(c => c.uuid === uuid);
    if (!characteristic) {
      throw new Error(`characteristic ${uuid} not found`);
    }
    return characteristic;
  }

  // Reads the preset slots (0x0a..0x13). Each valid slot starts with 0x01, then
  // a 4-byte move buffer, then a null-terminated name.
  async _readPresets(peripheral) {
    const presets = [];
    for (const characteristic of await this._discover(peripheral)) {
      if (!characteristic.uuid.startsWith('c005fa')) {
        continue;
      }
      const slot = parseInt(characteristic.uuid.substring(6, 8), 16);
      if (slot < 0x0a || slot > 0x13) {
        continue;
      }

      let buf;
      try {
        buf = await this._withTimeout(characteristic.read(), BLE_TIMEOUT_MS, 'preset read');
      } catch (e) {
        this.log('Preset read failed', characteristic.uuid, e.message);
        continue;
      }
      if (!buf || buf.length < 6 || buf[0] !== 0x01) {
        continue;
      }

      let name = '';
      for (let i = 5; i < buf.length; i++) {
        if (buf[i] === 0x00) {
          break;
        }
        name += String.fromCharCode(buf[i]);
      }

      presets.push({
        name: name || `Preset ${presets.length}`,
        moveBuffer: buf.slice(1, 5),
      });
    }
    return presets;
  }

  async _updatePresetOptions() {
    if (!this.hasCapability('preset')) {
      return;
    }
    const values = [
      { id: 'none', title: { en: 'Select preset…', nl: 'Kies preset…' } },
      ...this.presets.map((preset, index) => ({
        id: String(index),
        title: { en: preset.name, nl: preset.name },
      })),
    ];
    await this.setCapabilityOptions('preset', { values });
    await this.setCapabilityValue('preset', 'none').catch(() => {});
  }

  async onDeleted() {
    this.log('MotionMountDevice has been deleted');
  }

}

module.exports = MotionMountDevice;
