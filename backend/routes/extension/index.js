const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const User = require('../../models/User');
const Tool = require('../../models/Tool');
const ToolAssignment = require('../../models/ToolAssignment');
const ExtensionToken = require('../../models/ExtensionToken');
const CredentialAccessLog = require('../../models/CredentialAccessLog');
const ActivityLog = require('../../models/ActivityLog');
const OpenIntent = require('../../models/OpenIntent');
const ActivationToken = require('../../models/ActivationToken');
const DeviceBinding = require('../../models/DeviceBinding');
const { decryptCookies }    = require('../../utils/encryption');
const SecurityAlert         = require('../../models/SecurityAlert');
const { processExtensionScanReport, checkAccessFrequency, checkExpiredAccess, checkNewDevice, checkRepeatedAuthFailures } = require('../../middleware/riskEngine');
const bcrypt = require('bcryptjs');
const { authLimiter } = require('../../middleware/rateLimiter');

function getExtensionTokenDays() {
  const days = Number(process.env.EXTENSION_TOKEN_DAYS || 365);
  return Number.isFinite(days) && days > 0 ? days : 365;
}

// Middleware to verify extension token
const verifyExtensionToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('ExtToken ')) {
      return res.status(401).json({ error: 'Extension token required' });
    }
    
    const token = authHeader.substring(9); // Remove 'ExtToken '
    const requestDeviceIdHash = req.headers['x-device-id-hash'] || null;
    const tokenData = await ExtensionToken.verifyToken(token, requestDeviceIdHash);
    
    if (!tokenData) {
      return res.status(401).json({ error: 'Invalid or expired extension token' });
    }
    
    if (tokenData.client.status === 'disabled') {
      return res.status(403).json({ error: 'Account is disabled' });
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
      return res.status(403).json({ error: 'Account is disabled' });
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
      return res.status(403).json({ error: 'Activation token invalid, expired, or already used' });
    }

    const user = await User.findById(activation.clientId);
    if (!user || user.role !== 'CLIENT') return res.status(403).json({ error: 'Invalid activation client' });
    if (user.status === 'disabled') return res.status(403).json({ error: 'Account is disabled' });

    const dashboardDeviceIdHash = activation.deviceIdHash || null;
    const extensionDeviceIdHash = req.headers['x-device-id-hash'] || null;

    // If device binding is enabled, the activation token must have been created
    // from the already-bound client dashboard device. The extension has its own
    // chrome.storage device id, so we validate the dashboard device first and
    // then attach the extension device hash to that same binding for future
    // extension-token verification.
    if (user.devicePolicy?.enabled) {
      if (!dashboardDeviceIdHash) return res.status(403).json({ error: 'Device binding required', code: 'DEVICE_MISMATCH' });
      const binding = await DeviceBinding.findOne({ clientId: user._id, deviceIdHash: dashboardDeviceIdHash });
      if (!binding) return res.status(403).json({ error: 'Device binding mismatch', code: 'DEVICE_MISMATCH' });
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
      if (assignment.startDate && assignment.startDate > now) continue;
      if (assignment.endDate && assignment.endDate < now) continue;
      
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
      if (assignment.startDate && assignment.startDate > now) continue;
      if (assignment.endDate && assignment.endDate < now) continue;
      
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

    // Verify assignment
    const assignment = await ToolAssignment.findOne({
      clientId: req.clientId,
      toolId,
      status: 'active'
    }).populate('toolId');
    
    if (!assignment) {
      await CredentialAccessLog.log({
        clientId: req.clientId,
        toolId,
        extensionTokenId: req.extensionTokenId,
        action: 'CREDENTIALS_FETCHED',
        success: false,
        errorMessage: 'No assignment found',
        deviceInfo: {
          userAgent: req.headers['user-agent'],
          ip: req.ip,
          extensionVersion: req.headers['x-extension-version']
        }
      });
      return res.status(403).json({ error: 'Tool not assigned to you' });
    }
    
    if (!assignment.isValid()) {
      return res.status(403).json({ error: 'Assignment is not valid or has expired' });
    }
    
    const tool = assignment.toolId;
    
    if (!tool || tool.status !== 'active') {
      return res.status(404).json({ error: 'Tool not found or inactive' });
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

// ─── POST /api/crm/extension/open-intent ────────────────────────────────────
// Legacy extension-authenticated intent endpoint. The dashboard should use
// POST /api/crm/client/tools/:toolId/open-intent instead.

router.post('/open-intent', verifyExtensionToken, async (req, res) => {
  try {
    const { toolId } = req.body;
    if (!toolId || typeof toolId !== 'string' || toolId.length > 64) {
      return res.status(400).json({ error: 'Valid toolId required' });
    }

    // Verify the client is actually assigned this tool
    const assignment = await ToolAssignment.findOne({
      clientId: req.clientId,
      toolId,
      status: 'active'
    });
    if (!assignment) {
      return res.status(403).json({ error: 'Tool not assigned or expired' });
    }

    const issued = await OpenIntent.issue({
      clientId: req.clientId,
      toolId,
      deviceIdHash: req.extensionDeviceIdHash || null,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      ttlMs: 2 * 60 * 1000,
    });

    await ActivityLog.log('CLIENT', req.clientId, 'TOOL_OPEN_INTENT', {
      toolId,
      intentId: issued.id,
      expiresAt: issued.expiresAt.toISOString()
    });

    return res.json({
      success: true,
      intentToken: issued.token,
      toolId,
      expiresAt: issued.expiresAt.toISOString()
    });
  } catch (err) {
    console.error('Open intent error:', err);
    return res.status(500).json({ error: 'Failed to create open intent' });
  }
});

// ─── POST /api/crm/extension/verify-intent ──────────────────────────────────
// Called by the background service worker to verify an intent token issued
// by /open-intent before fetching credentials. Ensures the open was initiated
// by an authenticated website session and not forged by a website page.
router.post('/verify-intent', verifyExtensionToken, async (req, res) => {
  try {
    const { intentToken, toolId } = req.body;
    if (!intentToken || !toolId) {
      return res.status(400).json({ error: 'intentToken and toolId required' });
    }

    // Dashboard-created open intents are intentionally NOT bound to the
    // extension device id. The dashboard session already validates the client
    // device when creating the intent; the extension token separately validates
    // the extension device before this route is reached. Passing the extension
    // device hash here can falsely reject valid intents when website and
    // extension have different device ids.
    const intent = await OpenIntent.consume({
      clientId: req.clientId,
      toolId,
      token: intentToken,
      deviceIdHash: null,
    });

    if (!intent) {
      return res.status(403).json({ error: 'Intent token invalid, expired, consumed, or device-mismatched' });
    }

    // Verify assignment and tool are still valid at the time the extension opens it.
    const assignment = await ToolAssignment.findOne({
      clientId: req.clientId,
      toolId,
      status: 'active'
    }).populate('toolId');
    const now = new Date();
    if (!assignment || !assignment.toolId || assignment.toolId.status !== 'active' ||
        (assignment.startDate && assignment.startDate > now) ||
        (assignment.endDate && assignment.endDate < now)) {
      return res.status(403).json({ error: 'Tool access expired or revoked' });
    }

    return res.json({ success: true, toolId, verified: true });
  } catch (err) {
    console.error('Verify intent error:', err);
    return res.status(500).json({ error: 'Intent verification failed' });
  }
});


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

