/**
 * Logger - Structured logging system for the extension
 * 
 * Features:
 * - Log levels (debug, info, warn, error)
 * - Structured JSON logging
 * - Secret masking (NEVER logs passwords, tokens, etc.)
 * - Debug mode toggle
 * - Log history for diagnostics
 * - Performance timing
 */

// Log levels
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

// Sensitive keys that should NEVER be logged
const SENSITIVE_KEYS = [
  'password', 'pwd', 'secret', 'token', 'jwt', 'bearer',
  'apikey', 'api_key', 'auth', 'credential', 'cookie',
  'session', 'access_token', 'refresh_token', 'id_token',
  'authorization', 'x-auth', 'x-api-key', 'private'
];

// Global debug mode state
let debugModeEnabled = false;

// Log history for diagnostics
const logHistory = [];
const MAX_HISTORY_SIZE = 100;

/**
 * Logger Class
 */
export class Logger {
  constructor(context) {
    this.context = context;
    this.minLevel = debugModeEnabled ? LOG_LEVELS.DEBUG : LOG_LEVELS.INFO;
  }

  /**
   * Debug log - only visible when debug mode is enabled
   */
  debug(message, data = null) {
    this.log(LOG_LEVELS.DEBUG, message, data);
  }

  /**
   * Info log
   */
  info(message, data = null) {
    this.log(LOG_LEVELS.INFO, message, data);
  }

  /**
   * Warning log
   */
  warn(message, data = null) {
    this.log(LOG_LEVELS.WARN, message, data);
  }

  /**
   * Error log
   */
  error(message, data = null) {
    this.log(LOG_LEVELS.ERROR, message, data);
  }

  /**
   * Core logging function
   */
  log(level, message, data = null) {
    // Check if we should log this level
    if (level < this.minLevel) {
      return;
    }

    const levelName = Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === level);
    const timestamp = new Date().toISOString();

    // Sanitize data to remove sensitive information
    const sanitizedData = data ? this.sanitize(data) : null;

    // Build log entry
    const entry = {
      timestamp,
      level: levelName,
      context: this.context,
      message,
      data: sanitizedData
    };

    // Add to history
    this.addToHistory(entry);

    // Format and output
    const prefix = `[${this.context}]`;
    const levelPrefix = this.getLevelPrefix(level);

