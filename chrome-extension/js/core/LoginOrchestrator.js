/**
 * Login Orchestrator v2.0 - Unified Login Flow Controller
 * 
 * This is the BRAIN of the auto-login system.
 * Enhanced with:
 * - Combo Auth support (SSO + Form in one tool with fallback)
 * - Auto-start mode (?auto=1 trigger)
 * - Hidden mode (?hidden=1 for invisible login)
 * - "Logging in... Cancel" overlay injection
 * - MFA detection with graceful halt
 * 
 * Flow:
 * 1. Parse URL params (auto=1, hidden=1)
 * 2. Check if already logged in → success → done
 * 3. If Combo Auth enabled, execute primary → fallback if needed
 * 4. Otherwise, try strategies in order: session → form → sso
 * 5. If hidden mode, redirect main tab on success
 */

import { Logger } from './Logger.js';
import { SuccessDetector } from './SuccessDetector.js';

// Orchestrator configuration
const ORCHESTRATOR_CONFIG = {
  maxRetries: 3,
  retryDelayMs: 1000,
  backoffMultiplier: 1.5,
  maxRetryDelay: 8000,
  successCheckDelayMs: 1500,
  pageLoadTimeoutMs: 15000,
  formFillDelayMs: 800,  // Delay before auto-fill
  postSubmitWaitMs: 3000,
  hiddenModeTimeout: 60000  // 60 seconds for hidden mode
};

/**
 * Login Orchestrator Class
 */
export class LoginOrchestrator {
  constructor() {
    this.logger = new Logger('Orchestrator');
    this.successDetector = new SuccessDetector();
    this.activeFlows = new Map();
    this.flowResults = new Map();
    this.cancelledFlows = new Set();
  }

  /**
   * Execute one-click login for a tool
   * Main entry point - handles all modes (normal, auto, hidden, combo)
   * 
   * @param {Object} tool - Tool configuration
   * @param {Object} credentials - Credentials from API
   * @param {Object} options - Additional options (auto, hidden, sourceTabId)
   * @returns {Promise<Object>} Login result
   */
  async executeLogin(tool, credentials, options = {}) {
    const flowId = `${tool.id}_${Date.now()}`;
    
    // Parse options
    const isAutoMode = options.auto === true;
    const isHiddenMode = options.hidden === true;
    const sourceTabId = options.sourceTabId;
    const comboAuth = tool.comboAuth || {};
    
    this.logger.info('Starting login flow', { 
      flowId, 
      tool: tool.name, 
      credentialType: credentials?.type,
      isAutoMode,
      isHiddenMode,
      comboAuthEnabled: comboAuth.enabled
    });

    // Track active flow
    this.activeFlows.set(flowId, {
      tool,
      credentials,
      startTime: Date.now(),
      status: 'starting',
      isAutoMode,
      isHiddenMode,
      sourceTabId
    });

    const result = {
      success: false,
      flowId,
      tool: tool.name,
      method: null,
      attempts: 0,
      errors: [],
      finalUrl: null,
      tabId: null,
      requiresManualAction: false,
      manualActionReason: null
    };

    try {
      // Check if should trigger based on settings
      if (comboAuth.triggerOnAuto && isAutoMode === false) {
        this.logger.info('Combo auth configured for auto trigger only, skipping');
        // Just open the tool normally
        const tab = await chrome.tabs.create({ url: tool.targetUrl, active: true });
        result.tabId = tab.id;
        result.finalUrl = tool.targetUrl;
        result.method = 'direct_open';
        this.completeFlow(flowId, result);
        return result;
      }

      // STEP 1: Check if already logged in
      this.logger.debug('Step 1: Checking if already logged in');
      const alreadyLoggedIn = await this.checkAlreadyLoggedIn(tool, credentials);
      
      if (alreadyLoggedIn.success) {
        this.logger.info('Already logged in, opening target URL');
        
        if (isHiddenMode && sourceTabId) {
          // Redirect the source tab to the target URL
          await chrome.tabs.update(sourceTabId, { url: tool.targetUrl });
          result.tabId = sourceTabId;
        } else {
          const tab = await chrome.tabs.create({ url: tool.targetUrl, active: true });
          result.tabId = tab.id;
        }
        
        result.success = true;
        result.method = 'already_logged_in';
        result.finalUrl = tool.targetUrl;
        
        this.completeFlow(flowId, result);
        return result;
      }

      // STEP 2: Execute login based on mode
      let loginResult;
      
      if (comboAuth.enabled) {
        // Combo Auth mode - try primary then fallback
        loginResult = await this.executeComboAuth(tool, credentials, options, flowId);
      } else {
        // Standard mode - single strategy
        loginResult = await this.executeStandardLogin(tool, credentials, options, flowId);
      }
      
      // Merge results
      Object.assign(result, loginResult);

      // STEP 3: Handle hidden mode success
      if (result.success && isHiddenMode && sourceTabId && result.tabId !== sourceTabId) {
        // Redirect source tab to final URL and close hidden tab
        await chrome.tabs.update(sourceTabId, { url: result.finalUrl || tool.targetUrl });
        if (result.tabId) {
          await chrome.tabs.remove(result.tabId).catch(() => {});
        }
        result.tabId = sourceTabId;
      }

    } catch (error) {
      this.logger.error('Orchestrator error', { error: error.message });
      result.error = `Login failed: ${error.message}`;
      result.errors.push({ method: 'orchestrator', error: error.message });
    }

    this.completeFlow(flowId, result);
    return result;
  }

  /**
   * Check and fetch latest session bundle from server
   * Auto-syncs when admin updates cookies/storage
   */
  async checkAndFetchLatestSessionBundle(tool, options) {
    try {
      // Get cached version
      const cachedVersion = await this.getCachedBundleVersion(tool.id);
      
      // Check current version from tool info
      const serverVersion = tool.sessionBundle?.version || 
                           options.sessionBundle?.version || 0;
      
      this.logger.info('Checking session bundle version', { 
        toolId: tool.id,
        cachedVersion, 
        serverVersion 
      });

      // If server has newer version, fetch and apply
      if (serverVersion > cachedVersion) {
        this.logger.info('Session bundle updated! Fetching latest...', {
          oldVersion: cachedVersion,
          newVersion: serverVersion
        });

        // Session bundle should already be in options from credentials fetch
        if (options.sessionBundle) {
          // Cache the new version
          await this.setCachedBundleVersion(tool.id, serverVersion);
          
          return {
            updated: true,
            sessionBundle: options.sessionBundle,
            version: serverVersion
          };
        }
      }

      return {
        updated: false,
        sessionBundle: options.sessionBundle || null,
        version: serverVersion
      };
    } catch (error) {
      this.logger.error('Failed to check session bundle update', error);
      return { updated: false, error: error.message };
    }
  }

