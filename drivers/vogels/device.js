'use strict';

const { Device } = require('homey');
// const { moveCursor } = require('readline');
// const { runInThisContext } = require('vm');

class MotionMountDevice extends Device {

  async onInit() {
    this.advertisement = undefined;
    this.peripheral = undefined;
    this._busy = false;
    this.setUnavailable("Awaiting initial connect")

    try {
      await this.connect()
      await this.getPosition();
      this.setAvailable()
      this.initialize()
      this.log('MotionMountDevice has been initialized');
    } catch (error) {
      this.error("Error in initial connect: " + error)
      this.setUnavailable("Initial connection to device failed: " + error)

      setTimeout( () => {
        this.reconnect()
      }, 30000)
    }
  }

  async initialize() {
    // this.gotoAction = this.homey.flow.getActionCard('goto_position');
    // this.gotoAction.registerRunListener(async (args, state) => {
    //   this.log('Device: Now I should go somewhere');
    //   if (!this.advertisement) {
    //     this.log("Device: advertisment not set. Unexpected!");
    //   } else {
    //     if (args.hasOwnProperty("position")) {
    //       this.log("Need to go to position " + args.position + ". Connecting....");
          
    //       if (args.position == "home") {
    //         this.extendPosition = Buffer.from([0x00, 0x16])
    //         this.turnPosition = Buffer.from([0x00, 0x00])
    //       } else if (args.position == "main") {
    //         this.extendPosition = Buffer.from([0x00, 0x64])
    //         this.turnPosition = Buffer.from([0xff, 0x9d])
    //       }

    //       await this.setPosition()
    //     } else {
    //       this.log("No position in argument, cannot move");
    //     }
    //   }
    // });

    this.registerCapabilityListener("set_extend", async (value) => {
      if (value >= 0 && value <= 100) {
        this.extendPosition = Buffer.from([0x00, value])
        this.setPosition()  
      } else {
        this.log("Invalid extend position " + value + ". Must be between 0 and 100")
      }
    });

    this.registerCapabilityListener("set_turn", async (value) => {
      if ((value >= -100 && value <= 100)) {
        if (value < 0) {
          this.turnPosition = Buffer.from([0xff, 255  + value])
        } else {
          this.turnPosition = Buffer.from([0x00, value])
        }
        this.setPosition()
      } else {
        this.log("Invalid turn position " + value + ". Must be between -100 and 100")
      }

    });

    this._timerId = null;
    this._pollingInterval = this.getSettings().polling_interval * 60000;

    if (this.getSettings().polling === true) {
      this.log("Polling enabled, initial position check")
      this.refresh()
    } else {
      this.log("Device initialize phase two complete, polling disabled")
    }
  }

  async reconnect() {
    // This is used if initial connection fails as a retry mechanism
    try {
      await this.connect()
      this.setAvailable()
      this.initialize()
    } catch (error) {
      this.error("Error on reconnect: " + error)
      this.setUnavailable("Reconnect to device failed: " + error)

      setTimeout( () => {
        this.reconnect()
      }, 30000)
      return
    }
  }
  	// connect to the peripheral, and return the service
	async connect() {
    if (!this.advertisement) {
      try {
        this.advertisement = await this.homey.ble.find(this.getStore().peripheralUuid)
        this.log("Peripheral found")
      } catch (error) {
        this.log("BLE find error : " + error)
        return
      }        
    } 

  	if (!this.peripheral) {
      try {
				this.log('Initial connect');
				this.peripheral = await this.advertisement.connect();
        if (this.peripheral.isConnected) {
          this.service = await this.peripheral.getService('3e6fe65ded7811e4895e00026fd5c52c')
          const characteristics = await this.service.discoverCharacteristics()
          characteristics.forEach(characteristic => {
            if (characteristic.uuid == 'c005fa0006514800b000000000000000') {
              this.extendPositionCharacteristic = characteristic
            } else if (characteristic.uuid == 'c005fa0106514800b000000000000000') {
              this.turnPositionCharacteristic = characteristic
            } else if (characteristic.uuid == 'c005fa2106514800b000000000000000') {
              this.moveCharacteristic = characteristic
            }
          })
  
          this.peripheral.on('disconnect', () => {
            this.log(`disconnected: ${this.getName()}`);
          })
  
          // await this.disconnect()
        } else {
          this.log("Could not make initial connection")
        }
      } catch (error) {
        this.error('error connecting: ' + error);
      }
    } else {
      this.log("Peripheral known, isConnected: " + this.peripheral.isConnected)
      this.log("State: " + this.peripheral.state)

      if (!this.peripheral.isConnected) {
        this.log("Peripheral already known, connecting...")
        try {
          this.peripheral = await this.advertisement.connect()
        } catch (error) {
          this.error('error connecting: ' + error);
        }
      } else {
        this.log("Already connected")
      }
    }
	}

