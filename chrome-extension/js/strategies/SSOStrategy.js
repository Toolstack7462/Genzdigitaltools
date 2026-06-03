/**
 * SSO/OAuth Strategy v2.1
 * 
 * Enhanced with:
 * - Support for provider button click + redirect monitoring
 * - New tab/popup OAuth flow support
 * - Account chooser detection
 * - Better provider button detection
 * - Redirect chain tracking
 * - Session extraction after successful OAuth
 */

import BaseStrategy from './BaseStrategy.js';

// Provider configurations
const PROVIDERS = {
  google: {
    name: 'Google',
    buttonSelectors: [
      '[data-provider="google"]', 'button[class*="google"]', 'a[class*="google"]',
      'a[href*="google.com/o/oauth"]', 'a[href*="accounts.google.com"]',
      '[aria-label*="Google"]', '.google-login', '#google-signin',
      'button[id*="google"]', 'a[id*="google"]', '[class*="google-button"]',
      '[data-testid*="google"]'
    ],
    accountChooserPatterns: [
      'accounts.google.com/accountchooser',
      'accounts.google.com/signin/selectaccount',
      'accounts.google.com/o/oauth2/v2/auth'
    ]
  },
  microsoft: {
    name: 'Microsoft',
    buttonSelectors: [
      '[data-provider="microsoft"]', 'button[class*="microsoft"]', 'a[class*="microsoft"]',
      'a[href*="microsoft"]', 'a[href*="login.microsoftonline.com"]',
      '[aria-label*="Microsoft"]', '.microsoft-login', '[class*="azure"]',
      '[data-testid*="microsoft"]'
    ],
    accountChooserPatterns: [
      'login.microsoftonline.com',
      'login.windows.net'
    ]
  },
  github: {
    name: 'GitHub',
    buttonSelectors: [
      '[data-provider="github"]', 'button[class*="github"]', 'a[class*="github"]',
      'a[href*="github.com/login/oauth"]', '[aria-label*="GitHub"]',
      '.github-login', '[data-testid*="github"]'
    ],
    accountChooserPatterns: []
  },
  okta: {
    name: 'Okta',
    buttonSelectors: [
      '[data-provider="okta"]', 'button[class*="okta"]', 'a[href*="okta"]',
      '[class*="okta-button"]', '[data-testid*="okta"]'
    ],
    accountChooserPatterns: ['okta.com']
  },
  saml: {
    name: 'SAML/SSO',
    buttonSelectors: [
      '[data-provider="sso"]', '[data-provider="saml"]', '[data-provider="enterprise"]',
      'button[class*="sso"]', 'a[href*="sso"]', '.sso-login', '.enterprise-login',
      '[class*="single-sign-on"]', 'button[class*="enterprise"]',
      '[data-testid*="sso"]', '[data-testid*="enterprise"]'
    ],
    accountChooserPatterns: []
  }
};

// Generic SSO button selectors
const GENERIC_SSO_SELECTORS = [
  '[class*="social-login"]', '[class*="oauth-button"]', '[class*="sso"]',
  '[class*="identity-provider"]', '[class*="idp-button"]'
];

class SSOStrategy extends BaseStrategy {
  constructor() {
    super('sso');
    this.timeout = 30000;
    this.pollInterval = 500;
  }

