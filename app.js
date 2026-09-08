'use strict';

const Homey = require('homey');

class MotionMountApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('MotionMountApp has been initialized');
  }

}

module.exports = MotionMountApp;
