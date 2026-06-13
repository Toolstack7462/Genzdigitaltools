/**
 * Success Detector - Determines if login was successful
 * 
 * Uses multiple signals to determine login success:
 * 1. URL checks (not on login page, matches expected URL)
 * 2. Element checks (dashboard elements present, login form absent)
 * 3. Cookie checks (session cookies present)
 * 4. Storage checks (auth tokens in localStorage/sessionStorage)
 * 5. Custom success checks from tool configuration
 */

import { Logger } from './Logger.js';

export class SuccessDetector {
  constructor() {
    this.logger = new Logger('SuccessDetector');
  }

  /**
   * Check if login was successful
   * 
   * @param {number} tabId - Tab ID to check
   * @param {Object} tool - Tool configuration
   * @param {Object} customChecks - Custom success checks from credentials
   * @returns {Promise<Object>} Check result
   */
  /**
   * FIX21: Single executeScript call that atomically reads URL + DOM state
   * in one round-trip. Avoids TOCTOU race where page navigates between
   * separate chrome.tabs.get() and DOM-check calls.
   */
  async checkLoginSuccess(tabId, tool, customChecks = {}) {
    const result = {
      success: false,
      isLoginPage: false,
      currentUrl: null,
      checks: { url: null, element: null, cookie: null, storage: null, custom: null }
    };

    try {
      // FIX21: Atomic snapshot — single script execution captures URL + DOM together
      const snapshots = await chrome.scripting.executeScript({
        target: { tabId },
        func: (checks, loginPatterns) => {
          const url = window.location.href;
          const readyState = document.readyState;

          // URL checks
          const isLoginUrl = loginPatterns.some(p => new RegExp(p, 'i').test(url));

          // DOM: login form indicators
          const hasPasswordField = !!document.querySelector('input[type="password"]');
          const loginFormSel = ['form[action*="login"]','form[action*="signin"]','#login-form','.login-form'];
          const hasLoginForm = hasPasswordField || loginFormSel.some(s => {
            try { const el = document.querySelector(s); return el && el.offsetParent !== null; } catch { return false; }
          });

          // DOM: logged-in indicators
          const loggedInSel = [
            '[class*="logout"]','[class*="signout"]','a[href*="logout"]',
            '[class*="user-menu"]','[class*="user-avatar"]','[class*="profile-menu"]'
          ];
          const hasLoggedIn = loggedInSel.some(s => {
            try { const el = document.querySelector(s); return el && el.offsetParent !== null; } catch { return false; }
          });

          // Custom element checks
          let customElementOk = null;
          if (checks.elementExists) {
            try { const el = document.querySelector(checks.elementExists); customElementOk = !!(el && el.offsetParent !== null); } catch { customElementOk = false; }
          }
          let customElementGone = null;
          if (checks.elementNotExists) {
            try { const el = document.querySelector(checks.elementNotExists); customElementGone = !(el && el.offsetParent !== null); } catch { customElementGone = true; }
          }

          // Storage checks
          const authKeys = ['token','auth_token','access_token','jwt','user','session','id_token'];
          const hasStoredAuth = authKeys.some(k => {
            try { return !!(localStorage.getItem(k) || sessionStorage.getItem(k)); } catch { return false; }
          });

          // MFA detection
          const mfaSel = ['input[name*="otp"]','input[name*="mfa"]','input[name*="code"]','input[name*="2fa"]','[class*="verification-code"]'];
          const mfaDetected = mfaSel.some(s => {
            try { const el = document.querySelector(s); return el && el.offsetParent !== null; } catch { return false; }
          });

          return { url, readyState, isLoginUrl, hasLoginForm, hasLoggedIn, hasStoredAuth, mfaDetected, customElementOk, customElementGone };
        },
        args: [customChecks, [
          '\\/login', '\\/signin', '\\/sign-in', '\\/auth(?:enticate)?',
          '\\/session\\/new', 'accounts\\.google\\.com', 'login\\.microsoftonline\\.com'
        ]]
      });

      const snap = snapshots[0]?.result;
      if (!snap) return result;

      result.currentUrl = snap.url;
      result.isLoginPage = snap.isLoginUrl;
      result.mfaDetected = snap.mfaDetected;

      // Build check results from the atomic snapshot
      try {
        const targetHost = new URL(tool.targetUrl).hostname;
        const currentHost = new URL(snap.url).hostname;
        result.checks.url = { success: currentHost === targetHost && !snap.isLoginUrl };
      } catch { result.checks.url = { success: false }; }

      result.checks.element = {
        success: snap.hasLoggedIn && !snap.hasLoginForm &&
          (snap.customElementOk !== false) && (snap.customElementGone !== false)
      };
      result.checks.storage = { success: snap.hasStoredAuth };

      // Cookie check can run in parallel since it reads a different context
      result.checks.cookie = await this.checkCookies(tool.targetUrl, customChecks);

      result.success = this.determineSuccess(result);

      this.logger.debug('Login success check complete', {
        success: result.success,
        isLoginPage: result.isLoginPage,
        url: snap.url?.substring(0, 50)
      });

      return result;
    } catch (err) {
      this.logger.warn('Success check failed', { error: err.message });
      return result;
    }
  }

