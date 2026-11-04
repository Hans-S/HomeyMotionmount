'use strict';

const { Device } = require('homey');

// Supported MotionMount models. They share the same scheme (presets at slots
// 0x0a..0x16, move at slot 21) but use different UUIDs. A preset slot holds
// [0x01, extend(2), turn(2), name]; the mount is moved by writing those 4 bytes
// unchanged to the move characteristic, as the official app does (verified on a
// 7355 with a PacketLogger trace; assumed, not yet verified, on the 5675).
const PROFILES = [
  {
    model: 'NEXT (7355/7356)',
    service: '3e6fe65ded7811e4895e00026fd5c52c',
    prefix: 'c005fa',
    move: 'c005fa2106514800b000000000000000',
  },
  {
    model: 'ELITE (5675)',
    service: '94ff08d87129444680574a1ab3b2ebc1',
    prefix: '94fffa',
    move: '94fffa217129444680574a1ab3b2ebc1',
  },
];

// Preset characteristic slot range (byte at UUID offset 6-7). 0x0a..0x16 covers
// both models; each real preset's value starts with 0x01.
const PRESET_SLOT_MIN = 0x0a;
const PRESET_SLOT_MAX = 0x16;

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

    // Reconcile a device upgraded from an older version with the current
    // manifest: drop the removed extend/turn/position capabilities and add the
    // reconnect button, so existing installs keep working without a re-pair.
    // A device paired on this version already matches, so this is a no-op.
    const wanted = ['preset', 'retry_setup'];
    for (const capability of this.getCapabilities()) {
      if (!wanted.includes(capability)) {
        await this.removeCapability(capability).catch(err => this.error('removeCapability', capability, err));
      }
    }
    for (const capability of wanted) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability).catch(err => this.error('addCapability', capability, err));
      }
    }

    this.registerCapabilityListener('preset', value => this.onPreset(value));
    this.registerCapabilityListener('retry_setup', () => this.setup());

    this.setup();
  }

  // Connect once, read the presets, and fill the preset picker. Runs at startup
  // and whenever the "Reconnect" button is pressed. On failure it sets a warning
  // (rather than going unavailable) so the button stays pressable.
  async setup() {
    try {
      await this._exclusive(() => this._withConnection(async peripheral => {
        let presets = [];
        try {
          presets = await this._readPresets(peripheral);
        } finally {
          if (presets.length === 0) {
            await this._logGatt(peripheral).catch(err => this.log('GATT dump failed:', err.message));
          }
        }
        this.presets = presets;
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
      const { profile, characteristics } = await this._resolve(peripheral);
      const move = characteristics.find(c => c.uuid === profile.move);
      if (!move) {
        throw new Error(`move characteristic not found on ${profile.model}`);
      }
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

  // Detects which model this mount is and returns its profile plus the
  // discovered characteristics, by trying each known profile's service.
  async _resolve(peripheral) {
    for (const profile of PROFILES) {
      let service;
      try {
        service = await this._withTimeout(peripheral.getService(profile.service), BLE_TIMEOUT_MS, 'getService');
      } catch (e) {
        continue; // not this model; try the next profile
      }
      if (!service) {
        continue;
      }
      const characteristics = await this._withTimeout(service.discoverCharacteristics(), BLE_TIMEOUT_MS, 'discoverCharacteristics');
      return { profile, characteristics };
    }
    throw new Error('no known MotionMount service found on this device');
  }

  // Reads the preset slots. Each valid slot starts with 0x01, then a 4-byte move
  // buffer ([extend, turn]), then a null-terminated name.
  async _readPresets(peripheral) {
    const { profile, characteristics } = await this._resolve(peripheral);
    this.log('Detected model', profile.model);
    const presets = [];
    for (const characteristic of characteristics) {
      if (!characteristic.uuid.startsWith(profile.prefix)) {
        continue;
      }
      const slot = parseInt(characteristic.uuid.substring(6, 8), 16);
      if (slot < PRESET_SLOT_MIN || slot > PRESET_SLOT_MAX) {
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

  // TEMPORARY (ELITE investigation): when no presets are found, log every
  // service, characteristic and descriptor with its properties and raw value,
  // so a diagnostic report shows where the mount keeps its presets and move.
  async _logGatt(peripheral) {
    const services = await this._withTimeout(
      peripheral.discoverAllServicesAndCharacteristics(), BLE_TIMEOUT_MS, 'discoverAll',
    );
    for (const service of services) {
      this.log('GATT service', service.uuid);
      for (const characteristic of service.characteristics || []) {
        if (!peripheral.isConnected) {
          this.log('GATT dump stopped: disconnected');
          return;
        }
        const value = characteristic.properties.includes('read') ? await this._readForLog(characteristic) : '';
        this.log('GATT   ', characteristic.uuid, `[${characteristic.properties.join(',')}]`, value);

        let descriptors = [];
        try {
          descriptors = await this._withTimeout(characteristic.discoverDescriptors(), BLE_TIMEOUT_MS, 'discoverDescriptors');
        } catch (e) {
          this.log('GATT      descriptors failed:', e.message);
        }
        for (const descriptor of descriptors) {
          if (!peripheral.isConnected) {
            this.log('GATT dump stopped: disconnected');
            return;
          }
          this.log('GATT      descriptor', descriptor.uuid, await this._readForLog(descriptor));
        }
      }
    }
  }

  // TEMPORARY: reads a characteristic or descriptor for the GATT dump. Returns
  // hex, plus the text when every byte is printable (descriptors may hold a label).
  async _readForLog(attribute) {
    try {
      const buf = await this._withTimeout(attribute.read(), BLE_TIMEOUT_MS, 'read');
      if (!buf || buf.length === 0) {
        return '(empty)';
      }
      const text = buf.toString('latin1');
      return /^[\x20-\x7e]+$/.test(text) ? `${buf.toString('hex')} "${text}"` : buf.toString('hex');
    } catch (e) {
      return `read failed: ${e.message}`;
    }
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