  /**
   * Execute SSO/OAuth login strategy
   */
  async execute(credentials, tool, tabId) {
    this.log('info', 'Executing SSO login', { 
      tool: tool.name,
      provider: credentials.payload?.provider 
    });
    
    const result = {
      success: false,
      method: 'sso',
      tabId,
      error: null,
      requiresManualAction: false,
      manualActionReason: null
    };

    try {
      const payload = credentials.payload;
      const provider = payload?.provider;
      const authStartUrl = payload?.authStartUrl || tool.loginUrl;
      const postLoginUrl = payload?.postLoginUrl || tool.targetUrl;
      const autoClick = payload?.autoClick !== false;
      const buttonSelector = payload?.buttonSelector;

      // Create tab for SSO
      let ssoTab;
      if (tabId) {
        // Use existing tab
        await chrome.tabs.update(tabId, { url: authStartUrl, active: true });
        ssoTab = await chrome.tabs.get(tabId);
      } else {
        // Create new tab
        ssoTab = await chrome.tabs.create({ url: authStartUrl, active: true });
      }

      // Wait for page to load
      await this.waitForTabLoad(ssoTab.id);
      await this.sleep(1000);

      // Try to click SSO provider button if autoClick is enabled
      if (autoClick && (provider || buttonSelector)) {
        const clickResult = await this.clickProviderButton(
          ssoTab.id, 
          provider, 
          buttonSelector
        );
        
        if (clickResult.clicked) {
          this.log('debug', 'Clicked SSO provider button', { selector: clickResult.selector });
        } else {
          this.log('warn', 'Could not find SSO provider button');
        }
      }

      // Wait a moment for redirect/popup
      await this.sleep(1500);

      // Check for account chooser
      const accountChooser = await this.detectAccountChooser(ssoTab.id, provider);
      if (accountChooser.detected) {
        result.requiresManualAction = true;
        result.manualActionReason = 'Please select an account to continue';
        result.tabId = ssoTab.id;
        return result;
      }

      // Monitor for SSO completion
      const ssoResult = await this.monitorSSOCompletion(
        ssoTab.id,
        postLoginUrl,
        tool,
        this.timeout
      );

      if (ssoResult.success) {
        result.success = true;
        result.tabId = ssoTab.id;
        result.finalUrl = ssoResult.currentUrl;

        // Extract session data for future use
        if (ssoResult.sessionData) {
          result.sessionData = ssoResult.sessionData;
        }
      } else if (ssoResult.requiresManualAction) {
        result.requiresManualAction = true;
        result.manualActionReason = ssoResult.reason || 'SSO requires manual completion';
        result.tabId = ssoTab.id;
      } else {
        result.error = ssoResult.error || 'SSO authentication failed';
        // Close tab on failure
        await chrome.tabs.remove(ssoTab.id).catch(() => {});
      }

    } catch (error) {
      this.log('error', 'SSO login error', { error: error.message });
      result.error = error.message;
    }

    return result;
  }

