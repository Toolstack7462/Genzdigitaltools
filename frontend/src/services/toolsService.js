// Tools CRUD service
import { safeRead, safeWrite, STORAGE_KEYS } from '../utils/storage';
import { logActivity } from '../utils/activity';

export const getAllTools = () => {
  return safeRead(STORAGE_KEYS.TOOLS, []);
};

export const getToolById = (id) => {
  const tools = getAllTools();
  return tools.find(tool => tool.id === id);
};

export const createTool = (toolData) => {
  const tools = getAllTools();
  
  const newTool = {
    id: crypto.randomUUID ? crypto.randomUUID() : `tool_${Date.now()}`,
    ...toolData,
    status: toolData.status || 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  tools.push(newTool);
  safeWrite(STORAGE_KEYS.TOOLS, tools);
  
  logActivity('tool_created', { toolId: newTool.id, toolName: newTool.name });
  
  return newTool;
};

export const updateTool = (id, updates) => {
  const tools = getAllTools();
  const index = tools.findIndex(tool => tool.id === id);
  
  if (index === -1) return null;
  
  tools[index] = {
    ...tools[index],
    ...updates,
    id: tools[index].id, // Prevent ID change
    createdAt: tools[index].createdAt, // Keep original
    updatedAt: new Date().toISOString()
  };
  
  safeWrite(STORAGE_KEYS.TOOLS, tools);
  
  logActivity('tool_updated', { toolId: id, toolName: tools[index].name });
  
  return tools[index];
};

export const deleteTool = (id) => {
  const tools = getAllTools();
  const tool = tools.find(t => t.id === id);
  
  if (!tool) return false;
  
  const filtered = tools.filter(tool => tool.id !== id);
  safeWrite(STORAGE_KEYS.TOOLS, filtered);
  
  // Also remove from assignments
  const assignments = safeRead(STORAGE_KEYS.ASSIGNMENTS, []);
  const updatedAssignments = assignments.map(assignment => ({
    ...assignment,
    toolIds: assignment.toolIds.filter(toolId => toolId !== id)
  }));
  safeWrite(STORAGE_KEYS.ASSIGNMENTS, updatedAssignments);
  
  logActivity('tool_deleted', { toolId: id, toolName: tool.name });
  
  return true;
};

export const toggleToolStatus = (id) => {
  const tool = getToolById(id);
  if (!tool) return null;
  
  const newStatus = tool.status === 'active' ? 'inactive' : 'active';
  return updateTool(id, { status: newStatus });
};
