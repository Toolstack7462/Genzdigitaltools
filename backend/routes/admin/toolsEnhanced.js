const express = require('express');
const router = express.Router();
const Tool = require('../../models/Tool');
const ToolAssignment = require('../../models/ToolAssignment');
const ActivityLog = require('../../models/ActivityLog');
const CredentialAccessLog = require('../../models/CredentialAccessLog');
const { requireAuth, requireAdmin, getClientIp } = require('../../middleware/authEnhanced');
const { validate, schemas } = require('../../middleware/validation');
const { normalizeStringInputs } = require('../../middleware/normalize');
const { encryptCookies, decryptCookies } = require('../../utils/encryption');

router.use(requireAuth);
router.use(requireAdmin);

// ─── Helpers ──────────────────────────────────────────────────────────────────

// FIX3: Escape regex special chars to prevent ReDoS
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// FIX17: Safe pagination params
function safePagination(query) {
  const page  = Math.max(1, parseInt(query.page,  10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

// FIX5: Strip all encrypted credential fields from tool objects
function sanitizeToolForAdmin(toolObj) {
  const STRIP = [
    'cookiesEncrypted', 'tokenEncrypted', 'localStorageEncrypted'
  ];
  STRIP.forEach(k => delete toolObj[k]);
  if (toolObj.credentials) {
    delete toolObj.credentials.payloadEncrypted;
  }
  if (toolObj.sessionBundle) {
    delete toolObj.sessionBundle.cookiesEncrypted;
    delete toolObj.sessionBundle.localStorageEncrypted;
    delete toolObj.sessionBundle.sessionStorageEncrypted;
  }
  return toolObj;
}

// ─── GET / — list tools ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { search, category, status, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    const { page, limit, skip } = safePagination(req.query);

    const query = {};

    // FIX3: Escape and length-limit search
    if (search) {
      if (String(search).length > 100) return res.status(400).json({ error: 'Search term too long (max 100 chars)' });
      const escaped = escapeRegex(search.trim());
      query.$or = [
        { name:        { $regex: escaped, $options: 'i' } },
        { description: { $regex: escaped, $options: 'i' } }
      ];
    }
    if (category) query.category = category;
    if (status)   query.status   = status;

    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

    const [tools, totalCount] = await Promise.all([
      Tool.find(query).sort(sort).skip(skip).limit(limit).populate('createdBy', 'fullName email'),
      Tool.countDocuments(query)
    ]);

    // FIX9: Single aggregation for assignment counts instead of N+1 queries
    const toolIds = tools.map(t => t._id);
    const assignmentCounts = await ToolAssignment.aggregate([
      { $match: { toolId: { $in: toolIds }, status: 'active' } },
      { $group: { _id: '$toolId', count: { $sum: 1 } } }
    ]);
    const countMap = Object.fromEntries(assignmentCounts.map(a => [a._id.toString(), a.count]));

    // FIX5: Strip encrypted fields from every tool in list
    const toolsWithData = tools.map(tool => {
      const obj = sanitizeToolForAdmin(tool.toObject());
      obj.assignmentCount = countMap[tool._id.toString()] || 0;
      return obj;
    });

    return res.json({
      success: true,
      tools: toolsWithData,
      pagination: { page, limit, totalCount, totalPages: Math.ceil(totalCount / limit), hasMore: skip + tools.length < totalCount }
    });
  } catch (err) {
    console.error('Get tools error:', err);
    return res.status(500).json({ error: 'Failed to fetch tools' });
  }
});

// ─── GET /stats ───────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [totalTools, activeTools, inactiveTools, toolsByCategory] = await Promise.all([
      Tool.countDocuments(),
      Tool.countDocuments({ status: 'active' }),
      Tool.countDocuments({ status: 'inactive' }),
      Tool.aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1 } }])
    ]);
    return res.json({ success: true, stats: { totalTools, activeTools, inactiveTools, byCategory: toolsByCategory } });
  } catch (err) {
    console.error('Get tool stats error:', err);
    return res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id).populate('createdBy', 'fullName email');
    if (!tool) return res.status(404).json({ error: 'Tool not found' });

    const assignmentCount = await ToolAssignment.countDocuments({ toolId: tool._id, status: 'active' });
    // FIX5: Strip encrypted fields from single tool too
    const obj = sanitizeToolForAdmin(tool.toObject());
    obj.assignmentCount = assignmentCount;

    return res.json({ success: true, tool: obj });
  } catch (err) {
    console.error('Get tool error:', err);
    return res.status(500).json({ error: 'Failed to fetch tool' });
  }
});

