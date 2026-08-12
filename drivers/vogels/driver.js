'use strict';

const { Driver } = require('homey');

// Known MotionMount BLE service UUIDs (lowercase, no dashes). Pairing lists any
// device advertising one of these, which is model- and rename-proof — unlike the
// old exact-localName match. Add other models (e.g. the 7356) here once their
// advertised service UUID is confirmed.
const KNOWN_SERVICE_UUIDS = [
  '3e6fe65ded7811e4895e00026fd5c52c', // MotionMount 7355
];

// Normalize a BLE UUID for comparison (strip dashes, lowercase).
const normalizeUuid = uuid => String(uuid).replace(/-/g, '').toLowerCase();

class MotionMountDriver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MotionMountDriver has been initialized');

    const gotoAction = this.homey.flow.getActionCard('goto_position');

    gotoAction.registerRunListener(async (args, state) => {
      const { device } = args;
      const { extend } = args;
      const { turn } = args;

      if (!device || typeof device.onGotoPosition !== 'function') {
        this.log('goto_position: device missing or onGotoPosition not implemented');
        return false;
      }

      await device.onGotoPosition({ extend, turn });
      return true;
    });

    const gotoPresetAction = this.homey.flow.getActionCard('goto_preset');

    // Autocomplete for preset names to be selected in flow
    gotoPresetAction.registerArgumentAutocompleteListener('preset', async (query, args) => {
      const { device } = args;
      if (!device || !device.presets || !Array.isArray(device.presets)) {
        this.log('goto_preset autocomplete: device has no presets');
        return [];
      }

      const search = (query || '').toLowerCase();

      return device.presets
        .filter(preset => !search
          || (preset.name && preset.name.toLowerCase().includes(search)))
        .map((preset, index) => ({
          id: String(index), // index in device.presets
          name: preset.name || `Preset ${index}`,
        }));
    });

    gotoPresetAction.registerRunListener(async (args, state) => {
      const { device } = args;
      const presetArg = args.preset;

      if (!device || typeof device.onGotoPreset !== 'function') {
        this.log('goto_preset: device missing or onGotoPreset not implemented');
        return false;
      }

      // presetArg is { id, name }
      const index = Number(presetArg && presetArg.id);
      if (Number.isNaN(index)) {
        this.log('goto_preset: invalid preset index from arg', presetArg);
        return false;
      }

      await device.onGotoPreset(index);
      return true;
    });
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    const advertisements = await this.homey.ble.discover();

    const known = KNOWN_SERVICE_UUIDS.map(normalizeUuid);

    const devices = advertisements
      .filter(advertisement => Array.isArray(advertisement.serviceUuids)
        && advertisement.serviceUuids.some(uuid => known.includes(normalizeUuid(uuid))))
      .map(advertisement => ({
        // The advertisement may carry no localName (renamed, or not broadcast),
        // so fall back to a generic name; detection is by service UUID.
        name: advertisement.localName || 'MotionMount',
        data: {
          id: advertisement.uuid,
        },
        store: {
          peripheralUuid: advertisement.uuid,
        },
      }));

    this.log(`Pairing scan: ${advertisements.length} BLE device(s) seen, ${devices.length} MotionMount(s) matched`);
    return devices;
  }

}

module.exports = MotionMountDriver;
