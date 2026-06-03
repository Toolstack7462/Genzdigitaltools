// ============================================================
// DEPRECATED: This file is superseded by its Enhanced version.
// DO NOT IMPORT this file in new code. It will be deleted.
// See the corresponding *Enhanced.js or server-crm.js file.
// ============================================================

const express = require('express');
const router = express.Router();
const Tool = require('../../models/Tool');
const ToolAssignment = require('../../models/ToolAssignment');
const ActivityLog = require('../../models/ActivityLog');
const CredentialAccessLog = require('../../models/CredentialAccessLog');
const { requireAuth, requireAdmin, getClientIp } = require('../../middleware/authEnhanced');
const { validate, schemas } = require('../../middleware/validation');
const { decryptCookies } = require('../../utils/encryption');

// Apply auth middleware
router.use(requireAuth);
router.use(requireAdmin);

// GET /api/crm/admin/tools - List tools with pagination
router.get('/', async (req, res) => {
  try {
    const { 
      search, 
      category, 
      status,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;
    
    const query = {};
    
    // Search filter
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (category) query.category = category;
    if (status) query.status = status;
    
    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
    
    const [tools, totalCount] = await Promise.all([
      Tool.find(query)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .populate('createdBy', 'fullName email'),
      Tool.countDocuments(query)
    ]);
    
    // Enrich with assignment count
    const toolsWithData = await Promise.all(
      tools.map(async (tool) => {
        const assignmentCount = await ToolAssignment.countDocuments({ 
          toolId: tool._id,
          status: 'active'
        });
        
        return {
          ...tool.toObject(),
          assignmentCount
        };
      })
    );
    
    res.json({
      success: true,
      tools: toolsWithData,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        totalCount,
        totalPages: Math.ceil(totalCount / parseInt(limit)),
        hasMore: skip + tools.length < totalCount
      }
    });
  } catch (error) {
    console.error('Get tools error:', error);
    res.status(500).json({ error: 'Failed to fetch tools' });
  }
});

// GET /api/crm/admin/tools/stats - Get tool statistics
router.get('/stats', async (req, res) => {
  try {
    const [totalTools, activeTools, inactiveTools, toolsByCategory] = await Promise.all([
      Tool.countDocuments(),
      Tool.countDocuments({ status: 'active' }),
      Tool.countDocuments({ status: 'inactive' }),
      Tool.aggregate([
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);
    
    res.json({
      success: true,
      stats: {
        totalTools,
        activeTools,
        inactiveTools,
        byCategory: toolsByCategory
      }
    });
  } catch (error) {
    console.error('Get tool stats error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// GET /api/crm/admin/tools/:id - Get single tool
router.get('/:id', async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id)
      .populate('createdBy', 'fullName email');
    
    if (!tool) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    
    // Get assignments for this tool
    const assignments = await ToolAssignment.find({ toolId: tool._id })
      .populate('clientId', 'fullName email status')
      .sort({ createdAt: -1 })
      .limit(10);
    
    res.json({
      success: true,
      tool: tool.toObject(),
      recentAssignments: assignments
    });
  } catch (error) {
    console.error('Get tool error:', error);
    res.status(500).json({ error: 'Failed to fetch tool' });
  }
});

// POST /api/crm/admin/tools - Create tool
router.post('/', validate(schemas.createTool), async (req, res) => {
  try {
    const toolData = {
      ...req.body,
      createdBy: req.userId
    };
    
    const tool = await Tool.create(toolData);
    const ipAddress = getClientIp(req);
    
    await ActivityLog.log('ADMIN', req.userId, 'TOOL_CREATED', {
      toolId: tool._id,
      toolName: tool.name,
      category: tool.category,
      ipAddress
    });
    
    res.status(201).json({
      success: true,
      tool: tool.toObject(),
      message: 'Tool created successfully'
    });
  } catch (error) {
    console.error('Create tool error:', error);
    res.status(500).json({ error: 'Failed to create tool' });
  }
});

// PUT /api/crm/admin/tools/:id - Update tool
router.put('/:id', validate(schemas.updateTool), async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id);
    
    if (!tool) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    
    // Track changes
    const changes = {};
    const allowedUpdates = ['name', 'description', 'targetUrl', 'category', 'status', 'cookiesEncrypted', 'fileMeta'];
    
    allowedUpdates.forEach(field => {
      if (req.body[field] !== undefined && req.body[field] !== tool[field]) {
        changes[field] = { from: tool[field], to: req.body[field] };
        tool[field] = req.body[field];
      }
    });
    
    await tool.save();
    const ipAddress = getClientIp(req);
    
    await ActivityLog.log('ADMIN', req.userId, 'TOOL_UPDATED', {
      toolId: tool._id,
      toolName: tool.name,
      changes,
      ipAddress
    });
    
    res.json({
      success: true,
      tool: tool.toObject(),
      message: 'Tool updated successfully'
    });
  } catch (error) {
    console.error('Update tool error:', error);
    res.status(500).json({ error: 'Failed to update tool' });
  }
});

// DELETE /api/crm/admin/tools/:id - Delete tool
router.delete('/:id', async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id);
    
    if (!tool) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    
    // Check if tool has active assignments
    const activeAssignments = await ToolAssignment.countDocuments({
      toolId: tool._id,
      status: 'active'
    });
    
    if (activeAssignments > 0) {
      return res.status(400).json({ 
        error: `Cannot delete tool. It has ${activeAssignments} active assignment(s). Please remove assignments first.`
      });
    }
    
    // Delete all assignments
    await ToolAssignment.deleteMany({ toolId: tool._id });
    
    const ipAddress = getClientIp(req);
    
    await ActivityLog.log('ADMIN', req.userId, 'TOOL_DELETED', {
      toolId: tool._id,
      toolName: tool.name,
      ipAddress
    });
    
    await tool.deleteOne();
    
    res.json({
      success: true,
      message: 'Tool deleted successfully'
    });
  } catch (error) {
    console.error('Delete tool error:', error);
    res.status(500).json({ error: 'Failed to delete tool' });
  }
});

