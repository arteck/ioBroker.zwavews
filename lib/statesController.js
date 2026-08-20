/**
 * Controls reading and writing of ioBroker states for the ZWave adapter.
 */
class StatesController {
  /**
   * Creates a new StatesController instance.
   *
   * @param {object} adapter - The ioBroker adapter instance.
   */
  constructor(adapter) {
    this.adapter = adapter;
  }

  /**
   * Sets a state value unconditionally, skipping null/undefined values.
   *
   * @param {string} stateName - The ioBroker state ID to set.
   * @param {*} value - The value to write to the state.
   */
  async setStateSafelyAsync(stateName, value) {
    if (value === undefined || value === null) {
      return;
    }
    this.adapter.setState(stateName, value, true);
  }

  /**
   * Sets a state value only if it has changed, skipping null/undefined values.
   *
   * @param {string} stateName - The ioBroker state ID to set.
   * @param {*} value - The value to write to the state.
   */
  async setStateChangedSafelyAsync(stateName, value) {
    if (value === undefined || value === null) {
      return;
    }
    await this.adapter.setStateChangedAsync(stateName, value, true);
  }

  /**
   * Sets all node ready-states to false, all status-states to "unknown"
   * and the gateway status to "offline".
   */
  async setAllAvailableToFalse() {
    const readyStates = await this.adapter.getStatesAsync("*.ready");
    for (const readyState in readyStates) {
      await this.adapter.setStateChangedAsync(readyState, false, true);
    }
    const availableStates = await this.adapter.getStatesAsync("*.status");
    for (const availableState in availableStates) {
      await this.adapter.setStateChangedAsync(availableState, "unknown", true);
    }
    await this.adapter.setStateChangedAsync('info.zwave_gateway_status', 'offline', true);

  }

  /**
   * Deletes a state by its ID (removes object and state value).
   *
   * @param {string} stateName - The full ioBroker state ID to delete.
   */
  async deleteState(stateName) {
    try {
      await this.adapter.delObjectAsync(stateName);
    } catch (e) {
      // State möglicherweise bereits gelöscht
      this.adapter.log.debug(`deleteState: ${stateName} already removed or not found: ${e.message}`);
    }
  }

}

module.exports = {
  StatesController,
};