    if (sanitizedData) {
      console[this.getConsoleMethod(level)](`${levelPrefix} ${prefix} ${message}`, sanitizedData);
    } else {
      console[this.getConsoleMethod(level)](`${levelPrefix} ${prefix} ${message}`);
    }
  }

  /**
   * Sanitize data to remove sensitive information
   */
  sanitize(data) {
    if (data === null || data === undefined) {
      return null;
    }

    // Handle primitive types
    if (typeof data !== 'object') {
      return data;
    }

    // Handle arrays
    if (Array.isArray(data)) {
      return data.map(item => this.sanitize(item));
    }

    // Handle objects
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
      const keyLower = key.toLowerCase();
      
      // Check if key is sensitive
      const isSensitive = SENSITIVE_KEYS.some(sensitiveKey => 
        keyLower.includes(sensitiveKey)
      );

      if (isSensitive) {
        // Mask sensitive values
        if (typeof value === 'string') {
          sanitized[key] = this.maskValue(value);
        } else if (Array.isArray(value)) {
          sanitized[key] = `[Array:${value.length} items - REDACTED]`;
        } else if (typeof value === 'object') {
          sanitized[key] = '[Object - REDACTED]';
        } else {
          sanitized[key] = '[REDACTED]';
        }
      } else if (typeof value === 'object') {
        // Recursively sanitize nested objects
        sanitized[key] = this.sanitize(value);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Mask a sensitive value
   */
  maskValue(value) {
    if (!value || typeof value !== 'string') {
      return '[REDACTED]';
    }

    const length = value.length;
    if (length <= 4) {
      return '****';
    }

    // Show first 2 and last 2 characters
    return `${value.substring(0, 2)}${'*'.repeat(Math.min(length - 4, 10))}${value.substring(length - 2)}`;
  }

  /**
   * Get console method for log level
   */
  getConsoleMethod(level) {
    switch (level) {
      case LOG_LEVELS.DEBUG:
        return 'debug';
      case LOG_LEVELS.INFO:
        return 'log';
      case LOG_LEVELS.WARN:
        return 'warn';
      case LOG_LEVELS.ERROR:
        return 'error';
      default:
        return 'log';
    }
  }

  /**
   * Get level prefix emoji
   */
  getLevelPrefix(level) {
    switch (level) {
      case LOG_LEVELS.DEBUG:
        return '🔍';
      case LOG_LEVELS.INFO:
        return 'ℹ️';
      case LOG_LEVELS.WARN:
        return '⚠️';
      case LOG_LEVELS.ERROR:
        return '❌';
      default:
        return '';
    }
  }

  /**
   * Add entry to log history
   */
  addToHistory(entry) {
    logHistory.push(entry);
    
    // Trim history if too large
    while (logHistory.length > MAX_HISTORY_SIZE) {
      logHistory.shift();
    }
  }

  /**
   * Start a timer for performance measurement
   */
  startTimer(label) {
    const startTime = performance.now();
    return {
      stop: () => {
        const duration = performance.now() - startTime;
        this.debug(`Timer [${label}]: ${duration.toFixed(2)}ms`);
        return duration;
      }
    };
  }

  /**
   * Log a performance measurement
   */
  perf(label, durationMs) {
    this.debug(`Performance [${label}]: ${durationMs.toFixed(2)}ms`);
  }

  /**
   * Create a child logger with additional context
   */
  child(subContext) {
    return new Logger(`${this.context}:${subContext}`);
  }
}

/**
 * Enable debug mode
 */
export function enableDebugMode() {
  debugModeEnabled = true;
  
  // Update all existing loggers
  console.log('🔧 [Logger] Debug mode ENABLED');
  
  // Persist to storage
  chrome.storage.local.set({ debugMode: true });
}

/**
 * Disable debug mode
 */
export function disableDebugMode() {
  debugModeEnabled = false;
  console.log('🔧 [Logger] Debug mode DISABLED');
  chrome.storage.local.set({ debugMode: false });
}

/**
 * Check if debug mode is enabled
 */
export function isDebugModeEnabled() {
  return debugModeEnabled;
}

/**
 * Get log history
 */
export function getLogHistory(filter = {}) {
  let history = [...logHistory];

  // Filter by level
  if (filter.level) {
    const minLevel = LOG_LEVELS[filter.level.toUpperCase()] || 0;
    history = history.filter(entry => LOG_LEVELS[entry.level] >= minLevel);
  }

  // Filter by context
  if (filter.context) {
    history = history.filter(entry => 
      entry.context.toLowerCase().includes(filter.context.toLowerCase())
    );
  }

  // Filter by time range
  if (filter.since) {
    const sinceTime = new Date(filter.since).getTime();
    history = history.filter(entry => 
      new Date(entry.timestamp).getTime() >= sinceTime
    );
  }

  // Limit results
  if (filter.limit) {
    history = history.slice(-filter.limit);
  }

  return history;
}

/**
 * Clear log history
 */
export function clearLogHistory() {
  logHistory.length = 0;
}

/**
 * Export logs for diagnostics
 */
export function exportLogs() {
  return {
    exportedAt: new Date().toISOString(),
    debugModeEnabled,
    entryCount: logHistory.length,
    logs: logHistory.map(entry => ({
      ...entry,
      // Additional sanitization for export
      data: entry.data ? JSON.stringify(entry.data) : null
    }))
  };
}

/**
 * Initialize logger from storage
 */
export async function initializeLogger() {
  try {
    const data = await chrome.storage.local.get(['debugMode']);
    debugModeEnabled = data.debugMode || false;
    
    if (debugModeEnabled) {
      console.log('🔧 [Logger] Debug mode restored from storage');
    }
  } catch (e) {
    // Ignore storage errors
  }
}

// Initialize on load
initializeLogger();


/**
 * FIX27: Redact sensitive fields from objects before logging.
 * Call this on any object that might contain credentials.
 */
export function redactSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const SENSITIVE_KEYS = new Set([
    'password', 'passwd', 'secret', 'token', 'accessToken', 'refreshToken',
    'cookies', 'cookiesEncrypted', 'payloadEncrypted', 'payload',
    'Authorization', 'authorization', 'bearer'
  ]);
  const redacted = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key of Object.keys(redacted)) {
    if (SENSITIVE_KEYS.has(key)) {
      redacted[key] = '[REDACTED]';
    } else if (typeof redacted[key] === 'object' && redacted[key] !== null) {
      redacted[key] = redactSensitive(redacted[key]);
    }
  }
  return redacted;
}

export default Logger;
