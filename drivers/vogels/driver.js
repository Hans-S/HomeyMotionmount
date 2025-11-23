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