  /**
   * Cache session bundle version
   */
  async getCachedBundleVersion(toolId) {
    try {
      const key = `sessionBundle_v_${toolId}`;
      const data = await chrome.storage.local.get([key]);
      return data[key] || 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Set cached session bundle version
   */
  async setCachedBundleVersion(toolId, version) {
    try {
      const key = `sessionBundle_v_${toolId}`;
      await chrome.storage.local.set({ [key]: version });
    } catch (e) {
      this.logger.warn('Failed to cache bundle version', e);
    }
  }

  /**
   * Execute Combo Auth - Supports both Sequential and Parallel modes
   * 
   * Sequential: Primary -> Fallback (existing behavior)
   * Parallel: Apply session bundle first, then run both auth methods simultaneously
   */
  async executeComboAuth(tool, credentials, options, flowId) {
    const comboAuth = tool.comboAuth;
    const runMode = comboAuth.runMode || 'sequential';
    const primaryType = comboAuth.primaryType || comboAuth.primary || 'sso';
    const secondaryType = comboAuth.secondaryType || (primaryType === 'sso' ? 'form' : 'sso');
    const fallbackEnabled = comboAuth.fallbackEnabled !== false;
    const fallbackOnlyOnce = comboAuth.fallbackOnlyOnce !== false;
    const skipIfLoggedIn = comboAuth.skipIfLoggedIn !== false;
    
    this.logger.info('Executing Combo Auth', { 
      runMode, 
      primaryType, 
      secondaryType, 
      fallbackEnabled,
      skipIfLoggedIn
    });

    // AUTO-SYNC: Check for session bundle updates from admin
    const bundleCheck = await this.checkAndFetchLatestSessionBundle(tool, options);
    if (bundleCheck.updated) {
      this.logger.info('Session bundle auto-synced from admin update', {
        version: bundleCheck.version
      });
      // Update options with latest session bundle
      options.sessionBundle = bundleCheck.sessionBundle;
    }

    // Check if already logged in (if skipIfLoggedIn is true)
    if (skipIfLoggedIn) {
      const alreadyLoggedIn = await this.checkAlreadyLoggedIn(tool, credentials);
      if (alreadyLoggedIn.success) {
        this.logger.info('Already logged in, skipping auth');
        const tab = await chrome.tabs.create({ url: tool.targetUrl, active: true });
        return {
          success: true,
          method: 'already_logged_in',
          tabId: tab.id,
          finalUrl: tool.targetUrl,
          attempts: 0,
          errors: []
        };
      }
    }

    // Route to appropriate mode handler
    if (runMode === 'parallel') {
      return this.executeParallelComboAuth(tool, credentials, options, flowId);
    } else {
      return this.executeSequentialComboAuth(tool, credentials, options, flowId);
    }
  }

  /**
   * Execute Sequential Combo Auth - Primary then Fallback
   */
  async executeSequentialComboAuth(tool, credentials, options, flowId) {
    const comboAuth = tool.comboAuth;
    const primaryType = comboAuth.primaryType || comboAuth.primary || 'sso';
    const secondaryType = comboAuth.secondaryType || (primaryType === 'sso' ? 'form' : 'sso');
    const fallbackEnabled = comboAuth.fallbackEnabled !== false;
    const fallbackOnlyOnce = comboAuth.fallbackOnlyOnce !== false;
    
    this.logger.info('Executing Sequential Combo Auth', { primaryType, secondaryType, fallbackEnabled });
    
    const result = {
      success: false,
      method: null,
      attempts: 0,
      errors: [],
      tabId: null,
      finalUrl: null
    };

    // Build credentials for each strategy
    const authCredentials = this.buildAuthCredentials(tool, credentials, comboAuth);

    // STEP 1: Apply session bundle first if available
    const sessionBundle = options.sessionBundle;
    if (sessionBundle && comboAuth.parallelSettings?.prepSessionFirst !== false) {
      this.logger.info('Applying session bundle before auth');
      await this.applySessionBundleParallel(tool.targetUrl, sessionBundle, tool.domain);
    }

    // STEP 2: Try primary strategy
    const primaryCredentials = authCredentials[primaryType];
    this.updateFlowStatus(flowId, `executing_primary_${primaryType}`);
    
    const primaryResult = await this.executeAuthMethod(primaryType, primaryCredentials, tool, options);
    result.attempts += primaryResult.attempts || 1;

    if (primaryResult.success) {
      result.success = true;
      result.method = `combo_${primaryType}`;
      result.tabId = primaryResult.tabId;
      result.finalUrl = primaryResult.finalUrl;
      return result;
    }

    if (primaryResult.requiresManualAction) {
      result.requiresManualAction = true;
      result.manualActionReason = primaryResult.manualActionReason;
      result.tabId = primaryResult.tabId;
      return result;
    }

    result.errors.push({ method: primaryType, error: primaryResult.error });

    // STEP 3: Try fallback if enabled
    if (fallbackEnabled) {
      const fallbackCredentials = authCredentials[secondaryType];
      
      this.logger.info('Primary failed, trying fallback', { secondaryType });
      this.updateFlowStatus(flowId, `executing_fallback_${secondaryType}`);

      const fallbackResult = await this.executeAuthMethod(secondaryType, fallbackCredentials, tool, options);
      result.attempts += fallbackResult.attempts || 1;

      if (fallbackResult.success) {
        result.success = true;
        result.method = `combo_fallback_${secondaryType}`;
        result.tabId = fallbackResult.tabId;
        result.finalUrl = fallbackResult.finalUrl;
        return result;
      }

      if (fallbackResult.requiresManualAction) {
        result.requiresManualAction = true;
        result.manualActionReason = fallbackResult.manualActionReason;
        result.tabId = fallbackResult.tabId;
        return result;
      }

      result.errors.push({ method: secondaryType, error: fallbackResult.error });
    }

    result.error = this.buildActionableError(result.errors, tool);
    return result;
  }

  /**
   * Execute Parallel Combo Auth - Apply all session data simultaneously
   * 
   * Simplified flow:
   * 1. PREP: Apply cookies + localStorage + sessionStorage ALL AT ONCE
   * 2. VERIFY: Check if login succeeded from session data alone
   * 3. AUTH (optional): Run auth method (SSO/Form) if specified and not yet logged in
   */
  async executeParallelComboAuth(tool, credentials, options, flowId) {
    const comboAuth = tool.comboAuth;
    const authMethod = comboAuth.primaryType || 'none'; // 'none', 'sso', or 'form'
    const parallelSettings = comboAuth.parallelSettings || {};
    
    this.logger.info('Executing Parallel/Simultaneous Mode', { authMethod });
    
    const result = {
      success: false,
      method: null,
      attempts: 0,
      errors: [],
      tabId: null,
      finalUrl: null
    };

    // Build session bundle from comboAuth config
    const sessionBundle = {
      cookies: null,
      localStorage: null,
      sessionStorage: null
    };

    // Parse cookies from config
    if (comboAuth.cookiesConfig?.cookies) {
      try {
        sessionBundle.cookies = JSON.parse(comboAuth.cookiesConfig.cookies);
      } catch (e) {
        this.logger.warn('Failed to parse cookies config', e);
      }
    }

    // Parse localStorage from config
    if (comboAuth.localStorageConfig?.data) {
      try {
        sessionBundle.localStorage = JSON.parse(comboAuth.localStorageConfig.data);
      } catch (e) {
        this.logger.warn('Failed to parse localStorage config', e);
      }
    }

    // Parse sessionStorage from config
    if (comboAuth.sessionStorageConfig?.data) {
      try {
        sessionBundle.sessionStorage = JSON.parse(comboAuth.sessionStorageConfig.data);
      } catch (e) {
        this.logger.warn('Failed to parse sessionStorage config', e);
      }
    }

    // Also use session bundle from options if provided (from API)
    if (options.sessionBundle) {
      if (options.sessionBundle.cookies) sessionBundle.cookies = options.sessionBundle.cookies;
      if (options.sessionBundle.localStorage) sessionBundle.localStorage = options.sessionBundle.localStorage;
      if (options.sessionBundle.sessionStorage) sessionBundle.sessionStorage = options.sessionBundle.sessionStorage;
    }

    const hasSessionData = sessionBundle.cookies || sessionBundle.localStorage || sessionBundle.sessionStorage;

    // PHASE 1: PREP - Apply all session data simultaneously
    if (hasSessionData) {
      this.updateFlowStatus(flowId, 'parallel_prep_session');
      this.logger.info('Phase 1: Applying ALL session data simultaneously');
      
      const prepResult = await this.applySessionBundleParallel(
        tool.targetUrl, 
        sessionBundle, 
        tool.domain
      );
      
      if (prepResult.anySuccess) {
        this.logger.info('Session bundle applied successfully', prepResult);
        result.attempts++;
        
        // PHASE 2: VERIFY - Check if session data alone logged us in
        this.updateFlowStatus(flowId, 'parallel_verify');
        await this.sleep(2000); // Wait for session to apply
        
        const loginCheck = await this.checkAlreadyLoggedIn(tool, credentials);
        if (loginCheck.success) {
          this.logger.info('Session data login successful!');
          const tab = await chrome.tabs.create({ url: tool.targetUrl, active: true });
          return {
            success: true,
            method: 'parallel_session',
            tabId: tab.id,
            finalUrl: tool.targetUrl,
            attempts: result.attempts,
            errors: []
          };
        }
      } else {
        this.logger.warn('Session bundle application failed', prepResult);
        result.errors.push({ method: 'session_bundle', error: 'Failed to apply session data' });
      }
    }

    // PHASE 3: AUTH - Run auth method if specified and not yet logged in
    if (authMethod && authMethod !== 'none') {
      this.updateFlowStatus(flowId, `parallel_auth_${authMethod}`);
      this.logger.info(`Phase 3: Running ${authMethod} auth method`);

      const authCredentials = this.buildAuthCredentials(tool, credentials, comboAuth);
      const methodCredentials = authCredentials[authMethod];

      if (methodCredentials) {
        const authResult = await this.executeAuthMethod(authMethod, methodCredentials, tool, options);
        result.attempts += authResult.attempts || 1;

        if (authResult.success) {
          result.success = true;
          result.method = `parallel_${authMethod}`;
          result.tabId = authResult.tabId;
          result.finalUrl = authResult.finalUrl;
          return result;
        }

        if (authResult.requiresManualAction) {
          result.requiresManualAction = true;
          result.manualActionReason = authResult.manualActionReason;
          result.tabId = authResult.tabId;
          return result;
        }

        result.errors.push({ method: authMethod, error: authResult.error });
      }
    }

    // If we have session data but no auth method, just open the target URL
    if (hasSessionData && (!authMethod || authMethod === 'none')) {
      const tab = await chrome.tabs.create({ url: tool.targetUrl, active: true });
      return {
        success: true,
        method: 'parallel_session_only',
        tabId: tab.id,
        finalUrl: tool.targetUrl,
        attempts: result.attempts,
        errors: result.errors
      };
    }

    if (!result.success) {
      result.error = this.buildActionableError(result.errors, tool);
    }
    
    return result;
  }

  /**
   * Execute Parallel Combo Auth (Legacy) - Keep for backward compatibility
   * This runs two auth methods simultaneously with commit-lock
   */
  async executeParallelComboAuthLegacy(tool, credentials, options, flowId) {
    const comboAuth = tool.comboAuth;
    const primaryType = comboAuth.primaryType || 'sso';
    const secondaryType = comboAuth.secondaryType || 'form';
    const parallelSettings = comboAuth.parallelSettings || {};
    const parallelTimeout = parallelSettings.parallelTimeout || 30000;
    const fallbackOnlyOnce = comboAuth.fallbackOnlyOnce !== false;
    
    this.logger.info('Executing Legacy Parallel Combo Auth', { 
      primaryType, 
      secondaryType, 
      parallelTimeout 
    });
    
    const result = {
      success: false,
      method: null,
      attempts: 0,
      errors: [],
      tabId: null,
      finalUrl: null
    };

    // Build credentials for each auth type
    const authCredentials = this.buildAuthCredentials(tool, credentials, comboAuth);

    // PHASE 1: PREP - Apply session bundle in parallel (cookies + localStorage + sessionStorage)
    this.updateFlowStatus(flowId, 'parallel_prep');
    const sessionBundle = options.sessionBundle;
    
    if (sessionBundle && parallelSettings.prepSessionFirst !== false) {
      this.logger.info('Phase 1: Applying session bundle in parallel');
      
      const prepResult = await this.applySessionBundleParallel(
        tool.targetUrl, 
        sessionBundle, 
        tool.domain
      );
      
      if (prepResult.anySuccess) {
        this.logger.info('Session bundle applied', prepResult);
        
        // Check if session bundle alone succeeded (rare but possible)
        await this.sleep(1500);
        const quickCheck = await this.checkAlreadyLoggedIn(tool, credentials);
        if (quickCheck.success) {
          const tab = await chrome.tabs.create({ url: tool.targetUrl, active: true });
          return {
            success: true,
            method: 'session_bundle',
            tabId: tab.id,
            finalUrl: tool.targetUrl,
            attempts: 1,
            errors: []
          };
        }
      }
    }

    // PHASE 2: COMMIT - Run both auth methods in parallel with commit-lock
    this.updateFlowStatus(flowId, 'parallel_commit');
    this.logger.info('Phase 2: Running auth methods in parallel');

    // Create a commit lock to ensure only one navigation succeeds
    let commitLocked = false;
    const commitLock = () => {
      if (commitLocked) return false;
      commitLocked = true;
      return true;
    };

    // Execute both methods in parallel
    const authPromises = [];
    const methodTypes = [primaryType, secondaryType];

    for (const methodType of methodTypes) {
      const methodCredentials = authCredentials[methodType];
      if (methodCredentials) {
        authPromises.push(
          this.executeAuthMethodWithLock(
            methodType, 
            methodCredentials, 
            tool, 
            options, 
            commitLock
          ).catch(error => ({
            success: false,
            method: methodType,
            error: error.message
          }))
        );
      }
    }

    // Race with timeout
    const timeoutPromise = new Promise(resolve => 
      setTimeout(() => resolve({ timeout: true }), parallelTimeout)
    );

    try {
      // Wait for first success or all to complete
      const raceResult = await Promise.race([
        Promise.any(authPromises.map(p => 
          p.then(r => r.success ? r : Promise.reject(r))
        )).catch(() => null),
        timeoutPromise
      ]);

      if (raceResult?.timeout) {
        this.logger.warn('Parallel auth timed out');
        result.errors.push({ method: 'parallel', error: 'Timeout' });
      } else if (raceResult?.success) {
        result.success = true;
        result.method = `parallel_${raceResult.method}`;
        result.tabId = raceResult.tabId;
        result.finalUrl = raceResult.finalUrl;
        result.attempts = 1;
        return result;
      }

      // Get all results
      const allResults = await Promise.allSettled(authPromises);
      
      for (const settled of allResults) {
        if (settled.status === 'fulfilled') {
          const r = settled.value;
          if (r.success && !result.success) {
            result.success = true;
            result.method = `parallel_${r.method}`;
            result.tabId = r.tabId;
            result.finalUrl = r.finalUrl;
          } else if (r.requiresManualAction && !result.requiresManualAction) {
            result.requiresManualAction = true;
            result.manualActionReason = r.manualActionReason;
            result.tabId = r.tabId;
          } else if (r.error) {
            result.errors.push({ method: r.method, error: r.error });
          }
        }
      }

    } catch (error) {
      this.logger.error('Parallel auth error', { error: error.message });
      result.errors.push({ method: 'parallel', error: error.message });
    }

    // PHASE 3: VERIFY - Check login status
    if (!result.success && !result.requiresManualAction && parallelSettings.verifyAfterAuth !== false) {
      this.updateFlowStatus(flowId, 'parallel_verify');
      this.logger.info('Phase 3: Verifying login status');
      
      await this.sleep(2000);
      const verifyResult = await this.checkAlreadyLoggedIn(tool, credentials);
      
      if (verifyResult.success) {
        const tab = await chrome.tabs.create({ url: tool.targetUrl, active: true });
        return {
          success: true,
          method: 'parallel_verified',
          tabId: tab.id,
          finalUrl: tool.targetUrl,
          attempts: result.attempts,
          errors: result.errors
        };
      }
    }

    // PHASE 4: FALLBACK - Run other method once if both failed
    if (!result.success && !result.requiresManualAction && fallbackOnlyOnce) {
      this.updateFlowStatus(flowId, 'parallel_fallback');
      this.logger.info('Phase 4: Trying fallback (once)');

      // Try secondary method one more time
      const fallbackCredentials = authCredentials[secondaryType];
      if (fallbackCredentials) {
        const fallbackResult = await this.executeAuthMethod(
          secondaryType, 
          fallbackCredentials, 
          tool, 
          options
        );

        if (fallbackResult.success) {
          result.success = true;
          result.method = `parallel_fallback_${secondaryType}`;
          result.tabId = fallbackResult.tabId;
          result.finalUrl = fallbackResult.finalUrl;
          return result;
        }

        if (fallbackResult.requiresManualAction) {
          result.requiresManualAction = true;
          result.manualActionReason = fallbackResult.manualActionReason;
          result.tabId = fallbackResult.tabId;
          return result;
        }
      }
    }

    if (!result.success) {
      result.error = this.buildActionableError(result.errors, tool);
    }
    
    return result;
  }

  /**
   * Apply session bundle in parallel (cookies + localStorage + sessionStorage)
   */
  async applySessionBundleParallel(targetUrl, sessionBundle, domain) {
    const results = {
      cookies: { success: false, count: 0 },
      localStorage: { success: false, count: 0 },
      sessionStorage: { success: false, count: 0 },
      anySuccess: false
    };

    const promises = [];

    // Apply cookies (can be done without a tab)
    if (sessionBundle.cookies && Array.isArray(sessionBundle.cookies) && sessionBundle.cookies.length > 0) {
      promises.push(
        this.injectCookies(targetUrl, sessionBundle.cookies)
          .then(r => { results.cookies = r; })
          .catch(e => { results.cookies = { success: false, error: e.message }; })
      );
    }

    // For localStorage and sessionStorage, we need a tab
    const needsTab = (sessionBundle.localStorage && Object.keys(sessionBundle.localStorage).length > 0) ||
                    (sessionBundle.sessionStorage && Object.keys(sessionBundle.sessionStorage).length > 0);

    if (needsTab) {
      promises.push(
        (async () => {
          const hiddenTab = await this.createHiddenTab(targetUrl);
          if (!hiddenTab) return;

          await this.waitForTabLoad(hiddenTab.id);

          // Inject localStorage and sessionStorage in parallel
          const storagePromises = [];

          if (sessionBundle.localStorage && Object.keys(sessionBundle.localStorage).length > 0) {
            storagePromises.push(
              this.injectStorage(hiddenTab.id, 'localStorage', sessionBundle.localStorage)
                .then(r => { results.localStorage = r; })
                .catch(e => { results.localStorage = { success: false, error: e.message }; })
            );
          }

          if (sessionBundle.sessionStorage && Object.keys(sessionBundle.sessionStorage).length > 0) {
            storagePromises.push(
              this.injectStorage(hiddenTab.id, 'sessionStorage', sessionBundle.sessionStorage)
                .then(r => { results.sessionStorage = r; })
                .catch(e => { results.sessionStorage = { success: false, error: e.message }; })
            );
          }

          await Promise.all(storagePromises);

          // Close hidden tab
          await chrome.tabs.remove(hiddenTab.id).catch(() => {});
        })()
      );
    }

    await Promise.all(promises);

    results.anySuccess = results.cookies.success || results.localStorage.success || results.sessionStorage.success;
    
    this.logger.debug('Session bundle applied', results);
    return results;
  }

  /**
   * Build credentials object for each auth type
   */
  buildAuthCredentials(tool, credentials, comboAuth) {
    return {
      sso: {
        type: 'sso',
        payload: comboAuth.ssoConfig || {},
        selectors: credentials.selectors || {},
        successCheck: credentials.successCheck || {}
      },
      form: {
        type: 'form',
        payload: comboAuth.formConfig || {},
        selectors: credentials.selectors || {},
        successCheck: credentials.successCheck || {}
      },
      cookies: {
        type: 'cookies',
        payload: comboAuth.cookiesConfig?.cookies ? JSON.parse(comboAuth.cookiesConfig.cookies) : [],
        selectors: {},
        successCheck: credentials.successCheck || {}
      },
      token: {
        type: 'token',
        payload: comboAuth.tokenConfig || {},
        selectors: {},
        successCheck: credentials.successCheck || {}
      },
      localStorage: {
        type: 'localStorage',
        payload: comboAuth.localStorageConfig?.data ? JSON.parse(comboAuth.localStorageConfig.data) : {},
        selectors: {},
        successCheck: credentials.successCheck || {}
      },
      sessionStorage: {
        type: 'sessionStorage',
        payload: comboAuth.sessionStorageConfig?.data ? JSON.parse(comboAuth.sessionStorageConfig.data) : {},
        selectors: {},
        successCheck: credentials.successCheck || {}
      }
    };
  }

  /**
   * Execute a specific auth method
   */
  async executeAuthMethod(methodType, methodCredentials, tool, options) {
    switch (methodType) {
      case 'sso':
        return this.executeSSOLogin(methodCredentials.payload, tool, methodCredentials);
      case 'form':
        return this.executeFormLoginAuto(methodCredentials.payload, tool, methodCredentials, options);
      case 'cookies':
        return this.executeSessionInjection(
          { cookies: methodCredentials.payload, localStorage: {}, sessionStorage: {} },
          tool,
          methodCredentials
        );
      case 'token':
        return this.executeSessionInjection(
          { cookies: [], localStorage: { token: methodCredentials.payload.token }, sessionStorage: {} },
          tool,
          methodCredentials
        );
      case 'localStorage':
        return this.executeSessionInjection(
          { cookies: [], localStorage: methodCredentials.payload, sessionStorage: {} },
          tool,
          methodCredentials
        );
      case 'sessionStorage':
        return this.executeSessionInjection(
          { cookies: [], localStorage: {}, sessionStorage: methodCredentials.payload },
          tool,
          methodCredentials
        );
      default:
        return { success: false, error: `Unknown method: ${methodType}` };
    }
  }

  /**
   * Execute auth method with commit lock (for parallel mode)
   */
  async executeAuthMethodWithLock(methodType, methodCredentials, tool, options, commitLock) {
    const result = await this.executeAuthMethod(methodType, methodCredentials, tool, options);
    
    // If successful, try to acquire commit lock
    if (result.success) {
      if (!commitLock()) {
        // Another method already succeeded - close our tab
        if (result.tabId) {
          await chrome.tabs.remove(result.tabId).catch(() => {});
        }
        return { ...result, success: false, superseded: true };
      }
    }
    
    result.method = methodType;
    return result;
  }

  /**
   * Execute standard login (non-combo)
   */
  async executeStandardLogin(tool, credentials, options, flowId) {
    const result = {
      success: false,
      method: null,
      attempts: 0,
      errors: [],
      tabId: null,
      finalUrl: null
    };

    const executionPlan = this.buildExecutionPlan(tool, credentials);
    this.logger.debug('Execution plan', { methods: executionPlan.map(m => m.method) });

    for (const step of executionPlan) {
      if (this.cancelledFlows.has(flowId)) {
        result.error = 'Login cancelled by user';
        break;
      }

      this.updateFlowStatus(flowId, `executing_${step.method}`);
      
      const stepResult = await this.executeWithRetry(
        () => this.executeMethod(step, tool, credentials, options),
        step.method,
        options.maxRetries || ORCHESTRATOR_CONFIG.maxRetries
      );

      result.attempts += stepResult.attempts;

      if (stepResult.success) {
        result.success = true;
        result.method = step.method;
        result.tabId = stepResult.tabId;
        result.finalUrl = stepResult.finalUrl;
        
        this.logger.info('Login successful', { method: step.method });
        break;
      }

      if (stepResult.requiresManualAction) {
        result.requiresManualAction = true;
        result.manualActionReason = stepResult.manualActionReason;
        result.tabId = stepResult.tabId;
        
        this.logger.warn('Manual action required', { reason: stepResult.manualActionReason });
        break;
      }

      if (stepResult.error) {
        result.errors.push({
          method: step.method,
          error: stepResult.error,
          attempts: stepResult.attempts
        });
      }
    }

    if (!result.success && !result.requiresManualAction) {
      result.error = this.buildActionableError(result.errors, tool);
      this.logger.error('All login methods failed', { errors: result.errors });
    }

    return result;
  }

  /**
   * Build execution plan based on credentials type
   */
  buildExecutionPlan(tool, credentials) {
    const plan = [];
    const credType = credentials?.type;

    // Always try session injection first if we have cookies or tokens
    if (this.hasSessionData(credentials)) {
      plan.push({
        method: 'session',
        priority: 1,
        data: this.extractSessionData(credentials)
      });
    }

    // Add form login if credentials are form type
    if (credType === 'form' && credentials.payload?.username && credentials.payload?.password) {
      plan.push({
        method: 'form',
        priority: 2,
        data: {
          username: credentials.payload.username,
          password: credentials.payload.password,
          loginUrl: credentials.payload.loginUrl || credentials.loginUrl || tool.loginUrl || tool.targetUrl,
          selectors: credentials.selectors || {},
          multiStep: credentials.payload.multiStep || credentials.formOptions?.multiStep,
          submitDelay: credentials.payload.submitDelay || 800
        }
      });
    }

    // Add SSO if configured
    if (credType === 'sso' && credentials.payload?.authStartUrl) {
      plan.push({
        method: 'sso',
        priority: 3,
        data: {
          authStartUrl: credentials.payload.authStartUrl,
          postLoginUrl: credentials.payload.postLoginUrl || tool.targetUrl,
          provider: credentials.payload.provider,
          autoClick: credentials.payload.autoClick,
          buttonSelector: credentials.payload.buttonSelector
        }
      });
    }

    // Sort by priority
    plan.sort((a, b) => a.priority - b.priority);

    return plan;
  }

  /**
   * Check if credentials contain session data
   */
  hasSessionData(credentials) {
    if (!credentials) return false;
    
    const type = credentials.type;
    const payload = credentials.payload;

    return (
      type === 'cookies' ||
      type === 'token' ||
      type === 'localStorage' ||
      type === 'sessionStorage' ||
      (payload?.cookies && payload.cookies.length > 0) ||
      (payload?.value) || // token value
      (type === 'sso' && payload?.sessionData) ||
      (type === 'headers' && payload?.cookies)
    );
  }

  /**
   * Extract session data from credentials
   */
  extractSessionData(credentials) {
    const data = {
      cookies: [],
      localStorage: {},
      sessionStorage: {},
      token: null
    };

    const type = credentials.type;
    const payload = credentials.payload;

    switch (type) {
      case 'cookies':
        data.cookies = Array.isArray(payload) ? payload : (payload?.cookies || []);
        break;

      case 'token':
        data.token = payload?.value;
        data.localStorage = {
          token: payload?.value,
          access_token: payload?.value,
          auth_token: payload?.value
        };
        break;

      case 'localStorage':
        data.localStorage = payload || {};
        break;

      case 'sessionStorage':
        data.sessionStorage = payload || {};
        break;

      case 'sso':
        if (payload?.sessionData) {
          data.cookies = payload.sessionData.cookies || [];
          data.localStorage = payload.sessionData.localStorage || {};
        }
        if (payload?.tokens?.accessToken) {
          data.localStorage.access_token = payload.tokens.accessToken;
          data.localStorage.token = payload.tokens.accessToken;
        }
        break;

      case 'headers':
        if (payload?.cookies) {
          data.cookies = payload.cookies;
        }
        if (payload?.value) {
          data.localStorage.auth_token = payload.value;
        }
        break;
    }

    return data;
  }

  /**
   * Execute a login method with retry logic
   */
  async executeWithRetry(fn, methodName, maxRetries) {
    let attempts = 0;
    let lastError = null;
    let delay = ORCHESTRATOR_CONFIG.retryDelayMs;

    while (attempts < maxRetries) {
      attempts++;
      this.logger.debug(`Attempt ${attempts}/${maxRetries} for ${methodName}`);

      try {
        const result = await fn();
        result.attempts = attempts;

        if (result.success || result.requiresManualAction || result.skipRetry) {
          return result;
        }

        lastError = result.error;
      } catch (error) {
        lastError = error.message;
        this.logger.warn(`${methodName} attempt ${attempts} failed`, { error: lastError });
      }

      // Wait before retry with exponential backoff
      if (attempts < maxRetries) {
        this.logger.debug(`Retrying in ${delay}ms`);
        await this.sleep(delay);
        delay = Math.min(delay * ORCHESTRATOR_CONFIG.backoffMultiplier, ORCHESTRATOR_CONFIG.maxRetryDelay);
      }
    }

    return {
      success: false,
      error: lastError || 'Max retries exceeded',
      attempts
    };
  }

  /**
   * Execute a specific login method
   */
  async executeMethod(step, tool, credentials, options = {}) {
    switch (step.method) {
      case 'session':
        return this.executeSessionInjection(step.data, tool, credentials);
      case 'form':
        return this.executeFormLoginAuto(step.data, tool, credentials, options);
      case 'sso':
        return this.executeSSOLogin(step.data, tool, credentials);
      default:
        return { success: false, error: `Unknown method: ${step.method}` };
    }
  }

  /**
   * Execute session injection (cookies + storage)
   */
  async executeSessionInjection(data, tool, credentials) {
    this.logger.info('Executing session injection');

    const results = {
      cookies: { success: false, count: 0 },
      localStorage: { success: false, count: 0 },
      sessionStorage: { success: false, count: 0 }
    };

    // Inject cookies BEFORE opening any tab
    if (data.cookies && data.cookies.length > 0) {
      this.logger.debug('Injecting cookies', { count: data.cookies.length });
      results.cookies = await this.injectCookies(tool.targetUrl, data.cookies);
    }

    // Open hidden tab for storage injection
    let hiddenTab = null;
    const hasStorageData = Object.keys(data.localStorage).length > 0 || 
                          Object.keys(data.sessionStorage).length > 0;

    if (hasStorageData) {
      hiddenTab = await this.createHiddenTab(tool.targetUrl);
      
      if (hiddenTab) {
        await this.waitForTabLoad(hiddenTab.id);

        // Inject localStorage
        if (Object.keys(data.localStorage).length > 0) {
          this.logger.debug('Injecting localStorage', { keys: Object.keys(data.localStorage).length });
          results.localStorage = await this.injectStorage(hiddenTab.id, 'localStorage', data.localStorage);
        }

        // Inject sessionStorage
        if (Object.keys(data.sessionStorage).length > 0) {
          this.logger.debug('Injecting sessionStorage', { keys: Object.keys(data.sessionStorage).length });
          results.sessionStorage = await this.injectStorage(hiddenTab.id, 'sessionStorage', data.sessionStorage);
        }

        // Reload to apply storage
        await chrome.tabs.reload(hiddenTab.id);
        await this.waitForTabLoad(hiddenTab.id);
      }
    }

    // Check if injection was successful
    const anySuccess = results.cookies.success || results.localStorage.success || results.sessionStorage.success;

    if (!anySuccess) {
      if (hiddenTab) {
        await chrome.tabs.remove(hiddenTab.id).catch(() => {});
      }
      return { success: false, error: 'Session injection failed' };
    }

    // Verify login success
    const checkTabId = hiddenTab?.id;
    let success = false;
    let finalUrl = tool.targetUrl;

    if (checkTabId) {
      // Wait a bit for session to take effect
      await this.sleep(ORCHESTRATOR_CONFIG.successCheckDelayMs);

      // Check if we're logged in
      const loginCheck = await this.successDetector.checkLoginSuccess(
        checkTabId, 
        tool, 
        credentials?.successCheck
      );

      success = loginCheck.success;
      finalUrl = loginCheck.currentUrl || finalUrl;

      if (success) {
        // Make tab visible and active
        await chrome.tabs.update(checkTabId, { active: true });
        return {
          success: true,
          tabId: checkTabId,
          finalUrl,
          method: 'session'
        };
      } else {
        // Close hidden tab, session didn't work
        await chrome.tabs.remove(checkTabId).catch(() => {});
      }
    } else if (results.cookies.success) {
      // Only cookies were injected, open new tab to verify
      const verifyTab = await chrome.tabs.create({ url: tool.targetUrl, active: false });
      await this.waitForTabLoad(verifyTab.id);
      await this.sleep(ORCHESTRATOR_CONFIG.successCheckDelayMs);

      const loginCheck = await this.successDetector.checkLoginSuccess(
        verifyTab.id, 
        tool, 
        credentials?.successCheck
      );

      if (loginCheck.success) {
        await chrome.tabs.update(verifyTab.id, { active: true });
        return {
          success: true,
          tabId: verifyTab.id,
          finalUrl: loginCheck.currentUrl || tool.targetUrl,
          method: 'session'
        };
      } else {
        await chrome.tabs.remove(verifyTab.id).catch(() => {});
      }
    }

    return { success: false, error: 'Session injection did not result in logged-in state' };
  }

  /**
   * Execute form login with auto-start capability
   * Enhanced for ?auto=1 support with proper hidden mode
   */
  async executeFormLoginAuto(data, tool, credentials, options = {}) {
    const loginUrl = data.loginUrl || data.payload?.loginUrl || tool.loginUrl || tool.targetUrl;
    const isHiddenMode = options.hidden === true;
    const autoStartDelay = tool.extensionSettings?.autoStartDelay || ORCHESTRATOR_CONFIG.formFillDelayMs;
    const maxAttempts = tool.extensionSettings?.maxAutoAttempts || 2;
    const autoSubmit = data.autoSubmit !== false && data.payload?.autoSubmit !== false; // Default true
    
    this.logger.info('Executing form login (auto-start)', { loginUrl, isHiddenMode, autoSubmit });

    // Create tab for login
    // For hidden mode, use truly hidden window (minimized/offscreen) to prevent page flash
    let loginTab;
    if (isHiddenMode) {
      loginTab = await this.createHiddenTab(loginUrl, { trulyHidden: true });
    } else {
      loginTab = await chrome.tabs.create({ url: loginUrl, active: true });
    }
      
    if (!loginTab) {
      return { success: false, error: 'Failed to create login tab' };
    }

    try {
      // Wait for page to load
      await this.waitForTabLoad(loginTab.id);
      
      // Inject "Logging in..." overlay if visible tab
      if (!isHiddenMode) {
        await this.injectLoginOverlay(loginTab.id, tool.name);
      }
      
      // Auto-start delay
      await this.sleep(autoStartDelay);

      // Wait for login form to appear (handles SPA rendering)
      const formReady = await this.waitForLoginForm(loginTab.id, 8000);
      
      if (!formReady.hasForm) {
        // Check if we're already logged in
        const alreadyIn = await this.successDetector.checkLoginSuccess(
          loginTab.id, tool, credentials?.successCheck
        );
        
        if (alreadyIn.success) {
          if (!isHiddenMode) {
            await this.removeLoginOverlay(loginTab.id);
          } else {
            // In hidden mode success, redirect source tab
            if (options.sourceTabId) {
              await chrome.tabs.update(options.sourceTabId, { url: alreadyIn.currentUrl || tool.targetUrl });
              await this.closeHiddenTab(loginTab);
              return {
                success: true,
                tabId: options.sourceTabId,
                finalUrl: alreadyIn.currentUrl,
                method: 'form',
                note: 'Already logged in'
              };
            }
            // Make hidden tab visible
            await this.makeTabVisible(loginTab);
          }
          return {
            success: true,
            tabId: loginTab.id,
            finalUrl: alreadyIn.currentUrl,
            method: 'form',
            note: 'Already logged in'
          };
        }
        
        await this.closeHiddenTab(loginTab);
        return { success: false, error: 'Login form not found' };
      }

      // Check for MFA/2FA field - stop if detected
      if (formReady.hasMFA) {
        if (!isHiddenMode) {
          await this.removeLoginOverlay(loginTab.id);
        } else {
          // Bring hidden tab to foreground for MFA
          await this.makeTabVisible(loginTab);
        }
        return {
          success: false,
          requiresManualAction: true,
          manualActionReason: 'MFA/2FA detected - please complete authentication manually',
          tabId: loginTab.id,
          skipRetry: true
        };
      }

      // Execute form fill with auto-submit (matching SSO auto-click behavior)
      const username = data.username || data.payload?.username;
      const password = data.password || data.payload?.password;
      const multiStep = data.multiStep || data.payload?.multiStep;
      
      const fillResult = await this.executeFormFillAutoSubmit(
        loginTab.id, 
        username, 
        password, 
        credentials?.selectors,
        multiStep,
        autoSubmit  // Pass autoSubmit flag
      );

      if (!fillResult.success) {
        if (!isHiddenMode) {
          await this.removeLoginOverlay(loginTab.id);
        }
        await this.closeHiddenTab(loginTab);
        return { success: false, error: fillResult.error || 'Form fill failed' };
      }

      // Wait for login to process
      await this.sleep(ORCHESTRATOR_CONFIG.postSubmitWaitMs);

      // Monitor for success or error
      const loginResult = await this.monitorLoginResult(
        loginTab.id, 
        tool, 
        credentials?.successCheck,
        15000
      );

      // Remove overlay
      if (!isHiddenMode) {
        await this.removeLoginOverlay(loginTab.id);
      }

      if (loginResult.success) {
        // Handle hidden mode success - redirect source tab
        if (isHiddenMode && options.sourceTabId) {
          await chrome.tabs.update(options.sourceTabId, { 
            url: loginResult.currentUrl || tool.targetUrl 
          });
          await this.closeHiddenTab(loginTab);
          return {
            success: true,
            tabId: options.sourceTabId,
            finalUrl: loginResult.currentUrl,
            method: 'form'
          };
        }
        
        // Make hidden tab visible if no source tab
        if (isHiddenMode) {
          await this.makeTabVisible(loginTab);
        }
        
        return {
          success: true,
          tabId: loginTab.id,
          finalUrl: loginResult.currentUrl,
          method: 'form'
        };
      }

      if (loginResult.hasMFA) {
        if (isHiddenMode) {
          // Bring hidden tab to foreground for MFA
          await this.makeTabVisible(loginTab);
        }
        return {
          success: false,
          requiresManualAction: true,
          manualActionReason: 'MFA/2FA required - please complete authentication',
          tabId: loginTab.id,
          skipRetry: true
        };
      }

      if (loginResult.hasError) {
        await this.closeHiddenTab(loginTab);
        return { 
          success: false, 
          error: loginResult.errorMessage || 'Login failed - invalid credentials?'
        };
      }

      await this.closeHiddenTab(loginTab);
      return { success: false, error: 'Login did not complete successfully' };

    } catch (error) {
      await this.closeHiddenTab(loginTab);
      throw error;
    }
  }

  /**
   * Inject "Logging in..." overlay into the page
   */
  async injectLoginOverlay(tabId, toolName) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (name) => {
          // Remove any existing overlay
          const existing = document.getElementById('toolstack-login-overlay');
          if (existing) existing.remove();

          // Create overlay
          const overlay = document.createElement('div');
          overlay.id = 'toolstack-login-overlay';
          overlay.innerHTML = `
            <div style="
              position: fixed;
              top: 20px;
              right: 20px;
              z-index: 999999;
              background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
              border: 1px solid rgba(255, 140, 0, 0.3);
              border-radius: 12px;
              padding: 16px 24px;
              box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
              display: flex;
              align-items: center;
              gap: 12px;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            ">
              <div style="
                width: 24px;
                height: 24px;
                border: 3px solid rgba(255, 140, 0, 0.3);
                border-top-color: #ff8c00;
                border-radius: 50%;
                animation: toolstack-spin 1s linear infinite;
              "></div>
              <div>
                <div style="color: white; font-weight: 600; font-size: 14px;">Logging in to ${name}...</div>
                <div style="color: rgba(255,255,255,0.6); font-size: 12px; margin-top: 2px;">Please wait</div>
              </div>
              <button id="toolstack-cancel-login" style="
                margin-left: 16px;
                background: transparent;
                border: 1px solid rgba(255,255,255,0.3);
                color: rgba(255,255,255,0.8);
                padding: 6px 12px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                transition: all 0.2s;
              " onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='transparent'">
                Cancel
              </button>
            </div>
            <style>
              @keyframes toolstack-spin {
                to { transform: rotate(360deg); }
              }
            </style>
          `;
          document.body.appendChild(overlay);

          // Handle cancel button
          document.getElementById('toolstack-cancel-login')?.addEventListener('click', () => {
            overlay.remove();
            window.dispatchEvent(new CustomEvent('toolstack-login-cancelled'));
          });
        },
        args: [toolName]
      });
    } catch (error) {
      this.logger.warn('Failed to inject overlay', { error: error.message });
    }
  }

  /**
   * Remove login overlay
   */
  async removeLoginOverlay(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const overlay = document.getElementById('toolstack-login-overlay');
          if (overlay) overlay.remove();
        }
      });
    } catch (error) {
      // Tab might have navigated
    }
  }

  /**
   * Execute form fill with auto-submit (Enter key fallback)
   * @param {number} tabId - Tab ID
   * @param {string} username - Username/email
   * @param {string} password - Password  
   * @param {Object} customSelectors - Custom CSS selectors
   * @param {boolean} multiStep - Multi-step login flow
   * @param {boolean} autoSubmit - Whether to auto-submit (like SSO auto-click)
   */
  async executeFormFillAutoSubmit(tabId, username, password, customSelectors = {}, multiStep = false, autoSubmit = true) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: this.formFillAutoSubmitScript,
        args: [username, password, customSelectors, multiStep, autoSubmit]
      });

      return results[0]?.result || { success: false, error: 'No result' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Form fill script with auto-submit (injected into page)
   * Matches SSO auto-click behavior - fills form and submits automatically
   */
  formFillAutoSubmitScript(username, password, customSelectors, multiStep, autoSubmit = true) {
    const result = {
      success: false,
      steps: [],
      error: null,
      autoSubmitted: false
    };

    // Selector lists
    const usernameSelectors = [
      customSelectors?.username,
      'input[type="email"]', 'input[name="email"]', 'input[id="email"]',
      'input[name="username"]', 'input[id="username"]', 'input[name="login"]',
      'input[autocomplete="email"]', 'input[autocomplete="username"]',
      'input[placeholder*="email" i]', 'input[placeholder*="username" i]',
      'input[name="identifier"]', 'input[name="account"]'
    ].filter(Boolean);

    const passwordSelectors = [
      customSelectors?.password,
      'input[type="password"]', 'input[name="password"]', 'input[id="password"]',
      'input[autocomplete="current-password"]'
    ].filter(Boolean);

    const submitSelectors = [
      customSelectors?.submit,
      'button[type="submit"]', 'input[type="submit"]',
      'button[class*="login" i]', 'button[class*="signin" i]', 'button[class*="submit" i]',
      'button[id*="login" i]', 'button[id*="signin" i]',
      '[role="button"][class*="login" i]', '[role="button"][class*="submit" i]'
    ].filter(Boolean);

    const nextButtonSelectors = [
      customSelectors?.next,
      'button[class*="next" i]', 'button[id*="next" i]',
      'button:not([type="submit"])[class*="continue" i]',
      'input[type="button"][value*="next" i]',
      'input[type="button"][value*="continue" i]'
    ].filter(Boolean);

    // Helper: Find visible element
    const findElement = (selectorList, doc = document) => {
      for (const selector of selectorList) {
        if (!selector) continue;
        try {
          let el = doc.querySelector(selector);
          if (el && el.offsetParent !== null) return { el, inIframe: false };

          // Check iframes
          const iframes = doc.querySelectorAll('iframe');
          for (const iframe of iframes) {
            try {
              if (iframe.contentDocument) {
                el = iframe.contentDocument.querySelector(selector);
                if (el && el.offsetParent !== null) {
                  return { el, inIframe: true, iframe };
                }
              }
            } catch (e) {}
          }
        } catch (e) {}
      }
      return { el: null };
    };

    // Helper: Set input value with events (React/Vue/Angular compatible)
    const setInputValue = (input, value) => {
      input.focus();
      input.value = '';

      // Native setter for React
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;

      if (nativeSetter) {
        nativeSetter.call(input, value);
      } else {
        input.value = value;
      }

      // Dispatch events
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
    };

    // Helper: Click element
    const clickElement = (el) => {
      el.focus();
      el.click();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    };

    // Helper: Press Enter key
    const pressEnter = (el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    };

    // STEP 1: Find and fill username
    const usernameField = findElement(usernameSelectors);
    if (!usernameField.el) {
      result.error = 'Username field not found';
      return result;
    }

    setInputValue(usernameField.el, username);
    result.steps.push({ field: 'username', success: true });

    // STEP 2: Check if password field is visible (single-step) or need to click next (multi-step)
    const passwordField = findElement(passwordSelectors);

    if (passwordField.el) {
      // Single-step login
      setInputValue(passwordField.el, password);
      result.steps.push({ field: 'password', success: true });

      // Auto-submit if enabled (like SSO auto-click)
      if (autoSubmit) {
        setTimeout(() => {
          const submitBtn = findElement(submitSelectors);
          if (submitBtn.el) {
            // Try requestSubmit first (better form validation), then click, then Enter
            const form = submitBtn.el.closest('form');
            if (form && typeof form.requestSubmit === 'function') {
              try {
                form.requestSubmit(submitBtn.el);
                result.autoSubmitted = true;
              } catch (e) {
                clickElement(submitBtn.el);
              }
            } else {
              clickElement(submitBtn.el);
            }
            result.steps.push({ action: 'submit_click', success: true });
          } else {
            // Fallback: Press Enter on password field
            pressEnter(passwordField.el);
            result.steps.push({ action: 'enter_key', success: true });
          }
          result.autoSubmitted = true;
        }, 200);
      }

      result.success = true;
      result.multiStep = false;

    } else {
      // Multi-step login - click next/continue first
      const nextBtn = findElement(nextButtonSelectors);
      const submitBtn = findElement(submitSelectors);
      const clickTarget = nextBtn.el || submitBtn.el;

      if (clickTarget) {
        clickElement(clickTarget);
        result.steps.push({ action: 'next_click', success: true });
        result.multiStep = true;
        result.needsPasswordStep = true;

        // Schedule password fill after next button processes
        setTimeout(() => {
          const pwdField = findElement(passwordSelectors);
          if (pwdField.el) {
            setInputValue(pwdField.el, password);

            // Auto-submit second step if enabled
            if (autoSubmit) {
              setTimeout(() => {
                const finalSubmit = findElement(submitSelectors);
                if (finalSubmit.el) {
                  // Try requestSubmit first
                  const form = finalSubmit.el.closest('form');
                  if (form && typeof form.requestSubmit === 'function') {
                    try {
                      form.requestSubmit(finalSubmit.el);
                    } catch (e) {
                      clickElement(finalSubmit.el);
                    }
                  } else {
                    clickElement(finalSubmit.el);
                  }
                } else {
                  // Fallback: Press Enter
                  pressEnter(pwdField.el);
                }
              }, 200);
            }
          }
        }, 1500);

        result.success = true;
      } else {
        // No submit/next button - try Enter key on username if autoSubmit enabled
        if (autoSubmit) {
          pressEnter(usernameField.el);
          result.steps.push({ action: 'enter_key_username', success: true });
        }
        result.success = true;
      }
    }

    return result;
  }

  /**
   * Execute SSO login
   */
  async executeSSOLogin(data, tool, credentials) {
    const authStartUrl = data.authStartUrl || data.payload?.authStartUrl || tool.loginUrl;
    const postLoginUrl = data.postLoginUrl || data.payload?.postLoginUrl || tool.targetUrl;
    const provider = data.provider || data.payload?.provider;
    const autoClick = data.autoClick !== false && data.payload?.autoClick !== false;
    const buttonSelector = data.buttonSelector || data.payload?.buttonSelector;
    
    this.logger.info('Executing SSO login', { 
      provider,
      authStartUrl 
    });

    if (!authStartUrl) {
      return { success: false, error: 'No auth start URL configured' };
    }

    // Create visible tab for SSO (user may need to interact)
    const ssoTab = await chrome.tabs.create({ 
      url: authStartUrl, 
      active: true
    });

    try {
      await this.waitForTabLoad(ssoTab.id);
      await this.sleep(1000);

      // Try to click provider button if autoClick is enabled
      if (autoClick && (provider || buttonSelector)) {
        const clickResult = await this.clickSSOProvider(ssoTab.id, provider, buttonSelector);
        if (clickResult.clicked) {
          this.logger.debug('Clicked SSO provider button');
        }
      }

      // Check for account chooser
      const accountChooser = await this.detectAccountChooser(ssoTab.id);
      if (accountChooser.detected) {
        return {
          success: false,
          requiresManualAction: true,
          manualActionReason: 'Account selection required - please choose an account',
          tabId: ssoTab.id,
          skipRetry: true
        };
      }

      // Monitor for redirect to post-login URL
      const ssoResult = await this.monitorSSOCompletion(
        ssoTab.id,
        postLoginUrl,
        tool,
        credentials?.successCheck,
        30000
      );

      if (ssoResult.success) {
        return {
          success: true,
          tabId: ssoTab.id,
          finalUrl: ssoResult.currentUrl,
          method: 'sso'
        };
      }

      if (ssoResult.requiresManualAction) {
        return {
          success: false,
          requiresManualAction: true,
          manualActionReason: ssoResult.reason || 'SSO requires manual completion',
          tabId: ssoTab.id,
          skipRetry: true
        };
      }

      // SSO failed
      await chrome.tabs.remove(ssoTab.id).catch(() => {});
      return { success: false, error: ssoResult.error || 'SSO authentication failed' };

    } catch (error) {
      await chrome.tabs.remove(ssoTab.id).catch(() => {});
      throw error;
    }
  }

  /**
   * Check if already logged in by testing the target URL
   */
  async checkAlreadyLoggedIn(tool, credentials) {
    // FIX: Cache the "already logged in" result per tool for 3 minutes.
    // Previously, every one-click login opened a hidden background tab, waited
    // for it to fully load, then closed it — even for tools that use cookie
    // injection (where the check is meaningless before cookies are set).
    // This caused doubled load times and visible tab bar flicker on every click.
    const cacheKey = `loggedIn_${tool.id}`;
    const now = Date.now();
    if (this._loginCheckCache && this._loginCheckCache[cacheKey]) {
      const cached = this._loginCheckCache[cacheKey];
      if (now - cached.ts < 3 * 60 * 1000) {
        this.logger.debug('Using cached login check result', { tool: tool.name, success: cached.result.success });
        return cached.result;
      }
    }

    // Skip hidden-tab check for cookie-type tools: cookies haven't been injected
    // yet at this point, so the check will always return false. It wastes a full
    // page load. Just return false and let the strategy inject cookies.
    const credType = credentials?.type;
    if (credType === 'cookies' || credType === 'sessionBundle') {
      this.logger.debug('Skipping already-logged-in check for cookie-type tool', { tool: tool.name });
      return { success: false };
    }

    try {
      const hiddenTab = await this.createHiddenTab(tool.targetUrl);
      if (!hiddenTab) {
        return { success: false };
      }

      await this.waitForTabLoad(hiddenTab.id);
      await this.sleep(1000);

      const result = await this.successDetector.checkLoginSuccess(
        hiddenTab.id,
        tool,
        credentials?.successCheck
      );

      await chrome.tabs.remove(hiddenTab.id).catch(() => {});

      // Cache the result
      if (!this._loginCheckCache) this._loginCheckCache = {};
      this._loginCheckCache[cacheKey] = { result, ts: now };

      return result;
    } catch (error) {
      this.logger.warn('Already logged in check failed', { error: error.message });
      return { success: false };
    }
  }

  /**
   * Inject cookies with proper normalization
   */
  async injectCookies(targetUrl, cookies) {
    if (!cookies || cookies.length === 0) {
      return { success: false, count: 0 };
    }

    const domain = new URL(targetUrl).hostname;
    const isHttps = targetUrl.startsWith('https');
    let successCount = 0;
    const errors = [];

    for (const cookie of cookies) {
      try {
        // Normalize cookie domain
        let cookieDomain = cookie.domain || domain;
        
        if (cookieDomain && !cookieDomain.startsWith('.') && cookieDomain !== domain) {
          cookieDomain = '.' + cookieDomain;
        }

        // Normalize sameSite
        let sameSite = (cookie.sameSite || 'lax').toLowerCase();
        if (sameSite === 'none' || sameSite === 'no_restriction') {
          sameSite = 'no_restriction';
        } else if (sameSite === 'strict') {
          sameSite = 'strict';
        } else {
          sameSite = 'lax';
        }

        const secure = sameSite === 'no_restriction' ? true : (cookie.secure !== false && isHttps);
        const protocol = secure ? 'https' : 'http';
        const cleanDomain = cookieDomain.startsWith('.') ? cookieDomain.substring(1) : cookieDomain;
        const cookieUrl = `${protocol}://${cleanDomain}${cookie.path || '/'}`;

        const cookieDetails = {
          url: cookieUrl,
          name: cookie.name,
          value: cookie.value,
          path: cookie.path || '/',
          secure,
          httpOnly: cookie.httpOnly === true,
          sameSite
        };

        if (cookieDomain.startsWith('.')) {
          cookieDetails.domain = cookieDomain;
        }

        if (cookie.expirationDate) {
          cookieDetails.expirationDate = cookie.expirationDate;
        } else if (cookie.expires) {
          const expiresDate = new Date(cookie.expires);
          if (!isNaN(expiresDate.getTime())) {
            cookieDetails.expirationDate = expiresDate.getTime() / 1000;
          }
        } else {
          cookieDetails.expirationDate = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
        }

        const result = await chrome.cookies.set(cookieDetails);
        if (result) {
          successCount++;
        }
      } catch (error) {
        errors.push({ name: cookie.name, error: error.message });
      }
    }

    return {
      success: successCount > 0,
      count: successCount,
      total: cookies.length,
      errors
    };
  }

  /**
   * Inject storage data into a tab
   */
  async injectStorage(tabId, storageType, data) {
    if (!data || Object.keys(data).length === 0) {
      return { success: false, count: 0 };
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (storageData, type) => {
          const storage = type === 'sessionStorage' ? sessionStorage : localStorage;
          let count = 0;

          for (const [key, value] of Object.entries(storageData)) {
            try {
              const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
              storage.setItem(key, valueStr);
              count++;
            } catch (e) {}
          }

          return { success: count > 0, count };
        },
        args: [data, storageType]
      });

      return results[0]?.result || { success: false, count: 0 };
    } catch (error) {
      return { success: false, count: 0, error: error.message };
    }
  }

  /**
   * Wait for login form to appear
   */
  async waitForLoginForm(tabId, timeout = 8000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const checkDocument = (doc) => {
              const passwordField = doc.querySelector('input[type="password"]');
              const hasPassword = passwordField && passwordField.offsetParent !== null;

              const mfaSelectors = [
                'input[name*="otp"]', 'input[name*="code"]', 'input[name*="2fa"]',
                'input[name*="totp"]', 'input[name*="mfa"]', 'input[id*="otp"]',
                'input[placeholder*="code" i]', 'input[placeholder*="authenticator" i]'
              ];
              const hasMFA = mfaSelectors.some(s => {
                const el = doc.querySelector(s);
                return el && el.offsetParent !== null;
              });

              return { hasPassword, hasMFA };
            };

            let result = checkDocument(document);

            if (!result.hasPassword) {
              const iframes = document.querySelectorAll('iframe');
              for (const iframe of iframes) {
                try {
                  if (iframe.contentDocument) {
                    const iframeResult = checkDocument(iframe.contentDocument);
                    if (iframeResult.hasPassword) {
                      result = { ...iframeResult, inIframe: true };
                      break;
                    }
                  }
                } catch (e) {}
              }
            }

            return {
              hasForm: result.hasPassword,
              hasMFA: result.hasMFA,
              inIframe: result.inIframe || false
            };
          }
        });

        const result = results[0]?.result;
        if (result?.hasForm || result?.hasMFA) {
          return result;
        }
      } catch (error) {}

      await this.sleep(300);
    }

    return { hasForm: false, hasMFA: false };
  }

  /**
   * Monitor login result after form submission
   */
  async monitorLoginResult(tabId, tool, successCheck, timeout = 15000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const check = await this.successDetector.checkLoginSuccess(tabId, tool, successCheck);
        if (check.success) {
          return check;
        }

        const mfaCheck = await this.checkForMFA(tabId);
        if (mfaCheck.hasMFA) {
          return { success: false, hasMFA: true };
        }

        const errorCheck = await this.checkForLoginError(tabId);
        if (errorCheck.hasError) {
          return { 
            success: false, 
            hasError: true, 
            errorMessage: errorCheck.message 
          };
        }

      } catch (error) {}

      await this.sleep(500);
    }

    return { success: false, error: 'Login timeout' };
  }

  /**
   * Check for MFA/2FA on page
   */
  async checkForMFA(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const mfaIndicators = [
            'input[name*="otp"]', 'input[name*="code"]', 'input[name*="2fa"]',
            'input[name*="totp"]', 'input[name*="mfa"]', 'input[id*="otp"]',
            'input[placeholder*="code" i]', 'input[placeholder*="authenticator" i]'
          ];

          for (const selector of mfaIndicators) {
            const el = document.querySelector(selector);
            if (el && el.offsetParent !== null) {
              return { hasMFA: true };
            }
          }

          const bodyText = document.body.innerText.toLowerCase();
          const textIndicators = ['verification code', 'authenticator', '2-step', 'two-factor'];
          for (const text of textIndicators) {
            if (bodyText.includes(text)) {
              return { hasMFA: true };
            }
          }

          return { hasMFA: false };
        }
      });

      return results[0]?.result || { hasMFA: false };
    } catch (error) {
      return { hasMFA: false };
    }
  }

  /**
   * Check for login error messages
   */
  async checkForLoginError(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const errorSelectors = [
            '.error', '.error-message', '.alert-danger', '.alert-error',
            '[class*="error"]', '[class*="invalid"]', '[role="alert"]'
          ];

          const errorTexts = ['invalid', 'incorrect', 'wrong', 'failed', 'error'];

          for (const selector of errorSelectors) {
            try {
              const el = document.querySelector(selector);
              if (el && el.offsetParent !== null && el.textContent.trim().length > 0) {
                const text = el.textContent.toLowerCase();
                if (errorTexts.some(t => text.includes(t))) {
                  return { hasError: true, message: el.textContent.trim() };
                }
              }
            } catch (e) {}
          }

          return { hasError: false };
        }
      });

      return results[0]?.result || { hasError: false };
    } catch (error) {
      return { hasError: false };
    }
  }

  /**
   * Click SSO provider button
   */
  async clickSSOProvider(tabId, provider, customSelector) {
    const providerSelectors = {
      google: [
        '[data-provider="google"]', 'button[class*="google"]',
        'a[href*="google.com/o/oauth"]', '[aria-label*="Google"]'
      ],
      microsoft: [
        '[data-provider="microsoft"]', 'button[class*="microsoft"]',
        'a[href*="microsoft"]', '[aria-label*="Microsoft"]'
      ],
      github: [
        '[data-provider="github"]', 'button[class*="github"]',
        'a[href*="github.com/login/oauth"]', '[aria-label*="GitHub"]'
      ],
      okta: ['[data-provider="okta"]', 'button[class*="okta"]', 'a[href*="okta"]'],
      saml: ['[data-provider="sso"]', '[data-provider="saml"]', 'button[class*="sso"]', '.sso-login']
    };

    const selectors = customSelector 
      ? [customSelector]
      : (providerSelectors[provider] || []);

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selectorList) => {
          for (const selector of selectorList) {
            try {
              const btn = document.querySelector(selector);
              if (btn && btn.offsetParent !== null) {
                btn.click();
                return { clicked: true, selector };
              }
            } catch (e) {}
          }
          return { clicked: false };
        },
        args: [selectors]
      });

      return results[0]?.result || { clicked: false };
    } catch (error) {
      return { clicked: false };
    }
  }

  /**
   * Detect account chooser page
   */
  async detectAccountChooser(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const url = window.location.href.toLowerCase();
          const bodyText = document.body.innerText.toLowerCase();

          const urlIndicators = ['accountchooser', 'select_account', 'pick_account'];
          for (const i of urlIndicators) {
            if (url.includes(i)) return { detected: true };
          }

          const textIndicators = ['choose an account', 'select an account', 'pick an account'];
          for (const t of textIndicators) {
            if (bodyText.includes(t)) return { detected: true };
          }

          return { detected: false };
        }
      });

      return results[0]?.result || { detected: false };
    } catch (error) {
      return { detected: false };
    }
  }

  /**
   * Monitor SSO completion
   */
  async monitorSSOCompletion(tabId, postLoginUrl, tool, successCheck, timeout = 30000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const tab = await chrome.tabs.get(tabId);
        const currentUrl = tab.url;

        if (postLoginUrl && currentUrl.includes(postLoginUrl)) {
          return { success: true, currentUrl };
        }

        const check = await this.successDetector.checkLoginSuccess(tabId, tool, successCheck);
        if (check.success) {
          return check;
        }

        const accountChooser = await this.detectAccountChooser(tabId);
        if (accountChooser.detected) {
          return {
            success: false,
            requiresManualAction: true,
            reason: 'Account selection required'
          };
        }

        const isAuthPage = /\/(login|signin|auth|oauth|sso)/i.test(currentUrl);
        if (!isAuthPage) {
          const finalCheck = await this.successDetector.checkLoginSuccess(tabId, tool, successCheck);
          if (finalCheck.success || !finalCheck.isLoginPage) {
            return { success: true, currentUrl };
          }
        }

      } catch (error) {
        if (error.message.includes('No tab with id')) {
          return { success: false, error: 'Tab was closed' };
        }
      }

      await this.sleep(500);
    }

    return { success: false, error: 'SSO timeout' };
  }

  /**
   * Create a truly hidden tab using offscreen window
   * For hidden mode (?hidden=1), we create a minimized window so the login page doesn't flash
   */
  async createHiddenTab(url, options = {}) {
    const { trulyHidden = false } = options;
    
    try {
      if (trulyHidden) {
        // Create a window positioned off-screen or minimized
        // This prevents any visual flash of the login page
        const window = await chrome.windows.create({
          url,
          type: 'popup',
          state: 'minimized',
          width: 800,
          height: 600,
          left: -9999,  // Position off-screen as fallback
          top: -9999,
          focused: false
        });
        
        // Return the first tab in the new window
        if (window && window.tabs && window.tabs.length > 0) {
          return {
            ...window.tabs[0],
            _windowId: window.id,
            _isHiddenWindow: true
          };
        }
        return null;
      } else {
        // Regular hidden tab (inactive but visible in tab bar)
        const tab = await chrome.tabs.create({
          url,
          active: false,
          pinned: false
        });
        return tab;
      }
    } catch (error) {
      this.logger.warn('Failed to create hidden tab', { error: error.message });
      
      // Fallback: try regular tab if window creation fails
      try {
        const tab = await chrome.tabs.create({
          url,
          active: false,
          pinned: false
        });
        return tab;
      } catch (fallbackError) {
        this.logger.error('Fallback tab creation also failed', { error: fallbackError.message });
        return null;
      }
    }
  }

  /**
   * Close hidden tab and its window if applicable
   */
  async closeHiddenTab(tab) {
    try {
      if (tab._isHiddenWindow && tab._windowId) {
        // Close the entire hidden window
        await chrome.windows.remove(tab._windowId);
      } else {
        // Just close the tab
        await chrome.tabs.remove(tab.id);
      }
    } catch (error) {
      // Tab/window might already be closed
    }
  }

  /**
   * Make hidden tab visible (for MFA scenarios)
   */
  async makeTabVisible(tab) {
    try {
      if (tab._isHiddenWindow && tab._windowId) {
        // Restore and focus the window
        await chrome.windows.update(tab._windowId, {
          state: 'normal',
          focused: true,
          left: 100,
          top: 100
        });
      }
      // Make tab active
      await chrome.tabs.update(tab.id, { active: true });
    } catch (error) {
      this.logger.warn('Failed to make tab visible', { error: error.message });
    }
  }

  /**
   * Wait for tab to load
   */
  waitForTabLoad(tabId, timeout = 15000) {
    // FIX: Event-driven replacement for the 100ms polling loop.
    return new Promise((resolve) => {
      const deadline = setTimeout(async () => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        try {
          const tab = await chrome.tabs.get(tabId);
          resolve(tab);
        } catch (e) {
          resolve({ id: tabId, status: 'unknown' });
        }
      }, timeout);

      const onUpdated = (updatedTabId, changeInfo, tab) => {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
        clearTimeout(deadline);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(tab);
      };

      chrome.tabs.onUpdated.addListener(onUpdated);

      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return;
        if (tab && tab.status === 'complete') {
          clearTimeout(deadline);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve(tab);
        }
      });
    });
  }

  /**
   * Build actionable error message
   */
  buildActionableError(errors, tool) {
    if (errors.length === 0) {
      return 'Login failed - unknown error';
    }

    const lastError = errors[errors.length - 1];
    const errorMessages = {
      'Form fill failed': 'Could not find login form. The login page structure may have changed.',
      'Login form not found': 'Login form not detected. Try updating the tool configuration.',
      'Session injection failed': 'Session data could not be applied. Credentials may be expired.',
      'SSO authentication failed': 'SSO login did not complete. Please try logging in manually.'
    };

    for (const [key, message] of Object.entries(errorMessages)) {
      if (lastError.error?.includes(key)) {
        return message;
      }
    }

    return `Login failed: ${lastError.error}. Please try again or contact support.`;
  }

  /**
   * Cancel a login flow
   */
  cancelFlow(flowId) {
    this.cancelledFlows.add(flowId);
    const flow = this.activeFlows.get(flowId);
    if (flow && flow.tabId) {
      chrome.tabs.remove(flow.tabId).catch(() => {});
    }
  }

  /**
   * Update flow status
   */
  updateFlowStatus(flowId, status) {
    const flow = this.activeFlows.get(flowId);
    if (flow) {
      flow.status = status;
    }
  }

  /**
   * Complete flow and store result
   */
  completeFlow(flowId, result) {
    const flow = this.activeFlows.get(flowId);
    if (flow) {
      flow.status = 'completed';
      flow.endTime = Date.now();
      flow.duration = flow.endTime - flow.startTime;
      flow.result = result;
    }

    this.flowResults.set(flowId, {
      ...result,
      duration: flow?.duration
    });

    this.activeFlows.delete(flowId);
    this.cancelledFlows.delete(flowId);
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get flow status
   */
  getFlowStatus(flowId) {
    return this.activeFlows.get(flowId) || this.flowResults.get(flowId);
  }
}

// Singleton instance
let orchestratorInstance = null;

export function getOrchestrator() {
  if (!orchestratorInstance) {
    orchestratorInstance = new LoginOrchestrator();
  }
  return orchestratorInstance;
}

export default LoginOrchestrator;
