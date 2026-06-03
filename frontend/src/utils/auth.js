// frontend/src/utils/auth.js
// NOTE: All authentication is handled by authService.js via the backend API.
// This file retains only safe, non-sensitive session-shape helpers.
// The ADMIN_CREDENTIALS object that previously existed here has been removed
// because it embedded "admin123" in the production JS bundle.

import { safeRead, safeWrite, safeRemove, STORAGE_KEYS } from './storage';

export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  SUPPORT: 'SUPPORT',
  CLIENT: 'CLIENT'
};

export const ADMIN_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPPORT];

export const getSession = () => safeRead(STORAGE_KEYS.SESSION, null);
export const setSession = (data) => safeWrite(STORAGE_KEYS.SESSION, { ...data, createdAt: new Date().toISOString() });
export const clearSession = () => safeRemove(STORAGE_KEYS.SESSION);
export const isAuthenticated = () => getSession() !== null;
export const isAdmin = () => { const s = getSession(); return s && ADMIN_ROLES.includes(s.role); };
export const isClient = () => { const s = getSession(); return s && s.role === ROLES.CLIENT; };
export const getCurrentUser = () => getSession();
