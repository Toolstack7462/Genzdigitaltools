// Safe localStorage wrapper with error handling and versioning

const STORAGE_VERSION = 1;
const VERSION_KEY = 'toolstack_storage_version';

export const STORAGE_KEYS = {
  SESSION: 'toolstack_session',
  TOOLS: 'toolstack_tools',
  CLIENTS: 'toolstack_clients',
  ASSIGNMENTS: 'toolstack_assignments',
  ACTIVITY: 'toolstack_activity',
  DEVICE: 'toolstack_device',
  SETTINGS: 'toolstack_settings'
};

// Initialize storage version
const initStorage = () => {
  const version = localStorage.getItem(VERSION_KEY);
  if (!version || parseInt(version) < STORAGE_VERSION) {
    localStorage.setItem(VERSION_KEY, STORAGE_VERSION.toString());
  }
};

initStorage();

export const safeRead = (key, fallback = null) => {
  try {
    const item = localStorage.getItem(key);
    if (!item) return fallback;
    return JSON.parse(item);
  } catch (error) {
    console.error(`Storage read error for ${key}:`, error.message);
    // Auto-repair: set fallback
    if (fallback !== null) {
      safeWrite(key, fallback);
    }
    return fallback;
  }
};

export const safeWrite = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`Storage write error for ${key}:`, error.message);
    return false;
  }
};

export const safeRemove = (key) => {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (error) {
    console.error(`Storage remove error for ${key}:`, error.message);
    return false;
  }
};

export const clearAllData = () => {
  Object.values(STORAGE_KEYS).forEach(key => {
    if (key !== STORAGE_KEYS.DEVICE) { // Keep device ID
      safeRemove(key);
    }
  });
};

// Get or create device ID
export const getDeviceId = () => {
  let device = safeRead(STORAGE_KEYS.DEVICE);
  
  if (!device || !device.deviceId) {
    device = {
      deviceId: crypto.randomUUID ? crypto.randomUUID() : `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      createdAt: new Date().toISOString()
    };
    safeWrite(STORAGE_KEYS.DEVICE, device);
  }
  
  return device.deviceId;
};
