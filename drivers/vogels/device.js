'use strict';

const { Device } = require('homey');
// const { moveCursor } = require('readline');
// const { runInThisContext } = require('vm');

class MotionMountDevice extends Device {

  async onInit() {
    this.advertisement = undefined;
    this.peripheral = undefined;
    this._busy = false;
    this.presetCharacteristics = [];
    this.presets = [];

    // Listen to UI preset changes
    if (this.hasCapability('preset')) {
      this.registerCapabilityListener('preset', async (value) => {
        return this.onCapabilityPreset(value);
      });
    } else {
      this.error("No preset capability present, this should not happen")
    }

    this.setUnavailable("Awaiting initial connect")

    try {
      await this.connect()
      await this.getPosition();
      await this.loadPresets();
      await this.updatePresetCapabilityOptions();
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
            
            // Store preset characteristics
            if (characteristic.uuid.startsWith('c005fa')) {
              const hexByte = characteristic.uuid.substring(6, 8);
              const byteVal = parseInt(hexByte, 16);

              if (byteVal >= 0x0a && byteVal <= 0x13) {
                // Candidate preset slot, store the characteristic here
                this.presetCharacteristics.push(characteristic);
                this.log('Found possible preset characteristic:', characteristic.uuid);
              }
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

  async loadPresets() {
    this.log('Loading presets from MotionMount…');

    await this.connect();

    const presets = [];

    for (const characteristic of this.presetCharacteristics) {
      const uuid = characteristic.uuid;

      if (!this.peripheral || !this.peripheral.isConnected) {
        this.log('loadPresets: peripheral not connected, reconnecting...');
        await this.connect();
      }

      let buf;

      try {
        buf = await characteristic.read();
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
        uuid
      });
    }

    this.presets = presets;
    this.log('Presets loaded:', this.presets.map(p => p.name).join(', '));
  }

async updatePresetCapabilityOptions() {
  if (!this.hasCapability('preset')) {
    this.log("updatePresetCapabilityOptions: No preset capability!");
    return;
  }

  const values = this.presets.map((preset, index) => ({
    id: String(index),
    title: {
      en: preset.name,
      nl: preset.name,
    },
  }));

  if (values.length === 0) {
    await this.setCapabilityOptions('preset', {
      values: [
        {
          id: '0',
          title: { en: 'None', nl: 'Geen' }
        }
      ]
    });
    return;
  }

  await this.setCapabilityOptions('preset', { values });

  // Set UI picker to active preset
  let lastIndex;

  try {
    lastIndex = await this.getStoreValue('lastPresetIndex');
  } catch (e) {
    lastIndex = null;
  }

  if (lastIndex == null || lastIndex < 0 || lastIndex >= values.length) {
    lastIndex = 0;
  }

  try {
    await this.setCapabilityValue('preset', String(lastIndex));
  } catch (e) {
    this.error('Error setting preset capability value', e);
  }
}

async onCapabilityPreset(value) {
  const index = Number(value);
  this.log('Preset capability changed to index', index);

  if (Number.isNaN(index) || index < 0 || index >= this.presets.length) {
    this.log('Invalid preset index', value);
    return;
  }

  await this.gotoPreset(index);

  try {
    await this.setStoreValue('lastPresetIndex', index);
  } catch (e) {
    this.error('Error storing lastPresetIndex', e);
  }
}

async gotoPreset(index) {
  const preset = this.presets[index];
  if (!preset) {
    this.log('Preset not found for index', index);
    return;
  }

  this.log('Going to preset', index, preset.name);

  await this.connect();

  if (!this.moveCharacteristic) {
    this.log('moveCharacteristic not set');
    return;
  }

  try {
    // moveBuffer = 4 bytes [extendMSB, extendLSB, turnMSB, turnLSB]
    await this.moveCharacteristic.write(preset.moveBuffer);
  } catch (err) {
    this.log('Error writing preset move buffer', err);
    throw err;
  }

  // optioneel: na een paar seconden loslaten
  setTimeout(() => {
    this.disconnect().catch(e => this.log('Disconnect after preset move failed', e));
  }, 5000);
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

  async onGotoPreset(presetIndex) {
    const index = Number(presetIndex);
    this.log('Flow: goto_preset', index);

    if (Number.isNaN(index) || index < 0 || index >= this.presets.length) {
      this.log('Invalid preset index in flow', presetIndex);
      return;
    }

    await this.gotoPreset(index);

    // optioneel: laatste preset opslaan
    try {
      await this.setStoreValue('lastPresetIndex', index);
    } catch (e) {
      this.error('Error storing lastPresetIndex from flow', e);
    }
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