// ─── POST / — create tool ────────────────────────────────────────────────────
router.post('/', normalizeStringInputs, validate(schemas.createTool), async (req, res) => {
  try {
    const toolData = { ...req.body, createdBy: req.userId };

    // Block "Custom Headers" — MV3 cannot inject request headers reliably.
    // The extension's HeadersStrategy silently falls back to localStorage,
    // which is misleading. Admin must pick a supported type.
    const HEADERS_BLOCKED = 'Custom Headers auth is not supported in this build (Chrome MV3 limitation). Use Cookies, Bearer Token, Local Storage, Session Storage, Form Login, or SSO instead.';
    if (toolData.credentialType === 'headers') return res.status(400).json({ error: HEADERS_BLOCKED, code: 'auth_type_unsupported' });
    if (toolData.credentials?.type === 'headers') return res.status(400).json({ error: HEADERS_BLOCKED, code: 'auth_type_unsupported' });
    if (toolData.comboAuth?.enabled && (toolData.comboAuth.primaryType === 'headers' || toolData.comboAuth.secondaryType === 'headers')) {
      return res.status(400).json({ error: HEADERS_BLOCKED, code: 'auth_type_unsupported' });
    }

    // Encrypt credentials if provided in plaintext
    if (toolData.cookiesEncrypted && !toolData.cookiesEncrypted.includes(':')) {
      toolData.cookiesEncrypted = encryptCookies(toolData.cookiesEncrypted);
    }
    if (toolData.credentials?.payload && !toolData.credentials.payloadEncrypted) {
      toolData.credentials.payloadEncrypted = encryptCookies(JSON.stringify(toolData.credentials.payload));
      delete toolData.credentials.payload;
    }

    const tool = await Tool.create(toolData);
    await ActivityLog.log('ADMIN', req.userId, 'TOOL_CREATED', { toolId: tool._id.toString(), toolName: tool.name });

    return res.status(201).json({ success: true, tool: sanitizeToolForAdmin(tool.toObject()) });
  } catch (err) {
    console.error('Create tool error:', err);
    return res.status(500).json({ error: 'Failed to create tool' });
  }
});

// ─── PUT /:id — update tool ───────────────────────────────────────────────────
router.put('/:id', normalizeStringInputs, validate(schemas.updateTool), async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });

    const updates = { ...req.body };

    const HEADERS_BLOCKED = 'Custom Headers auth is not supported in this build (Chrome MV3 limitation). Use Cookies, Bearer Token, Local Storage, Session Storage, Form Login, or SSO instead.';
    if (updates.credentialType === 'headers') return res.status(400).json({ error: HEADERS_BLOCKED, code: 'auth_type_unsupported' });
    if (updates.credentials?.type === 'headers') return res.status(400).json({ error: HEADERS_BLOCKED, code: 'auth_type_unsupported' });
    if (updates.comboAuth?.enabled && (updates.comboAuth.primaryType === 'headers' || updates.comboAuth.secondaryType === 'headers')) {
      return res.status(400).json({ error: HEADERS_BLOCKED, code: 'auth_type_unsupported' });
    }

    if (updates.cookiesEncrypted && !updates.cookiesEncrypted.includes(':')) {
      updates.cookiesEncrypted = encryptCookies(updates.cookiesEncrypted);
    }
    if (updates.credentials?.payload) {
      updates['credentials.payloadEncrypted'] = encryptCookies(JSON.stringify(updates.credentials.payload));
      delete updates.credentials.payload;
    }

    Object.assign(tool, updates);
    await tool.save();

    await ActivityLog.log('ADMIN', req.userId, 'TOOL_UPDATED', { toolId: tool._id.toString(), toolName: tool.name });
    return res.json({ success: true, tool: sanitizeToolForAdmin(tool.toObject()) });
  } catch (err) {
    console.error('Update tool error:', err);
    return res.status(500).json({ error: 'Failed to update tool' });
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });

    await ToolAssignment.deleteMany({ toolId: tool._id });
    await tool.deleteOne();

    await ActivityLog.log('ADMIN', req.userId, 'TOOL_DELETED', { toolId: req.params.id, toolName: tool.name });
    return res.json({ success: true, message: 'Tool deleted' });
  } catch (err) {
    console.error('Delete tool error:', err);
    return res.status(500).json({ error: 'Failed to delete tool' });
  }
});

