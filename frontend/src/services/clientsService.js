// Clients CRUD service
import { safeRead, safeWrite, STORAGE_KEYS, getDeviceId } from '../utils/storage';
import { logActivity } from '../utils/activity';

export const getAllClients = () => {
  return safeRead(STORAGE_KEYS.CLIENTS, []);
};

export const getClientById = (id) => {
  const clients = getAllClients();
  return clients.find(client => client.id === id);
};

export const getClientByEmail = (email) => {
  const clients = getAllClients();
  return clients.find(client => client.email === email);
};

export const createClient = (clientData) => {
  const clients = getAllClients();
  
  // Check duplicate email
  if (clients.some(c => c.email === clientData.email)) {
    return { success: false, error: 'Email already exists' };
  }
  
  const newClient = {
    id: crypto.randomUUID ? crypto.randomUUID() : `client_${Date.now()}`,
    ...clientData,
    status: clientData.status || 'active',
    deviceBindingEnabled: clientData.deviceBindingEnabled !== false,
    boundDeviceId: null,
    createdAt: new Date().toISOString()
  };
  
  clients.push(newClient);
  safeWrite(STORAGE_KEYS.CLIENTS, clients);
  
  logActivity('client_created', { clientId: newClient.id, clientEmail: newClient.email });
  
  return { success: true, client: newClient };
};

export const updateClient = (id, updates) => {
  const clients = getAllClients();
  const index = clients.findIndex(client => client.id === id);
  
  if (index === -1) return null;
  
  clients[index] = {
    ...clients[index],
    ...updates,
    id: clients[index].id,
    createdAt: clients[index].createdAt
  };
  
  safeWrite(STORAGE_KEYS.CLIENTS, clients);
  
  logActivity('client_updated', { clientId: id, clientEmail: clients[index].email });
  
  return clients[index];
};

export const deleteClient = (id) => {
  const clients = getAllClients();
  const client = clients.find(c => c.id === id);
  
  if (!client) return false;
  
  const filtered = clients.filter(client => client.id !== id);
  safeWrite(STORAGE_KEYS.CLIENTS, filtered);
  
  // Also remove assignments
  const assignments = safeRead(STORAGE_KEYS.ASSIGNMENTS, []);
  const updatedAssignments = assignments.filter(a => a.clientId !== id);
  safeWrite(STORAGE_KEYS.ASSIGNMENTS, updatedAssignments);
  
  logActivity('client_deleted', { clientId: id, clientEmail: client.email });
  
  return true;
};

export const resetDeviceBinding = (clientId) => {
  const client = updateClient(clientId, { boundDeviceId: null });
  
  if (client) {
    logActivity('device_reset', { clientId, clientEmail: client.email });
  }
  
  return client;
};

export const clientLogin = (email, password) => {
  const client = getClientByEmail(email);
  
  if (!client) {
    return { success: false, error: 'Invalid email or password' };
  }
  
  if (client.password !== password) {
    return { success: false, error: 'Invalid email or password' };
  }
  
  if (client.status === 'disabled') {
    logActivity('login_blocked_disabled', { clientId: client.id, clientEmail: email });
    return { success: false, error: 'Your account has been disabled. Please contact support.' };
  }
  
  // Device binding check
  if (client.deviceBindingEnabled) {
    const currentDeviceId = getDeviceId();
    
    if (!client.boundDeviceId) {
      // First login - bind device
      updateClient(client.id, { boundDeviceId: currentDeviceId });
    } else if (client.boundDeviceId !== currentDeviceId) {
      // Device mismatch
      logActivity('login_blocked_device', { clientId: client.id, clientEmail: email, attemptedDevice: currentDeviceId });
      return { 
        success: false, 
        error: 'This account is locked to another device. Please contact admin to reset device access.' 
      };
    }
  }
  
  logActivity('client_login', { clientId: client.id, clientEmail: email });
  
  return { 
    success: true, 
    client: { ...client, password: undefined } // Don't include password in session
  };
};
