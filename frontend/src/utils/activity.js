// Activity logging utility
import { safeRead, safeWrite, STORAGE_KEYS } from './storage';

export const logActivity = (action, meta = {}) => {
  const activities = safeRead(STORAGE_KEYS.ACTIVITY, []);
  const session = safeRead(STORAGE_KEYS.SESSION);
  
  const activity = {
    id: crypto.randomUUID ? crypto.randomUUID() : `activity_${Date.now()}`,
    at: new Date().toISOString(),
    actor: session?.role || 'SYSTEM',
    actorId: session?.clientId || session?.email || 'unknown',
    action,
    meta
  };
  
  activities.unshift(activity);
  
  // Keep last 1000 activities
  if (activities.length > 1000) {
    activities.length = 1000;
  }
  
  safeWrite(STORAGE_KEYS.ACTIVITY, activities);
  return activity;
};

export const getRecentActivity = (limit = 10) => {
  const activities = safeRead(STORAGE_KEYS.ACTIVITY, []);
  return activities.slice(0, limit);
};

export const getAllActivity = () => {
  return safeRead(STORAGE_KEYS.ACTIVITY, []);
};