// ─── PUT /:id/session-bundle ──────────────────────────────────────────────────
router.put('/:id/session-bundle', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });

    const { cookies, localStorage: ls, sessionStorage: ss } = req.body;

    // Validate shape before encrypting. Saving garbage here would later fail in
    // the extension as cookie_injection_failed / session_bundle_missing with no
    // clear hint to the admin.
    if (cookies !== undefined && cookies !== null) {
      if (!Array.isArray(cookies)) {
        return res.status(400).json({ error: 'cookies must be a JSON array' });
      }
      for (const c of cookies) {
        if (!c || typeof c !== 'object' || !c.name || typeof c.name !== 'string') {
          return res.status(400).json({ error: 'each cookie must be an object with a "name" string' });
        }
      }
    }
    if (ls !== undefined && ls !== null) {
      if (typeof ls !== 'object' || Array.isArray(ls)) {
        return res.status(400).json({ error: 'localStorage must be a JSON object of key/value pairs' });
      }
    }
    if (ss !== undefined && ss !== null) {
      if (typeof ss !== 'object' || Array.isArray(ss)) {
        return res.status(400).json({ error: 'sessionStorage must be a JSON object of key/value pairs' });
      }
    }

    if (!tool.sessionBundle) tool.sessionBundle = {};

    if (cookies !== undefined) {
      tool.sessionBundle.cookiesEncrypted = cookies ? encryptCookies(JSON.stringify(cookies)) : null;
    }
    if (ls !== undefined) {
      tool.sessionBundle.localStorageEncrypted = ls ? encryptCookies(JSON.stringify(ls)) : null;
    }
    if (ss !== undefined) {
      tool.sessionBundle.sessionStorageEncrypted = ss ? encryptCookies(JSON.stringify(ss)) : null;
    }

    tool.sessionBundle.bundleUpdatedAt = new Date();  // FIX19: renamed field
    tool.markModified('sessionBundle');
    await tool.save();

    await ActivityLog.log('ADMIN', req.userId, 'SESSION_BUNDLE_UPDATED', { toolId: tool._id.toString() });

    return res.json({
      success: true,
      sessionBundle: {
        version: tool.sessionBundle.version,
        bundleUpdatedAt: tool.sessionBundle.bundleUpdatedAt,
        hasCookies: !!tool.sessionBundle.cookiesEncrypted,
        hasLocalStorage: !!tool.sessionBundle.localStorageEncrypted,
        hasSessionStorage: !!tool.sessionBundle.sessionStorageEncrypted
      }
    });
  } catch (err) {
    console.error('Update session bundle error:', err);
    return res.status(500).json({ error: 'Failed to update session bundle' });
  }
});

// ─── GET /:id/session-bundle — admin preview (decrypted) ──────────────────────
router.get('/:id/session-bundle', async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });

    if (!tool.sessionBundle) return res.json({ success: true, sessionBundle: null });

    const bundle = { version: tool.sessionBundle.version, bundleUpdatedAt: tool.sessionBundle.bundleUpdatedAt };

    if (tool.sessionBundle.cookiesEncrypted) {
      bundle.cookies = JSON.parse(decryptCookies(tool.sessionBundle.cookiesEncrypted));
    }
    if (tool.sessionBundle.localStorageEncrypted) {
      bundle.localStorage = JSON.parse(decryptCookies(tool.sessionBundle.localStorageEncrypted));
    }
    if (tool.sessionBundle.sessionStorageEncrypted) {
      bundle.sessionStorage = JSON.parse(decryptCookies(tool.sessionBundle.sessionStorageEncrypted));
    }

    await ActivityLog.log('ADMIN', req.userId, 'SESSION_BUNDLE_VIEWED', { toolId: tool._id.toString() });
    return res.json({ success: true, sessionBundle: bundle });
  } catch (err) {
    console.error('Get session bundle error:', err);
    return res.status(500).json({ error: 'Failed to fetch session bundle' });
  }
});

module.exports = router;

// ─── POST /test — basic connectivity test for a tool URL ──────────────────────
router.post('/test', async (req, res) => {
  try {
    const { targetUrl } = req.body;
    if (!targetUrl) return res.status(400).json({ error: 'targetUrl required' });

    // Validate URL format
    let url;
    try { url = new URL(targetUrl); } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      return res.status(400).json({ error: 'Only http/https URLs allowed' });
    }

    // Attempt HEAD request with short timeout
    const https = url.protocol === 'https:' ? require('https') : require('http');
    await new Promise((resolve, reject) => {
      const req2 = https.request(
        { hostname: url.hostname, path: url.pathname || '/', method: 'HEAD', timeout: 6000 },
        (res2) => {
          if (res2.statusCode < 500) resolve(res2.statusCode);
          else reject(new Error(`Server returned ${res2.statusCode}`));
        }
      );
      req2.on('timeout', () => { req2.destroy(); reject(new Error('Connection timed out')); });
      req2.on('error', reject);
      req2.end();
    });

    return res.json({ success: true, message: `URL reachable (${url.hostname})` });
  } catch (err) {
    return res.status(200).json({ success: false, message: `Could not reach URL: ${err.message}` });
  }
});
