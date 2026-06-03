// Tool assignment service
import { safeRead, safeWrite, STORAGE_KEYS } from '../utils/storage';
import { logActivity } from '../utils/activity';

export const getClientAssignment = (clientId) => {
  const assignments = safeRead(STORAGE_KEYS.ASSIGNMENTS, []);
  const assignment = assignments.find(a => a.clientId === clientId);
  return assignment || { clientId, toolIds: [] };
};

export const assignTools = (clientId, toolIds) => {
  const assignments = safeRead(STORAGE_KEYS.ASSIGNMENTS, []);
  const index = assignments.findIndex(a => a.clientId === clientId);
  
  if (index === -1) {
    assignments.push({ clientId, toolIds });
  } else {
    assignments[index].toolIds = toolIds;
  }
  
  safeWrite(STORAGE_KEYS.ASSIGNMENTS, assignments);
  
  logActivity('tools_assigned', { clientId, toolCount: toolIds.length });
  
  return assignments;
};

export const unassignTool = (clientId, toolId) => {
  const assignment = getClientAssignment(clientId);
  const updatedToolIds = assignment.toolIds.filter(id => id !== toolId);
  return assignTools(clientId, updatedToolIds);
};

export const getToolAssignmentCount = (toolId) => {
  const assignments = safeRead(STORAGE_KEYS.ASSIGNMENTS, []);
  return assignments.filter(a => a.toolIds.includes(toolId)).length;
};

export const getAllAssignments = () => {
  return safeRead(STORAGE_KEYS.ASSIGNMENTS, []);
};