  async disconnect() {
    if (this.peripheral) {
      // if (this.peripheral.isConnected) {
        try {
          await this.peripheral.disconnect()
        } catch (error) {
          this.log("Error disconnecting: " + error)
        }
      // } else {
        // this.log("Not disconnecting, not connected")
      // }
    } else {
      this.log("Not disconnecting, no peripheral to disconnect")
    }
  }

async setPosition() {
  this.log("setPosition entry")
  // if (this._busy) {
  //   this.log("setPosition: Device busy, skipping");
  //   return;
  // }
  // this._busy = true;

  try {
    const newPosition = Buffer.from([
      this.extendPosition[0],
      this.extendPosition[1],
      this.turnPosition[0],
      this.turnPosition[1]
    ]);
    this.log(newPosition);

    this.log("setPosition: Connecting...");
    await this.connect();
    this.log("setPosition: Writing new position");

    if (!this.moveCharacteristic) {
      this.log("moveCharacteristic not set, cannot write position");
      // this._busy = false;
      return;
    }

    await this.moveCharacteristic.write(newPosition).catch(this.error);

    // this.log("setPosition: Disco");
    // // Wait a bit before disconnecting, to prevent polling mechanism to interfere with the current operation
    // setTimeout(() => {
    //   this.disconnect().then(() => {
    //     this._busy = false;
    //   }).catch(err => {
    //     this.log("Error disconnecting after setPosition:", err);
    //     this._busy = false;
    //   });
    // }, 5000);


    this.log("setPosition: Disco");
    // Wait a bit before disconnecting, to prevent polling mechanism to interfere with the current operation
    setTimeout(() => {
      this.disconnect().catch(err => {
        this.log("Error disconnecting after setPosition:", err);
      });
    }, 5000);

  } catch (error) {
    this.log("Error in setPosition:", error);
    this._busy = false;
  }
}

  async getPosition() {
    // if (this.peripheral.isConnected) {
    //   this.log("Not getting position, possible BLE action running already")
    //   return
    // }

    if (this._busy) {
      this.log("getPosition: Device busy, skipping position read");
      return;
    }

    this._busy = true;

    this.log("getPosition: Connecting...")
    await this.connect()

    if (this.peripheral.isConnected) {
      this.log("Connected")

      try {
        if (this.extendPositionCharacteristic != null) {
          const currentExtendPosition = await this.extendPositionCharacteristic.read()
          .catch(this.error)
          // const currentExtendPosition = await this.peripheral.read('3e6fe65ded7811e4895e00026fd5c52c', 'c005fa0006514800b000000000000000')
          this.log("Extend position: ")
          this.log(currentExtendPosition)
          this.extendPosition = currentExtendPosition

          var hexString = currentExtendPosition.toString('hex')
          this.log(parseInt(hexString, 16))
          this.setCapabilityValue("current_extend", hexString)
            .catch(this.error);
          this.setCapabilityValue("set_extend", parseInt(hexString, 16))
            .catch(this.error)
        } else {
          this.log("Cannot get current position, extendPositionCharacteristic is null")
        }
    
        // const currentTurnPosition = await this.peripheral.read('3e6fe65ded7811e4895e00026fd5c52c', 'c005fa0106514800b000000000000000')
        if (this.turnPositionCharacteristic != null) {
          const currentTurnPosition = await this.turnPositionCharacteristic.read()
          .catch(this.error)

          this.log("Turn position: ")
          this.log(currentTurnPosition)
          this.turnPosition = currentTurnPosition
          hexString = currentTurnPosition.toString('hex')
          var turnInt = parseInt(hexString, 16)        
          this.log(turnInt)
          this.setCapabilityValue("current_turn", hexString)
            .catch(this.error);
          if (turnInt > 100) {
            turnInt = (65535 - turnInt) * -1
            this.log("Turn adjusted to " + turnInt + " for slider control")
          }
          this.setCapabilityValue("set_turn", turnInt)
            .catch(this.error)
        }
      
        this.log("Disconnecting...")
        await this.disconnect()
        this._busy = false;
      } catch(error) {
        this.log("Error caught")
        this.log(error)
        this._busy = false;
        return
      }
    } else {
      this.log("Cannot read postition, connection failed")
      this._busy = false;
    }

    

    // if (this.extendPositionCharacteristic != null) {
    //   const currentExtendPosition = await this.extendPositionCharacteristic.read()
    //   .catch(this.error)
    //   this.log("Extend position: ")
    //   this.log(currentExtendPosition)
    //   const hexString = currentExtendPosition.toString('hex')
    //   this.log(parseInt(hexString, 16))
    //   this.extendPosition = parseInt(hexString, 16)
    //   this.setCapabilityValue("current_extend", hexString)
    //     .catch(this.error);
    //   this.setCapabilityValue("set_extend", parseInt(hexString, 16))
    //     .catch(this.error)

    // }

    // if (this.turnPositionCharacteristic != null) {
    //   const currentTurnPosition = await this.turnPositionCharacteristic.read()
    //     .catch(this.error)
    //   this.log("Turn position: ")
    //   this.log(currentTurnPosition)
    //   this.setCapabilityValue("current_turn", currentTurnPosition.toString('hex'))
    //     .catch(this.error);
    // }


  }

  async refresh() {
    await this.getPosition()

    this._timerId = setTimeout( () => {
        this.refresh();
    }, this._pollingInterval );
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

  async onSettings({ oldSettings, newSettings, changedKeys }) {

    if (changedKeys.includes('polling_interval')) {
      if ( this._timerId ) {
        clearTimeout( this._timerId );
        this._timerId = null;
      }
      this._pollingInterval = newSettings.polling_interval * 60000;
      this.log("Polling interval changed to " + this._pollingInterval)
      if (this.getSettings().polling === true) {
        this.refresh();
      }
    }

    if (changedKeys.includes('polling') && newSettings.polling === false) {
      if (this._timerId) {
        clearTimeout(this._timerId);
        this._timerId = null;
      }
      this.log("Polling disabled");
    }

    if (changedKeys.includes('polling') && newSettings.polling === true) {
      if (this._timerId) {
        clearTimeout(this._timerId);
        this._timerId = null;
      }
      this.log("Polling enabled");
      this.refresh();
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
    this.log('MotionMountDevice was renamed to ' + name);
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    if ( this._timerId ) {
      clearTimeout( this._timerId );
      this._timerId = null;
    }
    this.log('MotionMountDevice has been deleted');
  }


}

module.exports = MotionMountDevice;