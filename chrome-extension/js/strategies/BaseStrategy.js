/**
 * Base Strategy Class
 * All login strategies extend this class
 */
export class BaseStrategy {
  constructor(name) {
    this.name = name;
    this.timeout = 15000;
  }
  
  /**
   * Check if this strategy can be used for the given config
   * @param {Object} config - Tool configuration
   * @returns {boolean}
   */
  canHandle(config) {
    throw new Error('canHandle must be implemented by subclass');
  }
  
  /**
   * Execute the login strategy
   * @param {Object} config - Tool configuration
   * @param {Object} context - Execution context (tabId, url, etc.)
   * @returns {Promise<Object>} Result with success status
   */
  async execute(config, context) {
    throw new Error('execute must be implemented by subclass');
  }
  
  /**
   * Verify if login was successful
   * @param {Object} config - Tool configuration
   * @param {Object} context - Execution context
   * @returns {Promise<boolean>}
   */
  async verify(config, context) {
    return true; // Override in subclass for specific verification
  }
  
  /**
   * Clean up after strategy execution
   * @param {Object} config - Tool configuration
   * @param {Object} context - Execution context
   */
  async cleanup(config, context) {
    // Override in subclass if cleanup is needed
  }
  
  /**
   * Log strategy action
   */
  log(message, data = null) {
    const logMsg = `[${this.name}Strategy] ${message}`;
    if (data) {
      console.log(logMsg, data);
    } else {
      console.log(logMsg);
    }
  }
  
  /**
   * Log error
   */
  logError(message, error = null) {
    const logMsg = `[${this.name}Strategy] ERROR: ${message}`;
    if (error) {
      console.error(logMsg, error);
    } else {
      console.error(logMsg);
    }
  }
}

export default BaseStrategy;