// GET /api/crm/admin/tools/:id/login-stats - Get login statistics for a tool
router.get('/:id/login-stats', verifyToken, requireRole(['ADMIN', 'SUPER_ADMIN']), async (req, res) => {
  try {
    const { id } = req.params;
    const days = parseInt(req.query.days) || 30;
    
    // Verify tool exists
    const tool = await Tool.findById(id);
    if (!tool) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    
    // Get login stats
    const stats = await CredentialAccessLog.getToolLoginStats(id, days);
    
    // Get recent login attempts
    const recentAttempts = await CredentialAccessLog.find({
      toolId: id,
      action: { $in: ['LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGIN_MFA_REQUIRED', 'LOGIN_MANUAL_REQUIRED'] }
    })
    .populate('clientId', 'fullName email')
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
    
    res.json({
      success: true,
      tool: {
        id: tool._id,
        name: tool.name
      },
      stats,
      recentAttempts: recentAttempts.map(a => ({
        action: a.action,
        method: a.loginAttempt?.method,
        success: a.success,
        duration: a.loginAttempt?.duration,
        client: a.clientId ? {
          name: a.clientId.fullName,
          email: a.clientId.email
        } : null,
        error: a.errorMessage,
        createdAt: a.createdAt
      })),
      period: `${days} days`
    });
  } catch (error) {
    console.error('Get login stats error:', error);
    res.status(500).json({ error: 'Failed to fetch login stats' });
  }
});

