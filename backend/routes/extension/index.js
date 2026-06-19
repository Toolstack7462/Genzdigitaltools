const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const User = require('../../models/User');
const Tool = require('../../models/Tool');
const ToolAssignment = require('../../models/ToolAssignment');
const ExtensionToken = require('../../models/ExtensionToken');
const CredentialAccessLog = require('../../models/CredentialAccessLog');
const ActivityLog = require('../../models/ActivityLog');
const ActivationToken = require('../../models/ActivationToken');
const DeviceBinding = require('../../models/DeviceBinding');
const { getClientAccessibleTool } = require('../../utils/getClientAccessibleTool');
const { buildToolCleanupConfig, getToolAccessMode } = require('../../utils/toolCleanupConfig');
const { decryptCookies }    = require('../../utils/encryption');
const SecurityAlert         = require('../../models/SecurityAlert');
const ExtensionScan         = require('../../models/ExtensionScan');
const { processExtensionScanReport, checkAccessFrequency, checkExpiredAccess, checkNewDevice, checkRepeatedAuthFailures } = require('../../middleware/riskEngine');
const bcrypt = require('bcryptjs');
const { authLimiter } = require('../../middleware/rateLimiter');

function getExtensionTokenDays() {
  const days = Number(process.env.EXTENSION_TOKEN_DAYS || 365);
  return Number.isFinite(days) && days > 0 ? days : 365;
}

// ─── Exact access-decision error codes (never a generic 403) ────────────────
// Every access gate in the open flow returns ONE of these in `code` so the
// extension/dashboard can act precisely instead of guessing from a 403.
const ACCESS_CODES = {
  ASSIGNMENT_NOT_FOUND:   'assignment_not_found',
  ASSIGNMENT_EXPIRED:     'assignment_expired',
  SESSION_BUNDLE_MISSING: 'session_bundle_missing',
  TOOL_DOMAIN_INVALID:    'tool_domain_invalid',
  EXTENSION_TOKEN_INVALID:'extension_token_invalid',
  INTENT_INVALID:         'intent_invalid',
  DEVICE_BLOCKED:         'device_blocked',
};

// Safe access-stage logger. ONLY ids/dates/booleans/reasons — never cookies,
// tokens, credential payloads, or any secret value.
function accessDebug(stage, fields = {}) {
  const safe = {
    stage,
    clientId:        fields.clientId != null ? String(fields.clientId) : null,
    toolId:          fields.toolId != null ? String(fields.toolId) : null,
    assignmentId:    fields.assignmentId != null ? String(fields.assignmentId) : null,
    assignmentStatus:fields.assignmentStatus ?? null,
    endDate:         fields.endDate ?? null,
    usedEndBoundary: fields.usedEndBoundary ?? null,
    serverTime:      fields.serverTime || new Date().toISOString(),
    hasSessionBundle:fields.hasSessionBundle ?? null,
    toolDomain:      fields.toolDomain ?? null,
    code:            fields.code ?? null,
    reason:          fields.reason ?? null,
  };
  console.log(`[access:${stage}]`, safe);
}