  /**
   * Check URL-based indicators
   */
  checkUrl(currentUrl, tool, customChecks) {
    if (!currentUrl) {
      return { success: false, reason: 'No URL' };
    }

    const result = {
      success: false,
      isLoginPage: false,
      matchesTarget: false,
      reasons: []
    };

    // Check if URL is a login page
    result.isLoginPage = this.isLoginPageUrl(currentUrl);
    if (result.isLoginPage) {
      result.reasons.push('URL matches login page pattern');
    }

    // Check if URL matches target (post-login) URL
    if (tool.targetUrl) {
      try {
        const targetHost = new URL(tool.targetUrl).hostname;
        const currentHost = new URL(currentUrl).hostname;
        result.matchesTarget = currentHost === targetHost && !result.isLoginPage;
        
        if (result.matchesTarget) {
          result.reasons.push('URL matches target domain and not on login page');
        }
      } catch (e) {}
    }

    // Check custom URL patterns
    if (customChecks.urlIncludes) {
      const includes = currentUrl.includes(customChecks.urlIncludes);
      if (includes) {
        result.reasons.push(`URL includes: ${customChecks.urlIncludes}`);
        result.matchesTarget = true;
      }
    }

    if (customChecks.urlExcludes) {
      const excludes = currentUrl.includes(customChecks.urlExcludes);
      if (excludes) {
        result.reasons.push(`URL contains excluded pattern: ${customChecks.urlExcludes}`);
        result.matchesTarget = false;
      }
    }

    if (customChecks.urlPattern) {
      try {
        const regex = new RegExp(customChecks.urlPattern);
        if (regex.test(currentUrl)) {
          result.reasons.push('URL matches custom pattern');
          result.matchesTarget = true;
        }
      } catch (e) {}
    }

    // Success if not on login page and matches target
    result.success = !result.isLoginPage && result.matchesTarget;

    return result;
  }