// POST /api/crm/admin/tools/:id/test-credentials - Test/validate credentials
router.post('/:id/test-credentials', verifyToken, requireRole(['ADMIN', 'SUPER_ADMIN']), async (req, res) => {
  try {
    const { id } = req.params;
    
    const tool = await Tool.findById(id);
    if (!tool) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    
    const validation = {
      valid: true,
      checks: [],
      warnings: []
    };
    
    const credType = tool.credentials?.type || tool.credentialType;
    
    // Check 1: Credential type is set
    if (!credType || credType === 'none') {
      validation.checks.push({ name: 'Credential Type', status: 'warning', message: 'No credentials configured' });
      validation.warnings.push('No credentials configured for this tool');
    } else {
      validation.checks.push({ name: 'Credential Type', status: 'pass', message: `Type: ${credType}` });
    }
    
    // Check 2: Based on credential type
    switch (credType) {
      case 'form':
        const hasFormCreds = tool.credentials?.payloadEncrypted || false;
        if (hasFormCreds) {
          validation.checks.push({ name: 'Form Credentials', status: 'pass', message: 'Username/password set' });
        } else {
          validation.checks.push({ name: 'Form Credentials', status: 'fail', message: 'Missing username/password' });
          validation.valid = false;
        }
        break;
        
      case 'sso':
        const hasAuthUrl = tool.credentials?.payloadEncrypted;
        if (hasAuthUrl) {
          validation.checks.push({ name: 'SSO Config', status: 'pass', message: 'Auth URL configured' });
        } else {
          validation.checks.push({ name: 'SSO Config', status: 'warning', message: 'No auth URL - will use login URL' });
          validation.warnings.push('SSO will use default login URL');
        }
        
        const ssoProvider = tool.credentials?.ssoOptions?.provider;
        if (ssoProvider) {
          validation.checks.push({ name: 'SSO Provider', status: 'pass', message: `Provider: ${ssoProvider}` });
        } else {
          validation.checks.push({ name: 'SSO Provider', status: 'info', message: 'Auto-detect provider' });
        }
        break;
        
      case 'cookies':
        if (tool.cookiesEncrypted) {
          try {
            const decrypted = decryptCookies(tool.cookiesEncrypted);
            const cookies = JSON.parse(decrypted);
            
            // Check cookie expiration
            const now = Date.now() / 1000;
            const expiredCookies = cookies.filter(c => c.expirationDate && c.expirationDate < now);
            
            if (expiredCookies.length > 0) {
              validation.checks.push({ 
                name: 'Cookie Expiration', 
                status: 'warning', 
                message: `${expiredCookies.length} of ${cookies.length} cookies expired` 
              });
              validation.warnings.push(`${expiredCookies.length} cookies are expired`);
            } else {
              validation.checks.push({ 
                name: 'Cookie Expiration', 
                status: 'pass', 
                message: `${cookies.length} cookies valid` 
              });
            }
            
            // Check for session cookies
            const sessionCookies = cookies.filter(c => 
              c.name.toLowerCase().includes('session') || 
              c.name.toLowerCase().includes('auth')
            );
            if (sessionCookies.length > 0) {
              validation.checks.push({ name: 'Session Cookies', status: 'pass', message: `${sessionCookies.length} session cookies found` });
            }
          } catch (e) {
            validation.checks.push({ name: 'Cookie Data', status: 'fail', message: 'Failed to decrypt/parse cookies' });
            validation.valid = false;
          }
        } else {
          validation.checks.push({ name: 'Cookie Data', status: 'fail', message: 'No cookies configured' });
          validation.valid = false;
        }
        break;
        
      case 'token':
        if (tool.tokenEncrypted) {
          validation.checks.push({ name: 'Token', status: 'pass', message: 'Token configured' });
          validation.checks.push({ name: 'Token Header', status: 'info', message: `Header: ${tool.tokenHeader || 'Authorization'}` });
        } else {
          validation.checks.push({ name: 'Token', status: 'fail', message: 'No token configured' });
          validation.valid = false;
        }
        break;
        
      case 'localStorage':
      case 'sessionStorage':
        if (tool.localStorageEncrypted) {
          validation.checks.push({ name: 'Storage Data', status: 'pass', message: 'Storage data configured' });
        } else {
          validation.checks.push({ name: 'Storage Data', status: 'fail', message: 'No storage data configured' });
          validation.valid = false;
        }
        break;
    }
    
    // Check 3: URLs configured
    if (tool.targetUrl) {
      validation.checks.push({ name: 'Target URL', status: 'pass', message: tool.targetUrl });
    } else {
      validation.checks.push({ name: 'Target URL', status: 'fail', message: 'Missing target URL' });
      validation.valid = false;
    }
    
    if (tool.loginUrl) {
      validation.checks.push({ name: 'Login URL', status: 'pass', message: tool.loginUrl });
    } else if (['form', 'sso'].includes(credType)) {
      validation.checks.push({ name: 'Login URL', status: 'info', message: 'Using target URL as login URL' });
    }
    
    // Check 4: Success validation configured
    const hasSuccessCheck = tool.credentials?.successCheck && 
      Object.values(tool.credentials.successCheck).some(v => v && (Array.isArray(v) ? v.length > 0 : true));
    
    if (hasSuccessCheck) {
      validation.checks.push({ name: 'Success Validation', status: 'pass', message: 'Configured' });
    } else {
      validation.checks.push({ name: 'Success Validation', status: 'info', message: 'Using default detection' });
    }
    
    res.json({
      success: true,
      validation
    });
  } catch (error) {
    console.error('Test credentials error:', error);
    res.status(500).json({ error: 'Failed to test credentials' });
  }
});

module.exports = router;