// Middleware to verify extension token
const verifyExtensionToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('ExtToken ')) {
      accessDebug('extension_token', { reason: 'missing_header', code: ACCESS_CODES.EXTENSION_TOKEN_INVALID });
      return res.status(401).json({ error: 'Extension token required', code: ACCESS_CODES.EXTENSION_TOKEN_INVALID });
    }

    const token = authHeader.substring(9); // Remove 'ExtToken '
    const requestDeviceIdHash = req.headers['x-device-id-hash'] || null;
    const tokenData = await ExtensionToken.verifyToken(token, requestDeviceIdHash);

    if (!tokenData) {
      accessDebug('extension_token', { reason: 'invalid_or_expired_token', code: ACCESS_CODES.EXTENSION_TOKEN_INVALID });
      return res.status(401).json({ error: 'Invalid or expired extension token', code: ACCESS_CODES.EXTENSION_TOKEN_INVALID });
    }

    if (tokenData.client.status === 'disabled') {
      accessDebug('extension_token', { clientId: tokenData.clientId, reason: 'account_disabled', code: ACCESS_CODES.DEVICE_BLOCKED });
      return res.status(403).json({ error: 'Account is disabled', code: ACCESS_CODES.DEVICE_BLOCKED });
    }
    
    req.clientId = tokenData.clientId;
    req.client = tokenData.client;
    req.extensionTokenId = tokenData.tokenId;
    req.extensionDeviceIdHash = tokenData.deviceIdHash || requestDeviceIdHash || null;
    next();
  } catch (error) {
    console.error('Extension token verification error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

// POST /api/crm/extension/auth - Authenticate and get extension token
router.post('/auth', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    // FIX: Validate input with length limits before touching the database.
    // Previously only a null check existed; a 10,000-char "email" would hit MySQL/MariaDB.
    if (!email || typeof email !== 'string' || email.length > 254 || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    if (!password || typeof password !== 'string' || password.length < 1 || password.length > 128) {
      return res.status(400).json({ error: 'Password is required (max 128 characters)' });
    }
    
    // Find client user
    const user = await User.findOne({ 
      email: email.toLowerCase().trim(),
      role: 'CLIENT'
    });
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    if (user.status === 'disabled') {
      accessDebug('extension_auth', { clientId: user._id, reason: 'account_disabled', code: ACCESS_CODES.DEVICE_BLOCKED });
      return res.status(403).json({ error: 'Account is disabled', code: ACCESS_CODES.DEVICE_BLOCKED });
    }

    // Check if user has a password set
    if (!user.passwordHash) {
      return res.status(401).json({ error: 'Password not set. Please reset your password.' });
    }
    
    // Verify password using model method
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim();
      await ActivityLog.log('SYSTEM', null, 'EXTENSION_AUTH_FAILED', {
        email: email.toLowerCase().trim(),
        ip,
        reason: 'invalid_password',
      });
      // Non-blocking risk check
      checkRepeatedAuthFailures(ip, { clientId: user?._id }).catch(() => {});
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Create extension token (valid for 30 days). If the extension sends a
    // device hash, bind the token to that device; dashboard activation is the
    // preferred pairing flow because it uses the already-bound website device.
    const deviceIdHash = req.headers['x-device-id-hash'] || null;
    const tokenData = await ExtensionToken.createForClient(user._id, getExtensionTokenDays(), {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      deviceIdHash
    });
    
    await ActivityLog.log('CLIENT', user._id, 'EXTENSION_AUTH', {
      action: 'Extension authenticated',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Risk Engine: check if this is a new/unrecognised device (non-blocking)
    const riskCtx = {
      ipAddress:        req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim(),
      userAgent:        req.headers['user-agent'],
      extensionVersion: req.headers['x-extension-version'],
    };
    if (deviceIdHash) {
      checkNewDevice(user._id, deviceIdHash, riskCtx).catch(() => {});
    }
    
    res.json({
      success: true,
      token: tokenData.token,
      expiresAt: tokenData.expiresAt,
      user: {
        id: user._id,
        email: user.email,
        name: user.fullName
      }
    });
  } catch (error) {
    console.error('Extension auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});


// POST /api/crm/extension/auth/activate - Pair extension from logged-in dashboard
router.post('/auth/activate', authLimiter, async (req, res) => {
  try {
    const { activationToken } = req.body || {};
    if (!activationToken || typeof activationToken !== 'string' || activationToken.length > 128) {
      return res.status(400).json({ error: 'activationToken required' });
    }

    const activation = await ActivationToken.consume(activationToken);

    if (!activation || !activation.clientId) {
      accessDebug('extension_activate', { reason: 'activation_token_invalid_expired_or_used', code: ACCESS_CODES.EXTENSION_TOKEN_INVALID });
      return res.status(403).json({ error: 'Activation token invalid, expired, or already used', code: ACCESS_CODES.EXTENSION_TOKEN_INVALID });
    }

    const user = await User.findById(activation.clientId);
    if (!user || user.role !== 'CLIENT') {
      accessDebug('extension_activate', { clientId: activation.clientId, reason: 'invalid_activation_client', code: ACCESS_CODES.EXTENSION_TOKEN_INVALID });
      return res.status(403).json({ error: 'Invalid activation client', code: ACCESS_CODES.EXTENSION_TOKEN_INVALID });
    }
    if (user.status === 'disabled') {
      accessDebug('extension_activate', { clientId: user._id, reason: 'account_disabled', code: ACCESS_CODES.DEVICE_BLOCKED });
      return res.status(403).json({ error: 'Account is disabled', code: ACCESS_CODES.DEVICE_BLOCKED });
    }

    const dashboardDeviceIdHash = activation.deviceIdHash || null;
    const extensionDeviceIdHash = req.headers['x-device-id-hash'] || null;

    // If device binding is enabled, the activation token must have been created
    // from the already-bound client dashboard device. The extension has its own
    // chrome.storage device id, so we validate the dashboard device first and
    // then attach the extension device hash to that same binding for future
    // extension-token verification.
    if (user.devicePolicy?.enabled) {
      if (!dashboardDeviceIdHash) {
        accessDebug('extension_activate', { clientId: user._id, reason: 'device_binding_required', code: ACCESS_CODES.DEVICE_BLOCKED });
        return res.status(403).json({ error: 'Device binding required', code: ACCESS_CODES.DEVICE_BLOCKED });
      }
      const binding = await DeviceBinding.findOne({ clientId: user._id, deviceIdHash: dashboardDeviceIdHash });
      if (!binding) {
        accessDebug('extension_activate', { clientId: user._id, reason: 'device_binding_mismatch', code: ACCESS_CODES.DEVICE_BLOCKED });
        return res.status(403).json({ error: 'Device binding mismatch', code: ACCESS_CODES.DEVICE_BLOCKED });
      }
      if (extensionDeviceIdHash) binding.extensionDeviceIdHash = extensionDeviceIdHash;
      binding.lastSeenAt = new Date();
      await binding.save();
    }

    const tokenDeviceIdHash = extensionDeviceIdHash || dashboardDeviceIdHash || null;
    const tokenData = await ExtensionToken.createForClient(user._id, getExtensionTokenDays(), {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      deviceIdHash: tokenDeviceIdHash
    });

    await ActivityLog.log('CLIENT', user._id, 'EXTENSION_ACTIVATED', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      deviceBound: !!tokenDeviceIdHash
    });

    return res.json({
      success: true,
      token: tokenData.token,
      expiresAt: tokenData.expiresAt,
      user: { id: user._id, email: user.email, name: user.fullName },
      version: req.headers['x-extension-version']
    });
  } catch (error) {
    console.error('Extension activate error:', error);
    res.status(500).json({ error: 'Extension activation failed' });
  }
});

// POST /api/crm/extension/logout - Revoke extension token
router.post('/logout', verifyExtensionToken, async (req, res) => {
  try {
    const token = await ExtensionToken.findById(req.extensionTokenId);
    if (token) {
      await token.revoke();
    }
    
    await ActivityLog.log('CLIENT', req.clientId, 'EXTENSION_LOGOUT', {
      action: 'Extension logged out'
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Extension logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// GET /api/crm/extension/tools - Get assigned tools with versions
router.get('/tools', verifyExtensionToken, async (req, res) => {
  try {
    // Update expired assignments
    await ToolAssignment.updateExpiredAssignments();
    
    // Get valid assignments
    const assignments = await ToolAssignment.find({
      clientId: req.clientId,
      status: 'active'
    }).populate('toolId');
    
    const now = new Date();
    const tools = [];
    
    for (const assignment of assignments) {
      if (!assignment.toolId || assignment.toolId.status !== 'active') continue;
      if (assignment.startDate && new Date(assignment.startDate) > now) continue;
      if (ToolAssignment.isAssignmentExpired(assignment, now)) continue; // end-of-day inclusive

      const tool = assignment.toolId;

      // Build session bundle info (version only, not decrypted data)
      const sessionBundleInfo = tool.sessionBundle ? {
        version: tool.sessionBundle.version || 1,
        updatedAt: tool.sessionBundle.bundleUpdatedAt,
        hasCookies: !!tool.sessionBundle.cookiesEncrypted,
        hasLocalStorage: !!tool.sessionBundle.localStorageEncrypted,
        hasSessionStorage: !!tool.sessionBundle.sessionStorageEncrypted
      } : null;
      
      // Build comboAuth config with new parallel mode settings
      const comboAuthConfig = tool.comboAuth ? {
        enabled: tool.comboAuth.enabled || false,
        runMode: tool.comboAuth.runMode || 'sequential',
        primaryType: tool.comboAuth.primaryType || 'sso',
        secondaryType: tool.comboAuth.secondaryType || 'form',
        fallbackEnabled: tool.comboAuth.fallbackEnabled ?? true,
        fallbackOnlyOnce: tool.comboAuth.fallbackOnlyOnce ?? true,
        skipIfLoggedIn: tool.comboAuth.skipIfLoggedIn ?? true,
        triggerOnAuto: tool.comboAuth.triggerOnAuto ?? true,
        parallelSettings: {
          prepSessionFirst: tool.comboAuth.parallelSettings?.prepSessionFirst ?? true,
          parallelTimeout: tool.comboAuth.parallelSettings?.parallelTimeout ?? 30000,
          commitLock: tool.comboAuth.parallelSettings?.commitLock ?? true,
          verifyAfterAuth: tool.comboAuth.parallelSettings?.verifyAfterAuth ?? true
        }
      } : { enabled: false };
      
      tools.push({
        id: tool._id,
        name: tool.name,
        description: tool.description,
        targetUrl: tool.targetUrl,
        loginUrl: tool.loginUrl,
        domain: tool.domain,
        category: tool.category,
        credentialType: tool.credentialType || 'cookies',
        credentialVersion: tool.credentialVersion || 1,
        credentialUpdatedAt: tool.credentialUpdatedAt,
        hasCredentials: tool.hasCredentials(),
        // Session Bundle info for version checking
        sessionBundle: sessionBundleInfo,
        // Combo Auth config with parallel mode support
        comboAuth: comboAuthConfig,
        extensionSettings: {
          ...tool.extensionSettings,
          // Ensure new settings have defaults
          hiddenModeEnabled: tool.extensionSettings?.hiddenModeEnabled ?? true,
          hiddenModeTimeout: tool.extensionSettings?.hiddenModeTimeout ?? 60000,
          autoStartEnabled: tool.extensionSettings?.autoStartEnabled ?? true,
          autoStartDelay: tool.extensionSettings?.autoStartDelay ?? 800,
          maxAutoAttempts: tool.extensionSettings?.maxAutoAttempts ?? 2
        },
        assignment: {
          id: assignment._id,
          startDate: assignment.startDate,
          endDate: assignment.endDate,
          status: assignment.status
        }
      });
    }
    
    // Log version check
    await CredentialAccessLog.log({
      clientId: req.clientId,
      toolId: null,
      extensionTokenId: req.extensionTokenId,
      action: 'VERSION_CHECK',
      deviceInfo: {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
        extensionVersion: req.headers['x-extension-version']
      }
    });
    
    res.json({ 
      success: true,
      tools,
      syncedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Get extension tools error:', error);
    res.status(500).json({ error: 'Failed to fetch tools' });
  }
});

// GET /api/crm/extension/tools/versions - Lightweight version check
router.get('/tools/versions', verifyExtensionToken, async (req, res) => {
  try {
    await ToolAssignment.updateExpiredAssignments();
    
    const assignments = await ToolAssignment.find({
      clientId: req.clientId,
      status: 'active'
    }).populate('toolId', '_id credentialVersion credentialUpdatedAt sessionBundle');

    const now = new Date();
    const versions = {};

    for (const assignment of assignments) {
      if (!assignment.toolId) continue;
      if (assignment.startDate && new Date(assignment.startDate) > now) continue;
      if (ToolAssignment.isAssignmentExpired(assignment, now)) continue; // end-of-day inclusive

      const t = assignment.toolId;
      // Lightweight version signature inputs — lets the extension decide whether its
      // cached sessionBundle is still current WITHOUT fetching/decrypting the bundle.
      versions[t._id] = {
        version: t.credentialVersion || 1,
        updatedAt: t.credentialUpdatedAt,
        bundleVersion: t.sessionBundle?.version || 0,
        bundleUpdatedAt: t.sessionBundle?.bundleUpdatedAt || null,
        assignmentId: String(assignment._id),
      };
    }
    
    res.json({ 
      success: true,
      versions,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Get versions error:', error);
    res.status(500).json({ error: 'Failed to fetch versions' });
  }
});

// GET /api/crm/extension/tools/:toolId/credentials - Get decrypted credentials
router.get('/tools/:toolId/credentials', verifyExtensionToken, async (req, res) => {
  try {
    const { toolId } = req.params;

    // FIX: Validate toolId is a valid MySQL/MariaDB ObjectId before querying.
    // A malformed ID causes database adapter to throw a CastError that leaks a stack
    // trace in the response if NODE_ENV is not 'production'.
    if (!toolId || !/^[a-f\d]{24}$/i.test(toolId)) {
      return res.status(400).json({ error: 'Invalid tool ID format' });
    }

    // Verify assignment via the SHARED helper — same source of truth used by
    // the dashboard list / open-intent / verify-intent paths.
    const decision = await getClientAccessibleTool(req.clientId, toolId);
    const candidates = decision.candidates || [];
    const assignment = decision.ok ? decision.assignment : null;
    const nowTs = new Date();

    if (!assignment) {
      const hadAny = candidates.length > 0;
      const code = decision.code === 'assignment_expired' ? ACCESS_CODES.ASSIGNMENT_EXPIRED : ACCESS_CODES.ASSIGNMENT_NOT_FOUND;
      accessDebug('credentials', {
        clientId: req.clientId, toolId,
        assignmentId: hadAny ? candidates[0]._id : null,
        assignmentStatus: hadAny ? candidates[0].status : null,
        endDate: hadAny ? candidates[0].endDate : null,
        usedEndBoundary: hadAny ? (ToolAssignment.effectiveEndBoundary(candidates[0].endDate)?.toISOString() || null) : null,
        serverTime: nowTs.toISOString(),
        code, reason: hadAny ? 'all_candidates_expired_or_inactive' : 'no_assignment_row',
      });
      await CredentialAccessLog.log({
        clientId: req.clientId,
        toolId,
        extensionTokenId: req.extensionTokenId,
        action: 'CREDENTIALS_FETCHED',
        success: false,
        errorMessage: code,
        deviceInfo: {
          userAgent: req.headers['user-agent'],
          ip: req.ip,
          extensionVersion: req.headers['x-extension-version']
        }
      });
      return res.status(403).json({
        error: hadAny ? 'Tool access expired or revoked' : 'Tool not assigned to you',
        code,
      });
    }

    const tool = assignment.toolId;

    if (!tool || tool.status !== 'active') {
      accessDebug('credentials', {
        clientId: req.clientId, toolId, assignmentId: assignment._id,
        assignmentStatus: assignment.status, endDate: assignment.endDate,
        serverTime: nowTs.toISOString(), code: ACCESS_CODES.ASSIGNMENT_EXPIRED,
        reason: 'tool_inactive_or_deleted',
      });
      // Tool turned off/deleted by admin → access is effectively revoked.
      return res.status(403).json({ error: 'Tool not available', code: ACCESS_CODES.ASSIGNMENT_EXPIRED });
    }

    // The tool must resolve to a real target domain or the extension cannot open
    // or scope cookies to it.
    const resolvedTargetUrl = tool.targetUrl || tool.loginUrl || null;
    if (!resolvedTargetUrl || !tool.domain) {
      accessDebug('credentials', {
        clientId: req.clientId, toolId, assignmentId: assignment._id,
        assignmentStatus: assignment.status, toolDomain: tool.domain || null,
        serverTime: nowTs.toISOString(), code: ACCESS_CODES.TOOL_DOMAIN_INVALID,
        reason: 'missing_target_url_or_domain',
      });
      return res.status(422).json({ error: 'Tool has no valid target URL', code: ACCESS_CODES.TOOL_DOMAIN_INVALID });
    }
    
    // Build unified credential response
    let credentials = null;
    // Track which field is being decrypted so the catch can name it precisely.
    let currentField = null;

    try {
      // Check for new unified credentials first
      if (tool.credentials && tool.credentials.type && tool.credentials.payloadEncrypted) {
        currentField = 'credentials.payloadEncrypted';
        const payloadJson = decryptCookies(tool.credentials.payloadEncrypted);
        currentField = 'credentials.payloadEncrypted:json';
        const payload = JSON.parse(payloadJson);

        credentials = {
          type: tool.credentials.type,
          payload: payload,
          selectors: tool.credentials.selectors || {},
          successCheck: tool.credentials.successCheck || {},
          domain: tool.domain,
          loginUrl: tool.loginUrl || tool.targetUrl
        };

        // Add legacy header info if it's a headers/token type
        if (tool.credentials.type === 'headers' || tool.credentials.type === 'token') {
          credentials.tokenHeader = tool.credentials.tokenHeader || tool.tokenHeader || 'Authorization';
          credentials.tokenPrefix = tool.credentials.tokenPrefix || tool.tokenPrefix || 'Bearer ';
        }
      }
      // Fallback to legacy credentials
      else {
        const credentialType = tool.credentialType || 'cookies';

        if (credentialType === 'cookies' && tool.cookiesEncrypted) {
          currentField = 'cookiesEncrypted';
          const cookiesJson = decryptCookies(tool.cookiesEncrypted);
          currentField = 'cookiesEncrypted:json';
          credentials = {
            type: 'cookies',
            payload: JSON.parse(cookiesJson),
            selectors: {},
            successCheck: {},
            domain: tool.domain
          };
        } else if (credentialType === 'token' && tool.tokenEncrypted) {
          currentField = 'tokenEncrypted';
          const tokenValue = decryptCookies(tool.tokenEncrypted);
          credentials = {
            type: 'token',
            payload: {
              value: tokenValue,
              header: tool.tokenHeader || 'Authorization',
              prefix: tool.tokenPrefix || 'Bearer '
            },
            selectors: {},
            successCheck: {},
            domain: tool.domain,
            tokenHeader: tool.tokenHeader || 'Authorization',
            tokenPrefix: tool.tokenPrefix || 'Bearer '
          };
        } else if ((credentialType === 'localStorage' || credentialType === 'sessionStorage') && tool.localStorageEncrypted) {
          currentField = 'localStorageEncrypted';
          const storageJson = decryptCookies(tool.localStorageEncrypted);
          currentField = 'localStorageEncrypted:json';
          credentials = {
            type: credentialType,
            payload: JSON.parse(storageJson),
            selectors: {},
            successCheck: {},
            domain: tool.domain
          };
        } else if (credentialType === 'form') {
          // Form login - check if we have form data in legacy or new format
          credentials = {
            type: 'form',
            payload: {},
            selectors: {},
            successCheck: {},
            domain: tool.domain,
            loginUrl: tool.loginUrl || tool.targetUrl
          };
        } else if (credentialType === 'sso') {
          // SSO login
          credentials = {
            type: 'sso',
            payload: {},
            selectors: {},
            successCheck: {},
            domain: tool.domain,
            loginUrl: tool.loginUrl || tool.targetUrl
          };
        }
      }
    } catch (decryptError) {
      // ── Safe diagnostic: name the failing field + classify the crypto error
      // WITHOUT logging ciphertext, key, or any decrypted value.
      // Most common root causes:
      //   • COOKIES_ENCRYPTION_KEY rotated between save-time and read-time
      //     → "Unable to authenticate data" (GCM tag mismatch)
      //   • stored payload not in iv:tag:ct format → "Invalid encrypted data format"
      //   • SyntaxError → JSON.parse() of decrypted plaintext failed
      const msg = String(decryptError?.message || '');
      let cause = 'unknown';
      if (/authenticate data|unsupported state/i.test(msg)) cause = 'auth_tag_mismatch_or_key_rotated';
      else if (/Invalid encrypted data format/i.test(msg))  cause = 'bad_payload_format';
      else if (/Invalid (key|iv) length/i.test(msg))        cause = 'bad_key_or_iv_length';
      else if (decryptError instanceof SyntaxError)         cause = 'json_parse_failed';
      else if (/hex/i.test(msg))                            cause = 'non_hex_payload';

      // Non-secret sample (first 6 chars of iv hex) to confirm payload shape.
      const sample = (() => {
        try {
          const v = tool?.credentials?.payloadEncrypted
                 || tool?.cookiesEncrypted
                 || tool?.tokenEncrypted
                 || tool?.localStorageEncrypted
                 || '';
          if (typeof v !== 'string' || !v) return { length: 0, parts: 0, ivPrefix: null };
          const parts = v.split(':');
          return {
            length: v.length,
            parts: parts.length,
            ivPrefix: parts[0] ? parts[0].slice(0, 6) : null,
          };
        } catch { return { length: 0, parts: 0, ivPrefix: null }; }
      })();

      console.error('[extension/credentials] decrypt failed', {
        endpoint: req.originalUrl,
        method: req.method,
        status: 500,
        toolId: String(tool._id),
        clientId: String(req.clientId),
        toolDomain: tool.domain || null,
        toolSlug: tool.slug || tool.name || null,
        credentialType: tool.credentialType || tool?.credentials?.type || null,
        field: currentField,
        cause,
        errorName: decryptError?.name || null,
        errorMsg: msg.slice(0, 200),
        payloadSample: sample,
      });
      await CredentialAccessLog.log({
        clientId: req.clientId,
        toolId: tool._id,
        extensionTokenId: req.extensionTokenId,
        action: 'CREDENTIALS_FETCHED',
        success: false,
        errorMessage: `decrypt_failed:${cause}:${currentField}`,
        deviceInfo: {
          userAgent: req.headers['user-agent'],
          ip: req.ip,
          extensionVersion: req.headers['x-extension-version']
        }
      });
      return res.status(500).json({
        error: 'Failed to decrypt credentials',
        code: 'credential_decrypt_failed',
        cause,
        field: currentField,
      });
    }
    
    // Decrypt session bundle if available
    let sessionBundle = null;
    if (tool.sessionBundle) {
      let bundleField = null;
      try {
        sessionBundle = {
          version: tool.sessionBundle.version || 1,
          updatedAt: tool.sessionBundle.bundleUpdatedAt,
          cookies: null,
          localStorage: null,
          sessionStorage: null
        };

        if (tool.sessionBundle.cookiesEncrypted) {
          bundleField = 'sessionBundle.cookiesEncrypted';
          const cookiesJson = decryptCookies(tool.sessionBundle.cookiesEncrypted);
          sessionBundle.cookies = JSON.parse(cookiesJson);
        }
        if (tool.sessionBundle.localStorageEncrypted) {
          bundleField = 'sessionBundle.localStorageEncrypted';
          const localStorageJson = decryptCookies(tool.sessionBundle.localStorageEncrypted);
          sessionBundle.localStorage = JSON.parse(localStorageJson);
        }
        if (tool.sessionBundle.sessionStorageEncrypted) {
          bundleField = 'sessionBundle.sessionStorageEncrypted';
          const sessionStorageJson = decryptCookies(tool.sessionBundle.sessionStorageEncrypted);
          sessionBundle.sessionStorage = JSON.parse(sessionStorageJson);
        }
      } catch (bundleError) {
        // Same classification + safe sample as the credentials catch above.
        const bmsg = String(bundleError?.message || '');
        let bcause = 'unknown';
        if (/authenticate data|unsupported state/i.test(bmsg)) bcause = 'auth_tag_mismatch_or_key_rotated';
        else if (/Invalid encrypted data format/i.test(bmsg))  bcause = 'bad_payload_format';
        else if (/Invalid (key|iv) length/i.test(bmsg))        bcause = 'bad_key_or_iv_length';
        else if (bundleError instanceof SyntaxError)           bcause = 'json_parse_failed';
        else if (/hex/i.test(bmsg))                            bcause = 'non_hex_payload';
        const bsample = (() => {
          try {
            const v = tool?.sessionBundle?.cookiesEncrypted
                   || tool?.sessionBundle?.localStorageEncrypted
                   || tool?.sessionBundle?.sessionStorageEncrypted
                   || '';
            if (typeof v !== 'string' || !v) return { length: 0, parts: 0, ivPrefix: null };
            const parts = v.split(':');
            return {
              length: v.length,
              parts: parts.length,
              ivPrefix: parts[0] ? parts[0].slice(0, 6) : null,
            };
          } catch { return { length: 0, parts: 0, ivPrefix: null }; }
        })();
        console.error('[extension/credentials] session bundle decrypt failed', {
          endpoint: req.originalUrl,
          method: req.method,
          toolId: String(tool._id),
          clientId: String(req.clientId),
          toolDomain: tool.domain || null,
          toolSlug: tool.slug || tool.name || null,
          field: bundleField,
          cause: bcause,
          errorName: bundleError?.name || null,
          errorMsg: bmsg.slice(0, 200),
          payloadSample: bsample,
        });
        // Discard the partial bundle so downstream `hasAnyInjectable` flips to
        // false. This is critical: without this, a partially-failed decrypt
        // leaves an empty bundle in place and the extension falls back to
        // `direct_open` — exactly the HIX AI symptom in the report.
        sessionBundle = null;
      }
    }

    // Does this tool actually carry usable session data to inject? Auth can come
    // from EITHER the decrypted session bundle OR the unified credentials payload
    // (a cookies/token/storage tool may store its data in either place).
    const bundleHasData = !!(sessionBundle && (
      (Array.isArray(sessionBundle.cookies) && sessionBundle.cookies.length) ||
      (sessionBundle.localStorage && Object.keys(sessionBundle.localStorage).length) ||
      (sessionBundle.sessionStorage && Object.keys(sessionBundle.sessionStorage).length)
    ));
    const p = credentials?.payload;
    const credHasPayload = !!(p && (
      (Array.isArray(p) && p.length) ||
      (typeof p === 'string' && p.length) ||
      (typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length)
    ));
    const credType = credentials?.type || 'none';
    // Tools whose login is driven by injected session state (cookies/token/storage)
    // CANNOT open without SOME data to inject. form/sso/none auto-fill or
    // direct-open, so they are allowed through even with an empty bundle.
    const requiresInjectedSession = ['cookies', 'token', 'localStorage', 'sessionStorage'].includes(credType);
    const hasAnyInjectable = bundleHasData || credHasPayload;

    // Safe debug: confirm the LATEST admin session bundle is being returned to
    // the extension — COUNTS ONLY, never cookie values, tokens, or secrets.
    accessDebug('credentials', {
      clientId: req.clientId, toolId: tool._id, assignmentId: assignment._id,
      assignmentStatus: assignment.status, endDate: assignment.endDate,
      usedEndBoundary: ToolAssignment.effectiveEndBoundary(assignment.endDate)?.toISOString() || null,
      serverTime: nowTs.toISOString(),
      hasSessionBundle: bundleHasData,
      toolDomain: tool.domain || null,
      reason: requiresInjectedSession && !hasAnyInjectable ? 'bundle_required_but_empty' : 'serving_latest_bundle',
    });
    console.log('[extension/credentials] bundle detail', String(tool._id), {
      bundleVersion: sessionBundle?.version || null,
      bundleUpdatedAt: tool.sessionBundle?.bundleUpdatedAt || null,
      cookies: Array.isArray(sessionBundle?.cookies) ? sessionBundle.cookies.length : 0,
      localStorage: sessionBundle?.localStorage ? Object.keys(sessionBundle.localStorage).length : 0,
      sessionStorage: sessionBundle?.sessionStorage ? Object.keys(sessionBundle.sessionStorage).length : 0,
      credentialType: credType,
    });

    if (requiresInjectedSession && !hasAnyInjectable) {
      // Assignment is valid but admin has not (yet) saved any usable session data
      // (neither bundle nor credentials payload) for this auth-by-session tool —
      // report it precisely instead of opening a tab that would land logged-out.
      return res.status(409).json({
        error: 'Latest session for this tool is not available yet',
        code: ACCESS_CODES.SESSION_BUNDLE_MISSING,
      });
    }

    // Log successful access
    await CredentialAccessLog.log({
      clientId: req.clientId,
      toolId: tool._id,
      extensionTokenId: req.extensionTokenId,
      action: 'CREDENTIALS_FETCHED',
      credentialVersion: tool.credentialVersion,
      success: true,
      deviceInfo: {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
        extensionVersion: req.headers['x-extension-version']
      }
    });
    
    await ActivityLog.log('CLIENT', req.clientId, 'EXTENSION_CREDENTIALS_FETCH', {
      toolId: tool._id,
      toolName: tool.name,
      credentialType: credentials?.type || 'none'
    });
    
    // Build combo auth config with parallel mode
    const comboAuthConfig = tool.comboAuth ? {
      enabled: tool.comboAuth.enabled || false,
      runMode: tool.comboAuth.runMode || 'sequential',
      primaryType: tool.comboAuth.primaryType || 'sso',
      secondaryType: tool.comboAuth.secondaryType || 'form',
      fallbackEnabled: tool.comboAuth.fallbackEnabled ?? true,
      fallbackOnlyOnce: tool.comboAuth.fallbackOnlyOnce ?? true,
      skipIfLoggedIn: tool.comboAuth.skipIfLoggedIn ?? true,
      triggerOnAuto: tool.comboAuth.triggerOnAuto ?? true,
      parallelSettings: {
        prepSessionFirst: tool.comboAuth.parallelSettings?.prepSessionFirst ?? true,
        parallelTimeout: tool.comboAuth.parallelSettings?.parallelTimeout ?? 30000,
        commitLock: tool.comboAuth.parallelSettings?.commitLock ?? true,
        verifyAfterAuth: tool.comboAuth.parallelSettings?.verifyAfterAuth ?? true
      },
      // Include form and SSO configs for combo auth
      formConfig: tool.comboAuth.formConfig || {},
      ssoConfig: tool.comboAuth.ssoConfig || {},
      cookiesConfig: tool.comboAuth.cookiesConfig || {},
      tokenConfig: tool.comboAuth.tokenConfig || {},
      localStorageConfig: tool.comboAuth.localStorageConfig || {},
      sessionStorageConfig: tool.comboAuth.sessionStorageConfig || {}
    } : { enabled: false };
    
    res.json({
      success: true,
      tool: {
        id: tool._id,
        name: tool.name,
        targetUrl: tool.targetUrl,
        loginUrl: tool.loginUrl || tool.targetUrl,
        domain: tool.domain,
        credentialVersion: tool.credentialVersion,
        // Include combo auth configuration with parallel mode
        comboAuth: comboAuthConfig,
        extensionSettings: {
          ...tool.extensionSettings,
          reloadAfterLogin: tool.extensionSettings?.reloadAfterLogin ?? true,
          waitForNavigation: tool.extensionSettings?.waitForNavigation ?? true,
          spaMode: tool.extensionSettings?.spaMode ?? false,
          retryAttempts: tool.extensionSettings?.retryAttempts ?? 2,
          retryDelayMs: tool.extensionSettings?.retryDelayMs ?? 1000,
          // New hidden mode and auto-start settings
          hiddenModeEnabled: tool.extensionSettings?.hiddenModeEnabled ?? true,
          hiddenModeTimeout: tool.extensionSettings?.hiddenModeTimeout ?? 60000,
          autoStartEnabled: tool.extensionSettings?.autoStartEnabled ?? true,
          autoStartDelay: tool.extensionSettings?.autoStartDelay ?? 800,
          maxAutoAttempts: tool.extensionSettings?.maxAutoAttempts ?? 2
        }
      },
      // Session bundle with decrypted data
      sessionBundle,
      credentials: {
        ...credentials,
        // Include additional options from the tool schema
        formOptions: tool.credentials?.formOptions || {
          multiStep: false,
          rememberMe: true,
          clearFieldsFirst: true,
          submitDelay: 200
        },
        ssoOptions: tool.credentials?.ssoOptions || {
          flowType: 'redirect',
          autoClickProvider: true,
          waitForAccountChooser: true
        },
        mfaOptions: tool.credentials?.mfaOptions || {
          detectMFA: true,
          action: 'notify'
        }
      },
      fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Get credentials error:', error);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// POST /api/crm/extension/tools/:toolId/opened - Log tool opened event
router.post('/tools/:toolId/opened', verifyExtensionToken, async (req, res) => {
  try {
    const { toolId } = req.params;

    // FIX22: Validate toolId format to prevent CastError and IDOR
    if (!toolId || !/^[a-f\d]{24}$/i.test(toolId)) {
      return res.status(400).json({ error: 'Invalid tool ID format' });
    }

    if (!toolId || !/^[a-f\d]{24}$/i.test(toolId)) {
      return res.status(400).json({ error: 'Invalid tool ID format' });
    }

    await CredentialAccessLog.log({
      clientId: req.clientId,
      toolId,
      extensionTokenId: req.extensionTokenId,
      action: 'TOOL_OPENED',
      deviceInfo: {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
        extensionVersion: req.headers['x-extension-version']
      }
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Log tool opened error:', error);
    res.status(500).json({ error: 'Failed to log event' });
  }
});

// POST /api/crm/extension/tools/:toolId/login-attempt - Log login attempt result
router.post('/tools/:toolId/login-attempt', verifyExtensionToken, async (req, res) => {
  try {
    const { toolId } = req.params;

    // FIX22: Validate toolId format to prevent CastError and IDOR
    if (!toolId || !/^[a-f\d]{24}$/i.test(toolId)) {
      return res.status(400).json({ error: 'Invalid tool ID format' });
    }

    if (!toolId || !/^[a-f\d]{24}$/i.test(toolId)) {
      return res.status(400).json({ error: 'Invalid tool ID format' });
    }

    const { 
      success, 
      method, 
      duration, 
      attempts, 
      finalUrl, 
      error,
      errorCode,
      mfaDetected,
      multiStepDetected,
      requiresManualAction
    } = req.body;
    
    // Determine action based on result
    let action = 'LOGIN_STARTED';
    if (success) {
      action = 'LOGIN_SUCCESS';
    } else if (mfaDetected) {
      action = 'LOGIN_MFA_REQUIRED';
    } else if (requiresManualAction) {
      action = 'LOGIN_MANUAL_REQUIRED';
    } else if (error) {
      action = 'LOGIN_FAILED';
    }
    
    await CredentialAccessLog.log({
      clientId: req.clientId,
      toolId,
      extensionTokenId: req.extensionTokenId,
      action,
      loginAttempt: {
        method,
        duration,
        attempts,
        finalUrl: finalUrl?.substring(0, 500), // Truncate long URLs
        mfaDetected,
        multiStepDetected
      },
      success: success || false,
      errorMessage: error?.substring(0, 500), // Don't store too long errors
      errorCode,
      deviceInfo: {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
        extensionVersion: req.headers['x-extension-version'],
        browser: req.body.browser,
        os: req.body.os
      }
    });
    
    res.json({ success: true, logged: true });
  } catch (error) {
    console.error('Log login attempt error:', error);
    res.status(500).json({ error: 'Failed to log login attempt' });
  }
});

// GET /api/crm/extension/tools/:toolId/login-stats - Get login statistics for a tool
router.get('/tools/:toolId/login-stats', verifyExtensionToken, async (req, res) => {
  try {
    const { toolId } = req.params;

    // FIX22: Validate toolId format to prevent CastError and IDOR
    if (!toolId || !/^[a-f\d]{24}$/i.test(toolId)) {
      return res.status(400).json({ error: 'Invalid tool ID format' });
    }
    const days = parseInt(req.query.days) || 30;
    
    const stats = await CredentialAccessLog.getToolLoginStats(toolId, days);
    
    res.json({
      success: true,
      stats,
      period: `${days} days`
    });
  } catch (error) {
    console.error('Get login stats error:', error);
    res.status(500).json({ error: 'Failed to fetch login stats' });
  }
});

// POST /api/crm/extension/debug-log - Submit debug logs from extension
router.post('/debug-log', verifyExtensionToken, async (req, res) => {
  try {
    const { logs, context } = req.body;
    
    // Only log in development or if explicitly enabled
    if (process.env.NODE_ENV === 'development' || process.env.ENABLE_EXTENSION_DEBUG_LOGS === 'true') {
      console.log(`[Extension Debug] Client: ${req.clientId}`, {
        context,
        logsCount: logs?.length || 0
      });
      
      // Could store in a separate collection if needed for analysis
    }
    
    res.json({ success: true, received: true });
  } catch (error) {
    console.error('Debug log error:', error);
    res.status(500).json({ error: 'Failed to process debug logs' });
  }
});

// GET /api/crm/extension/tools/:toolId/_diagnose — non-secret tool diagnosis
// Returns ONLY metadata + a 1-byte trial-decrypt result so admin can confirm:
//   • the tool's configured credentialType / credentials.type
//   • which encrypted fields exist (booleans)
//   • whether each encrypted field decrypts with the CURRENT COOKIES_ENCRYPTION_KEY
//   • a cause classification if decrypt fails
// NEVER returns cookie values, decrypted plaintext, or the encryption key.
router.get('/tools/:toolId/_diagnose', verifyExtensionToken, async (req, res) => {
  try {
    const { toolId } = req.params;
    if (!toolId || !/^[a-f\d]{24}$/i.test(toolId)) {
      return res.status(400).json({ error: 'Invalid tool ID format' });
    }
    const decision = await getClientAccessibleTool(req.clientId, toolId);
    if (!decision.ok) {
      return res.status(403).json({ error: 'Tool not assigned or expired', code: decision.code || null });
    }
    const tool = decision.assignment.toolId;
    if (!tool) return res.status(404).json({ error: 'Tool not found' });

    const classify = (err) => {
      const m = String(err?.message || '');
      if (/authenticate data|unsupported state/i.test(m)) return 'auth_tag_mismatch_or_key_rotated';
      if (/Invalid encrypted data format/i.test(m))       return 'bad_payload_format';
      if (/Invalid (key|iv) length/i.test(m))             return 'bad_key_or_iv_length';
      if (err instanceof SyntaxError)                     return 'json_parse_failed';
      if (/hex/i.test(m))                                 return 'non_hex_payload';
      return 'unknown';
    };
    const tryDecrypt = (label, val) => {
      if (typeof val !== 'string' || !val) return { present: false };
      const parts = val.split(':');
      const shape = { present: true, length: val.length, parts: parts.length, ivPrefix: parts[0]?.slice(0, 6) || null };
      try {
        const out = decryptCookies(val);
        let jsonOk = null;
        try { JSON.parse(out); jsonOk = true; } catch { jsonOk = false; }
        return { ...shape, decryptsOk: true, looksLikeJson: jsonOk, plaintextLength: out.length };
      } catch (e) {
        return { ...shape, decryptsOk: false, cause: classify(e), errorName: e?.name || null };
      }
    };

    return res.json({
      success: true,
      toolId: String(tool._id),
      slug: tool.slug || null,
      name: tool.name || null,
      domain: tool.domain || null,
      targetUrl: tool.targetUrl || tool.loginUrl || null,
      status: tool.status || null,
      credentialType: tool.credentialType || null,
      credentialsTypeNew: tool?.credentials?.type || null,
      credentialVersion: tool.credentialVersion || null,
      sessionBundleVersion: tool?.sessionBundle?.version || null,
      sessionBundleUpdatedAt: tool?.sessionBundle?.bundleUpdatedAt || null,
      fields: {
        'credentials.payloadEncrypted':         tryDecrypt('credentials.payloadEncrypted', tool?.credentials?.payloadEncrypted),
        'cookiesEncrypted':                     tryDecrypt('cookiesEncrypted', tool?.cookiesEncrypted),
        'tokenEncrypted':                       tryDecrypt('tokenEncrypted', tool?.tokenEncrypted),
        'localStorageEncrypted':                tryDecrypt('localStorageEncrypted', tool?.localStorageEncrypted),
        'sessionBundle.cookiesEncrypted':       tryDecrypt('sessionBundle.cookiesEncrypted', tool?.sessionBundle?.cookiesEncrypted),
        'sessionBundle.localStorageEncrypted':  tryDecrypt('sessionBundle.localStorageEncrypted', tool?.sessionBundle?.localStorageEncrypted),
        'sessionBundle.sessionStorageEncrypted':tryDecrypt('sessionBundle.sessionStorageEncrypted', tool?.sessionBundle?.sessionStorageEncrypted),
      },
      assignment: {
        id: String(decision.assignment._id),
        status: decision.assignment.status,
        endDate: decision.assignment.endDate,
      },
    });
  } catch (err) {
    console.error('[extension/diagnose] error', err.message);
    res.status(500).json({ error: 'Diagnose failed' });
  }
});



// GET /api/crm/extension/domains - Get list of all tool domains for permissions
router.get('/domains', verifyExtensionToken, async (req, res) => {
  try {
    // Get domains from client's assigned tools only
    const assignments = await ToolAssignment.find({
      clientId: req.clientId,
      status: 'active'
    }).populate('toolId', 'domain');
    
    const domains = [...new Set(
      assignments
        .filter(a => a.toolId && a.toolId.domain)
        .map(a => a.toolId.domain)
    )];
    
    res.json({ 
      success: true,
      domains 
    });
  } catch (error) {
    console.error('Get domains error:', error);
    res.status(500).json({ error: 'Failed to fetch domains' });
  }
});

// GET /api/crm/extension/profile - Get client profile
router.get('/profile', verifyExtensionToken, async (req, res) => {
  try {
    const user = await User.findById(req.clientId).select('email fullName company createdAt');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get token info
    const token = await ExtensionToken.findById(req.extensionTokenId);
    
    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        name: user.fullName,
        company: user.company
      },
      token: {
        expiresAt: token?.expiresAt,
        lastUsedAt: token?.lastUsedAt
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// GET /api/crm/extension/cleanup-manifest — authoritative per-tool session
// cleanup directive for this client.
//
// Returns BOTH:
//   active[]  — tools whose assignment is currently valid (must NOT be cleaned),
//   revoked[] — tools the client was assigned but that are now expired, revoked,
//               blocked, or whose Tool was deactivated/removed (MUST be cleaned).
//
// Each entry carries a per-tool `cleanup` config (tool_code, domains,
// cookieDomains, localStorageOrigins, tabUrlPatterns) derived from the tool's own
// domain — so the extension knows EXACTLY which cookies/storage/tabs to wipe and
// never touches unrelated tools or personal sites. The extension treats this as
// the source of truth: anything in `revoked`, plus any locally-known tool no
// longer present in `active`, gets its browser session cleared immediately.
//
// Privacy: returns hostname/pattern metadata + assignment status only — never
// cookies, tokens, sessions, or any secret value.
router.get('/cleanup-manifest', verifyExtensionToken, async (req, res) => {
  try {
    // Flip any newly-past assignments to 'expired' first so classification below
    // matches the credentials/open gate exactly.
    await ToolAssignment.updateExpiredAssignments();

    // ALL assignments for this client, every status — we need the invalid ones.
    const assignments = await ToolAssignment.find({ clientId: req.clientId }).populate('toolId');
    const now = new Date();

    // Per tool: keep the "best" row. A tool is ACTIVE if ANY of its assignments
    // is currently valid; otherwise it is reported in `revoked` with the reason
    // from its most-recent invalid row.
    const activeByTool = new Map();   // toolId -> { tool, assignment }
    const invalidByTool = new Map();  // toolId -> { tool, assignment, reason, status }

    for (const a of assignments || []) {
      const tool = a && a.toolId;
      if (!tool) continue; // assignment with a hard-deleted tool — nothing to scope
      const toolKey = String(tool._id || tool);

      const toolRemoved   = tool.status !== 'active';
      const notStarted    = a.startDate && new Date(a.startDate) > now;
      const expired       = ToolAssignment.isAssignmentExpired(a, now);
      const revoked       = a.status === 'revoked';
      const inactiveRow   = a.status !== 'active'; // expired/revoked/other

      const isValid = a.status === 'active' && !notStarted && !expired && !toolRemoved;

      if (isValid) {
        // Latest valid boundary wins (mirror getClientAccessibleTool dedup).
        const prev = activeByTool.get(toolKey);
        const ab = ToolAssignment.effectiveEndBoundary(a.endDate)?.getTime() ?? Number.POSITIVE_INFINITY;
        const pb = prev ? (ToolAssignment.effectiveEndBoundary(prev.assignment.endDate)?.getTime() ?? Number.POSITIVE_INFINITY) : -1;
        if (!prev || ab > pb) activeByTool.set(toolKey, { tool, assignment: a });
        continue;
      }

      // Invalid row — record a precise reason (revoked > tool_removed > expired).
      let reason = 'expired';
      let status = 'expired';
      if (revoked)            { reason = 'revoked';      status = 'revoked'; }
      else if (toolRemoved)   { reason = 'tool_removed'; status = 'removed'; }
      else if (expired || inactiveRow) { reason = 'expired'; status = 'expired'; }
      const prevInv = invalidByTool.get(toolKey);
      // Prefer the most recently-updated invalid row for the reason.
      const at = new Date(a.revokedAt || a.updatedAt || a.endDate || 0).getTime();
      const pt = prevInv ? new Date(prevInv.assignment.revokedAt || prevInv.assignment.updatedAt || prevInv.assignment.endDate || 0).getTime() : -1;
      if (!prevInv || at >= pt) invalidByTool.set(toolKey, { tool, assignment: a, reason, status });
    }

    const active = [];
    for (const [toolKey, { tool, assignment }] of activeByTool) {
      const cleanup = buildToolCleanupConfig(tool);
      if (!cleanup) continue;
      active.push({
        toolId: toolKey,
        toolCode: cleanup.tool_code,
        tool_code: cleanup.tool_code,
        name: tool.name || cleanup.name,
        access_mode: getToolAccessMode(tool),
        status: 'active',
        endDate: assignment.endDate || null,
        expiry_date: assignment.endDate || null,
        is_expired: false,
        cleanup,
      });
    }

    const revoked = [];
    for (const [toolKey, info] of invalidByTool) {
      if (activeByTool.has(toolKey)) continue; // a still-valid row wins — never clean
      const cleanup = buildToolCleanupConfig(info.tool);
      if (!cleanup) continue;
      const isExpired = ToolAssignment.isAssignmentExpired(info.assignment, now);
      revoked.push({
        toolId: toolKey,
        toolCode: cleanup.tool_code,
        tool_code: cleanup.tool_code,
        name: info.tool.name || cleanup.name,
        access_mode: getToolAccessMode(info.tool),
        status: info.status,
        reason: info.reason,
        endDate: info.assignment.endDate || null,
        expiry_date: info.assignment.endDate || null,
        is_expired: isExpired,
        cleanup,
      });
    }

    res.json({
      success: true,
      accountActive: req.client?.status !== 'disabled',
      active,
      revoked,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Cleanup manifest error:', error);
    res.status(500).json({ error: 'Failed to build cleanup manifest' });
  }
});

module.exports = router;


// ─── POST /api/crm/extension/security-scan — submit extension scanner report ──
// The client-side scanner (with explicit user consent) sends safe metadata about
// installed browser extensions. We never receive cookie values, browsing history,
// or any other personal data. Only extension metadata is accepted.
// Privacy: disclosed in privacy policy. Scanner can be disabled by admin.
router.post('/security-scan', verifyExtensionToken, async (req, res) => {
  try {
    const {
      extensions = [],
      riskyExtensions = [],
      userConsentGiven,
      scannerEnabled,
      scannerStatus,
      deviceIdHash,
      lastSync,
      scannedAt,
    } = req.body;

    // Respect scanner-disabled flag
    if (scannerEnabled === false) {
      return res.json({ success: true, skipped: true });
    }

    // Require explicit user consent
    if (!userConsentGiven) {
      return res.json({ success: true, skipped: true, reason: 'consent_not_given' });
    }

    // Sanitize the FULL installed list — only safe metadata fields, never secrets.
    const cleanExt = (e) => ({
      extId:              String(e.extId  || '').slice(0, 64),
      extName:            String(e.extName || 'Unknown').slice(0, 128),
      version:            e.version ? String(e.version).slice(0, 32) : null,
      enabled:            e.enabled !== false,
      type:               String(e.type || 'extension').slice(0, 32),
      permissionsSummary: String(e.permissionsSummary || '').slice(0, 256),
      riskLevel:          ['none','low','medium','high'].includes(e.riskLevel) ? e.riskLevel : 'none',
    });
    const sanitizedAll = (Array.isArray(extensions) ? extensions : []).slice(0, 100).map(cleanExt);
    // Prefer the full list to derive the risky subset; fall back to riskyExtensions.
    const sanitizedRisky = (sanitizedAll.length
      ? sanitizedAll.filter(e => e.riskLevel !== 'none')
      : (Array.isArray(riskyExtensions) ? riskyExtensions : []).slice(0, 100).map(cleanExt)
    );

    const counts = {
      total:  sanitizedAll.length,
      risky:  sanitizedRisky.length,
      high:   sanitizedRisky.filter(e => e.riskLevel === 'high').length,
      medium: sanitizedRisky.filter(e => e.riskLevel === 'medium').length,
      low:    sanitizedRisky.filter(e => e.riskLevel === 'low').length,
    };

    const extensionVersion = req.headers['x-extension-version'] || req.body.extensionVersion || null;
    const status = ['enabled', 'disabled', 'permission_missing'].includes(scannerStatus) ? scannerStatus : 'enabled';

    // Authoritative client identity from the user record (token-bound) — fall back
    // to body values only if the record lacks them.
    let clientEmail = req.body.clientEmail || null;
    let clientName  = req.body.clientName  || null;
    try {
      const user = await User.findById(req.clientId).lean?.() || await User.findById(req.clientId);
      if (user) {
        clientEmail = user.email || clientEmail;
        clientName  = user.fullName || user.name || clientName;
      }
    } catch (_) {}

    // Persist the latest scan for this client (one row per client).
    await ExtensionScan.recordScan(req.clientId, {
      clientEmail,
      clientName,
      deviceIdHash:     deviceIdHash || req.headers['x-device-id-hash'] || null,
      extensionVersion,
      lastSync:         lastSync || null,
      scannedAt:        scannedAt || new Date().toISOString(),
      scannerStatus:    status,
      counts,
      extensions:       sanitizedAll,
    });

    // Still raise a high-risk SecurityAlert (existing behaviour).
    const context = {
      ipAddress:        req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim(),
      userAgent:        req.headers['user-agent'],
      extensionVersion,
      deviceIdHash:     deviceIdHash || req.headers['x-device-id-hash'] || null,
    };
    if (sanitizedRisky.length) {
      await processExtensionScanReport(req.clientId, sanitizedRisky, context);
    }

    await ActivityLog.log('CLIENT', req.clientId, 'EXTENSION_SCAN_SUBMITTED', {
      totalScanned: counts.total,
      riskyCount:   counts.risky,
      highRiskCount: counts.high,
      scannerStatus: status,
    });

    res.json({ success: true, processed: counts.total, risky: counts.risky });
  } catch (err) {
    console.error('Security scan error:', err);
    res.status(500).json({ error: 'Scan submission failed' });
  }
});

// ─── GET /api/crm/extension/security-settings — scanner config for extension ─
router.get('/security-settings', verifyExtensionToken, async (req, res) => {
  try {
    // In future this can be per-client or per-admin config
    // For now return global defaults
    res.json({
      scannerEnabled:    true,
      requireConsent:    true,
      scanIntervalMins:  60,
      disclosureText:    'Gen Z Digital Store may scan installed browser extensions for security risk indicators (e.g. cookie access permissions). Only extension names, IDs, and permission summaries are shared — no personal data, browsing history, or cookie values. You can opt out at any time.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get security settings' });
  }
});