  /**
   * Check DOM state (elements, storage)
   */
  async checkDomState(tabId, customChecks) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (checks) => {
          const result = {
            element: { success: false, reasons: [] },
            storage: { success: false, reasons: [] }
          };

          // ========== Element Checks ==========
          
          // Check for logged-in indicators
          const loggedInSelectors = [
            '[class*="logout"]', '[class*="signout"]', '[class*="sign-out"]',
            '[id*="logout"]', '[id*="signout"]', 'a[href*="logout"]',
            '[class*="user-menu"]', '[class*="user-avatar"]', '[class*="profile-menu"]',
            '[class*="account-menu"]', '[data-testid*="user"]', '[data-testid*="avatar"]',
            '[class*="dashboard"]', '[class*="home-page"]', '[class*="main-content"]',
            'nav [class*="user"]', 'header [class*="avatar"]'
          ];

          for (const selector of loggedInSelectors) {
            try {
              const el = document.querySelector(selector);
              if (el && el.offsetParent !== null) {
                result.element.success = true;
                result.element.reasons.push(`Found logged-in indicator: ${selector}`);
                break;
              }
            } catch (e) {}
          }

          // Check for login form (should NOT exist if logged in)
          const loginFormSelectors = [
            'input[type="password"]',
            'form[action*="login"]', 'form[action*="signin"]',
            '#login-form', '.login-form', '[class*="login-form"]'
          ];

          let hasLoginForm = false;
          for (const selector of loginFormSelectors) {
            try {
              const el = document.querySelector(selector);
              if (el && el.offsetParent !== null) {
                hasLoginForm = true;
                result.element.reasons.push(`Login form present: ${selector}`);
                break;
              }
            } catch (e) {}
          }

          if (hasLoginForm) {
            result.element.success = false;
          }

          // Custom element checks
          if (checks.elementExists) {
            try {
              const el = document.querySelector(checks.elementExists);
              if (el && el.offsetParent !== null) {
                result.element.success = true;
                result.element.reasons.push(`Custom element found: ${checks.elementExists}`);
              } else {
                result.element.reasons.push(`Custom element not found: ${checks.elementExists}`);
              }
            } catch (e) {}
          }

          if (checks.elementNotExists) {
            try {
              const el = document.querySelector(checks.elementNotExists);
              if (el && el.offsetParent !== null) {
                result.element.success = false;
                result.element.reasons.push(`Forbidden element present: ${checks.elementNotExists}`);
              }
            } catch (e) {}
          }

          // ========== Storage Checks ==========
          
          const authStorageKeys = [
            'token', 'auth_token', 'access_token', 'jwt', 'user',
            'session', 'auth', 'id_token', 'refresh_token'
          ];

          // Check localStorage
          for (const key of authStorageKeys) {
            try {
              const value = localStorage.getItem(key);
              if (value && value.length > 10) {
                result.storage.success = true;
                result.storage.reasons.push(`localStorage has: ${key}`);
                break;
              }
            } catch (e) {}
          }

          // Check sessionStorage
          if (!result.storage.success) {
            for (const key of authStorageKeys) {
              try {
                const value = sessionStorage.getItem(key);
                if (value && value.length > 10) {
                  result.storage.success = true;
                  result.storage.reasons.push(`sessionStorage has: ${key}`);
                  break;
                }
              } catch (e) {}
            }
          }

          // Custom storage checks
          if (checks.storageKeys) {
            const keys = Array.isArray(checks.storageKeys) ? checks.storageKeys : [checks.storageKeys];
            for (const key of keys) {
              const value = localStorage.getItem(key) || sessionStorage.getItem(key);
              if (value) {
                result.storage.success = true;
                result.storage.reasons.push(`Custom storage key found: ${key}`);
              }
            }
          }

          return result;
        },
        args: [customChecks]
      });

      return results[0]?.result || {
        element: { success: false, reasons: [] },
        storage: { success: false, reasons: [] }
      };

    } catch (error) {
      return {
        element: { success: false, reasons: ['Script execution failed'] },
        storage: { success: false, reasons: ['Script execution failed'] }
      };
    }
  }

  /**
   * Check cookies for session indicators
   */
  async checkCookies(targetUrl, customChecks) {
    const result = {
      success: false,
      reasons: []
    };

    try {
      const domain = new URL(targetUrl).hostname;
      const cookies = await chrome.cookies.getAll({ domain });

      // Common session cookie names
      const sessionCookieNames = [
        'session', 'sessionid', 'session_id', 'auth', 'auth_token',
        'access_token', 'jwt', 'token', 'user_token', 'logged_in',
        'is_logged_in', 'sid', '_session', 'connect.sid'
      ];

      for (const cookie of cookies) {
        const nameLower = cookie.name.toLowerCase();
        if (sessionCookieNames.some(n => nameLower.includes(n))) {
          result.success = true;
          result.reasons.push(`Session cookie found: ${cookie.name}`);
          break;
        }
      }

      // Custom cookie checks
      if (customChecks.cookieNames) {
        const names = Array.isArray(customChecks.cookieNames) 
          ? customChecks.cookieNames 
          : [customChecks.cookieNames];
        
        for (const name of names) {
          const found = cookies.find(c => c.name === name || c.name.includes(name));
          if (found) {
            result.success = true;
            result.reasons.push(`Custom cookie found: ${name}`);
          }
        }
      }

      if (cookies.length === 0) {
        result.reasons.push('No cookies found for domain');
      }

    } catch (error) {
      result.reasons.push(`Cookie check error: ${error.message}`);
    }

    return result;
  }

  /**
   * Apply custom success checks
   */
  async applyCustomChecks(tabId, customChecks) {
    const result = {
      success: true, // Start true, any failure sets to false
      reasons: []
    };

    try {
      const tab = await chrome.tabs.get(tabId);
      const currentUrl = tab.url;

      // URL includes check
      if (customChecks.urlIncludes) {
        if (!currentUrl.includes(customChecks.urlIncludes)) {
          result.success = false;
          result.reasons.push(`URL does not include: ${customChecks.urlIncludes}`);
        }
      }

      // URL excludes check
      if (customChecks.urlExcludes) {
        if (currentUrl.includes(customChecks.urlExcludes)) {
          result.success = false;
          result.reasons.push(`URL contains excluded pattern: ${customChecks.urlExcludes}`);
        }
      }

      // URL pattern check
      if (customChecks.urlPattern) {
        const regex = new RegExp(customChecks.urlPattern);
        if (!regex.test(currentUrl)) {
          result.success = false;
          result.reasons.push(`URL does not match pattern: ${customChecks.urlPattern}`);
        }
      }

      // Element exists check
      if (customChecks.elementExists) {
        const elementCheck = await chrome.scripting.executeScript({
          target: { tabId },
          func: (selector) => {
            const el = document.querySelector(selector);
            return el && el.offsetParent !== null;
          },
          args: [customChecks.elementExists]
        });

        if (!elementCheck[0]?.result) {
          result.success = false;
          result.reasons.push(`Required element not found: ${customChecks.elementExists}`);
        }
      }

      // Element not exists check
      if (customChecks.elementNotExists) {
        const elementCheck = await chrome.scripting.executeScript({
          target: { tabId },
          func: (selector) => {
            const el = document.querySelector(selector);
            return el && el.offsetParent !== null;
          },
          args: [customChecks.elementNotExists]
        });

        if (elementCheck[0]?.result) {
          result.success = false;
          result.reasons.push(`Forbidden element present: ${customChecks.elementNotExists}`);
        }
      }

    } catch (error) {
      result.success = false;
      result.reasons.push(`Custom check error: ${error.message}`);
    }

    return result;
  }

  /**
   * Determine overall success from all checks
   */
  determineSuccess(result) {
    // If still on login page, not successful
    if (result.isLoginPage) {
      return false;
    }

    // If custom checks provided and failed, not successful
    if (result.checks.custom && !result.checks.custom.success) {
      return false;
    }

    const urlSuccess = result.checks.url?.success;
    const elementSuccess = result.checks.element?.success;
    const storageSuccess = result.checks.storage?.success;

    // FIX: cookieSuccess removed from base determination. Most login pages set
    // cookies before authentication (CSRF tokens, analytics, session init), so
    // checking for any cookie presence generates frequent false positives. It
    // caused checkAlreadyLoggedIn() to report success on unauthenticated pages,
    // skipping login entirely. Cookie presence is only meaningful when the tool
    // has explicit customChecks.cookieName configured (handled via applyCustomChecks).
    //
    // Success requires at least one strong indicator:
    // 1. URL check: not on login page AND matches target URL pattern
    // 2. Element check: logged-in DOM indicators present (avatar, logout link, etc.)
    // 3. Storage check: auth token found in localStorage/sessionStorage
    return urlSuccess || elementSuccess || storageSuccess;
  }

  /**
   * Check if URL is a login page
   */
  isLoginPageUrl(url) {
    if (!url) return true;
    
    const loginPatterns = [
      /\/login/i,
      /\/signin/i,
      /\/sign-in/i,
      /\/auth(?:enticate)?/i,
      /\/session\/new/i,
      /\/account\/login/i,
      /\/user\/login/i,
      /\/oauth/i,
      /\/sso/i,
      /accounts\.google\.com/i,
      /login\.microsoftonline\.com/i,
      /github\.com\/login/i,
      /auth0\.com/i
    ];

    return loginPatterns.some(pattern => pattern.test(url));
  }

  /**
   * Quick check if logged in (lightweight version)
   */
  async quickCheck(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      
      // If URL is not a login page, might be logged in
      if (!this.isLoginPageUrl(tab.url)) {
        // Quick DOM check
        const result = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            // Check for password field (indicates login page)
            const hasPassword = document.querySelector('input[type="password"]');
            if (hasPassword && hasPassword.offsetParent !== null) {
              return false;
            }

            // Check for logout button (indicates logged in)
            const hasLogout = document.querySelector(
              '[class*="logout"], [href*="logout"], [class*="signout"]'
            );
            if (hasLogout && hasLogout.offsetParent !== null) {
              return true;
            }

            // Check for auth token in storage
            const hasToken = localStorage.getItem('token') || 
                           localStorage.getItem('access_token') ||
                           sessionStorage.getItem('token');
            return !!hasToken;
          }
        });

        return result[0]?.result || false;
      }

      return false;
    } catch (error) {
      return false;
    }
  }
}

export default SuccessDetector;
