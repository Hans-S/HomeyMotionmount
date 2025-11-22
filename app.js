// Todo:
//  Fix: [log] 2022-04-21 08:46:35 [ManagerFlow] [FlowCardAction][goto_position] Warning: Run listener was already registered.
//        Happens when you delete and then re-add the device


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