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
const { decryptCookies }    = require('../../utils/encryption');
const SecurityAlert         = require('../../models/SecurityAlert');
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
    }).populate('toolId', '_id credentialVersion credentialUpdatedAt');
    
    const now = new Date();
    const versions = {};
    
    for (const assignment of assignments) {
      if (!assignment.toolId) continue;
      if (assignment.startDate && new Date(assignment.startDate) > now) continue;
      if (ToolAssignment.isAssignmentExpired(assignment, now)) continue; // end-of-day inclusive

      versions[assignment.toolId._id] = {
        version: assignment.toolId.credentialVersion || 1,
        updatedAt: assignment.toolId.credentialUpdatedAt
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
    
    try {
      // Check for new unified credentials first
      if (tool.credentials && tool.credentials.type && tool.credentials.payloadEncrypted) {
        const payloadJson = decryptCookies(tool.credentials.payloadEncrypted);
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
          const cookiesJson = decryptCookies(tool.cookiesEncrypted);
          credentials = {
            type: 'cookies',
            payload: JSON.parse(cookiesJson),
            selectors: {},
            successCheck: {},
            domain: tool.domain
          };
        } else if (credentialType === 'token' && tool.tokenEncrypted) {
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
          const storageJson = decryptCookies(tool.localStorageEncrypted);
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
      console.error('Credential decryption error:', decryptError);
      return res.status(500).json({ error: 'Failed to decrypt credentials' });
    }
    
    // Decrypt session bundle if available
    let sessionBundle = null;
    if (tool.sessionBundle) {
      try {
        sessionBundle = {
          version: tool.sessionBundle.version || 1,
          updatedAt: tool.sessionBundle.bundleUpdatedAt,
          cookies: null,
          localStorage: null,
          sessionStorage: null
        };
        
        if (tool.sessionBundle.cookiesEncrypted) {
          const cookiesJson = decryptCookies(tool.sessionBundle.cookiesEncrypted);
          sessionBundle.cookies = JSON.parse(cookiesJson);
        }
        if (tool.sessionBundle.localStorageEncrypted) {
          const localStorageJson = decryptCookies(tool.sessionBundle.localStorageEncrypted);
          sessionBundle.localStorage = JSON.parse(localStorageJson);
        }
        if (tool.sessionBundle.sessionStorageEncrypted) {
          const sessionStorageJson = decryptCookies(tool.sessionBundle.sessionStorageEncrypted);
          sessionBundle.sessionStorage = JSON.parse(sessionStorageJson);
        }
      } catch (bundleError) {
        console.error('Session bundle decryption error:', bundleError);
        // Continue without session bundle
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

module.exports = router;


// ─── POST /api/crm/extension/security-scan — submit extension scanner report ──
// The client-side scanner (with explicit user consent) sends safe metadata about
// installed browser extensions. We never receive cookie values, browsing history,
// or any other personal data. Only extension metadata is accepted.
// Privacy: disclosed in privacy policy. Scanner can be disabled by admin.
router.post('/security-scan', verifyExtensionToken, async (req, res) => {
  try {
    const { riskyExtensions = [], userConsentGiven, scannerEnabled } = req.body;

    // Respect scanner-disabled flag
    if (scannerEnabled === false) {
      return res.json({ success: true, skipped: true });
    }

    // Require explicit user consent
    if (!userConsentGiven) {
      return res.json({ success: true, skipped: true, reason: 'consent_not_given' });
    }

    // Validate input — only accept safe metadata fields
    const sanitized = (Array.isArray(riskyExtensions) ? riskyExtensions : [])
      .slice(0, 50) // max 50 extensions
      .map(e => ({
        extId:             String(e.extId  || '').slice(0, 64),
        extName:           String(e.extName || 'Unknown').slice(0, 128),
        riskLevel:         ['low','medium','high'].includes(e.riskLevel) ? e.riskLevel : 'low',
        permissionsSummary: String(e.permissionsSummary || '').slice(0, 256),
      }));

    const context = {
      ipAddress:        req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim(),
      userAgent:        req.headers['user-agent'],
      extensionVersion: req.headers['x-extension-version'],
    };

    await processExtensionScanReport(req.clientId, sanitized, context);

    await ActivityLog.log('CLIENT', req.clientId, 'EXTENSION_SCAN_SUBMITTED', {
      totalScanned: sanitized.length,
      highRiskCount: sanitized.filter(e => e.riskLevel === 'high').length,
    });

    res.json({ success: true, processed: sanitized.length });
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

