'use strict';

const { Driver } = require('homey');

class MotionMountDriver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MyDriver has been initialized');
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