  /**
   * Click SSO provider button
   */
  async clickProviderButton(tabId, provider, customSelector) {
    const providerConfig = provider ? PROVIDERS[provider.toLowerCase()] : null;
    
    // Build selector list
    const selectors = [];
    
    if (customSelector) {
      selectors.push(customSelector);
    }
    
    if (providerConfig) {
      selectors.push(...providerConfig.buttonSelectors);
    }
    
    // Add generic SSO selectors as fallback
    selectors.push(...GENERIC_SSO_SELECTORS);

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selectorList, providerName) => {
          // Helper to click element
          const clickEl = (el) => {
            el.focus();
            el.click();
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return true;
          };

          // Try exact selectors first
          for (const selector of selectorList) {
            if (!selector) continue;
            try {
              const btn = document.querySelector(selector);
              if (btn && btn.offsetParent !== null) {
                clickEl(btn);
                return { clicked: true, selector };
              }
            } catch (e) {}
          }

          // Try to find by text content if provider name is given
          if (providerName) {
            const buttons = document.querySelectorAll('button, a, [role="button"]');
            for (const btn of buttons) {
              if (btn.offsetParent !== null) {
                const text = btn.textContent.toLowerCase();
                const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                if (text.includes(providerName.toLowerCase()) || 
                    ariaLabel.includes(providerName.toLowerCase())) {
                  clickEl(btn);
                  return { clicked: true, selector: 'text_match', text: btn.textContent };
                }
              }
            }
          }

          // Try to find any button with SSO-related text
          const ssoTexts = ['sign in with', 'login with', 'continue with', 'sso', 'single sign-on'];
          const buttons = document.querySelectorAll('button, a, [role="button"]');
          for (const btn of buttons) {
            if (btn.offsetParent !== null) {
              const text = btn.textContent.toLowerCase();
              if (ssoTexts.some(t => text.includes(t))) {
                clickEl(btn);
                return { clicked: true, selector: 'sso_text_match', text: btn.textContent };
              }
            }
          }

          return { clicked: false };
        },
        args: [selectors, providerConfig?.name]
      });

      return results[0]?.result || { clicked: false };
    } catch (error) {
      return { clicked: false, error: error.message };
    }
  }

  /**
   * Detect account chooser/selection page
   */
  async detectAccountChooser(tabId, provider) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const currentUrl = tab.url.toLowerCase();

      // Check URL patterns
      const providerConfig = provider ? PROVIDERS[provider.toLowerCase()] : null;
      let urlPatterns = [];
      
      if (providerConfig) {
        urlPatterns = providerConfig.accountChooserPatterns;
      }

      // Add generic patterns
      urlPatterns = urlPatterns.concat([
        'accountchooser', 'account_chooser', 'select_account',
        'selectaccount', 'pick_account'
      ]);

      for (const pattern of urlPatterns) {
        if (currentUrl.includes(pattern)) {
          return { detected: true, type: 'url', pattern };
        }
      }

      // Check page content
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const bodyText = document.body.innerText.toLowerCase();
          
          const textIndicators = [
            'choose an account', 'select an account', 'pick an account',
            'which account', 'sign in with', 'use another account',
            'multiple accounts'
          ];

          for (const text of textIndicators) {
            if (bodyText.includes(text)) {
              return { detected: true, type: 'text', indicator: text };
            }
          }

          // Check for multiple account elements
          const accountElements = document.querySelectorAll(
            '[data-identifier], [data-email], .account-list li, [class*="account-picker"] > *'
          );
          
          if (accountElements.length > 1) {
            return { detected: true, type: 'multiple_accounts', count: accountElements.length };
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
   * Monitor for SSO completion
   */
  async monitorSSOCompletion(tabId, postLoginUrl, tool, timeout) {
    // FIX: Replaced polling loop (500ms interval × 60 iterations) with an
    // event-driven chrome.tabs.onUpdated listener. The polling approach missed
    // rapid intermediate redirects in PKCE/OAuth flows and ran executeScript
    // on every tick. We now react instantly to each navigation completion and
    // only run DOM checks when the URL is actually stable.
    return new Promise((resolve) => {
      const deadline = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        resolve({ success: false, error: 'SSO timeout' });
      }, timeout);

      const cleanup = (result) => {
        clearTimeout(deadline);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        resolve(result);
      };

      const onRemoved = (removedTabId) => {
        if (removedTabId === tabId) {
          cleanup({ success: false, error: 'Tab was closed' });
        }
      };

      const onUpdated = async (updatedTabId, changeInfo, tab) => {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
        const currentUrl = tab.url || '';

        this.log('debug', 'SSO URL change', { url: currentUrl.substring(0, 100) });

        try {
          // Check if we've reached the post-login URL
          if (postLoginUrl && this.urlMatches(currentUrl, postLoginUrl)) {
            const sessionData = await this.extractSessionData(tabId);
            return cleanup({ success: true, currentUrl, sessionData });
          }

          // Check for account chooser — requires manual selection
          const accountChooser = await this.detectAccountChooser(tabId);
          if (accountChooser.detected) {
            return cleanup({ success: false, requiresManualAction: true, reason: 'Please select an account' });
          }

          // Check for MFA
          const mfaCheck = await this.checkForMFA(tabId);
          if (mfaCheck.hasMFA) {
            return cleanup({ success: false, requiresManualAction: true, reason: 'MFA/2FA required - please complete verification' });
          }

          // Check for consent screen
          const consentCheck = await this.checkForConsent(tabId);
          if (consentCheck.hasConsent) {
            return cleanup({ success: false, requiresManualAction: true, reason: 'Please approve the permission request' });
          }

          // Check if we've left all auth pages and are now logged in
          const isAuthPage = this.isAuthPage(currentUrl);
          if (!isAuthPage) {
            const loggedInCheck = await this.checkLoggedIn(tabId);
            if (loggedInCheck.loggedIn) {
              const sessionData = await this.extractSessionData(tabId);
              return cleanup({ success: true, currentUrl, sessionData });
            }
          }
        } catch (error) {
          if (error.message && error.message.includes('No tab with id')) {
            cleanup({ success: false, error: 'Tab was closed' });
          }
          // Other errors: keep listening — might be a transient redirect
        }
      };

      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
    });
  }

  /**
   * Check if URL matches target
   */
  urlMatches(currentUrl, targetUrl) {
    try {
      const current = new URL(currentUrl);
      const target = new URL(targetUrl);
      
      // Same domain and not on login/auth path
      return current.hostname === target.hostname && 
             !this.isAuthPage(currentUrl);
    } catch (e) {
      return currentUrl.includes(targetUrl);
    }
  }

  /**
   * Check if URL is an auth page
   */
  isAuthPage(url) {
    const authPatterns = [
      /\/login/i, /\/signin/i, /\/sign-in/i, /\/auth/i,
      /\/oauth/i, /\/sso/i, /\/saml/i,
      /accounts\.google\.com/i, /login\.microsoftonline\.com/i,
      /github\.com\/login/i, /auth0\.com/i, /okta\.com/i
    ];

    return authPatterns.some(pattern => pattern.test(url));
  }

  /**
   * Check if user is logged in
   */
  async checkLoggedIn(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Check for logged-in indicators
          const loggedInSelectors = [
            '[class*="logout"]', '[class*="signout"]', 'a[href*="logout"]',
            '[class*="user-menu"]', '[class*="user-avatar"]', '[class*="profile-menu"]',
            '[data-testid*="user"]', '[data-testid*="avatar"]'
          ];

          for (const selector of loggedInSelectors) {
            const el = document.querySelector(selector);
            if (el && el.offsetParent !== null) {
              return { loggedIn: true, indicator: selector };
            }
          }

          // Check localStorage for auth tokens
          const authKeys = ['token', 'auth_token', 'access_token', 'jwt', 'session'];
          for (const key of authKeys) {
            const value = localStorage.getItem(key);
            if (value && value.length > 10) {
              return { loggedIn: true, indicator: `localStorage:${key}` };
            }
          }

          // Check for login form (should not exist if logged in)
          const hasLoginForm = document.querySelector('input[type="password"]');
          if (hasLoginForm && hasLoginForm.offsetParent !== null) {
            return { loggedIn: false };
          }

          return { loggedIn: false };
        }
      });

      return results[0]?.result || { loggedIn: false };
    } catch (error) {
      return { loggedIn: false };
    }
  }

  /**
   * Check for MFA page
   */
  async checkForMFA(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const mfaSelectors = [
            'input[name*="otp"]', 'input[name*="code"]', 'input[name*="2fa"]',
            'input[name*="totp"]', 'input[name*="mfa"]', '[class*="mfa"]',
            '[class*="two-factor"]', '[class*="verification"]'
          ];

          for (const selector of mfaSelectors) {
            const el = document.querySelector(selector);
            if (el && el.offsetParent !== null) {
              return { hasMFA: true };
            }
          }

          const bodyText = document.body.innerText.toLowerCase();
          const mfaTexts = ['verification code', 'authenticator', '2-step', 'enter code'];
          for (const text of mfaTexts) {
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
   * Check for consent/permission page
   */
  async checkForConsent(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const consentSelectors = [
            '[class*="consent"]', '[class*="permission"]', '[class*="authorize"]',
            '[id*="consent"]', '[id*="permission"]'
          ];

          for (const selector of consentSelectors) {
            const el = document.querySelector(selector);
            if (el && el.offsetParent !== null) {
              return { hasConsent: true };
            }
          }

          const bodyText = document.body.innerText.toLowerCase();
          const consentTexts = ['wants to access', 'requesting access', 'allow', 'grant permission'];
          for (const text of consentTexts) {
            if (bodyText.includes(text)) {
              return { hasConsent: true };
            }
          }

          return { hasConsent: false };
        }
      });

      return results[0]?.result || { hasConsent: false };
    } catch (error) {
      return { hasConsent: false };
    }
  }

  /**
   * Extract session data after successful login
   */
  async extractSessionData(tabId) {
    try {
      // Get cookies
      const tab = await chrome.tabs.get(tabId);
      const domain = new URL(tab.url).hostname;
      const cookies = await chrome.cookies.getAll({ domain });

      // Get localStorage/sessionStorage
      const storageResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const localData = {};
          const sessionData = {};
          
          const authKeys = [
            'token', 'auth_token', 'access_token', 'jwt', 'user',
            'session', 'id_token', 'refresh_token'
          ];

          for (const key of authKeys) {
            const localValue = localStorage.getItem(key);
            if (localValue) {
              localData[key] = localValue;
            }
            const sessionValue = sessionStorage.getItem(key);
            if (sessionValue) {
              sessionData[key] = sessionValue;
            }
          }

          return { localStorage: localData, sessionStorage: sessionData };
        }
      });

      const storage = storageResults[0]?.result || {};

      return {
        cookies: cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expirationDate: c.expirationDate
        })),
        localStorage: storage.localStorage || {},
        sessionStorage: storage.sessionStorage || {}
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Validate SSO credentials
   */
  async validate(credentials, tool) {
    const payload = credentials?.payload;
    
    if (!payload) {
      return { valid: false, error: 'No SSO configuration' };
    }

    // Need either authStartUrl or a provider configured
    if (!payload.authStartUrl && !payload.provider && !tool.loginUrl) {
      return { 
        valid: false, 
        error: 'Missing authStartUrl or provider' 
      };
    }

    return { valid: true };
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
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default SSOStrategy;
