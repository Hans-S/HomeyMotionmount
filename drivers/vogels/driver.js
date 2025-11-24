'use strict';

const { Driver } = require('homey');

class MotionMountDriver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MotionMountDriver has been initialized');

    const gotoAction = this.homey.flow.getActionCard('goto_position');

    gotoAction.registerRunListener(async (args, state) => {
      const device = args.device;
      const extend = args.extend;
      const turn   = args.turn;

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
    const device = args.device;
    if (!device || !device.presets || !Array.isArray(device.presets)) {
      this.log('goto_preset autocomplete: device has no presets');
      return [];
    }

    const search = (query || '').toLowerCase();

    return device.presets
      .filter(preset =>
        !search ||
        (preset.name && preset.name.toLowerCase().includes(search))
      )
      .map((preset, index) => ({
        id: String(index),     // index in device.presets
        name: preset.name || `Preset ${index}`
      }));
  });

  gotoPresetAction.registerRunListener(async (args, state) => {
    const device = args.device;
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
    // const advertisement = await this.homey.ble.find('Vogel's MotionMount');
    
    const advertisements = await this.homey.ble.discover();

    return advertisements
      .filter(advertisement => advertisement.localName === "Vogel's MotionMount")
      .map(advertisement => {
        return {
          name: advertisement.localName,
          data: {
            id: advertisement.uuid,
          },
          store: {
            peripheralUuid: advertisement.uuid,
          }
        };
      });
  }

}

module.exports = MotionMountDriver;