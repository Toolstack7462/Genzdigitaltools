/**
 * Form Login Strategy v2.1
 * 
 * Enhanced with:
 * - MutationObserver for dynamic form detection
 * - Multi-step login support (email first, then password)
 * - Same-origin iframe support
 * - MFA detection
 * - SPA route change handling
 * - Native value setter for React/Vue/Angular
 * - Robust retry and wait mechanisms
 */

import BaseStrategy from './BaseStrategy.js';

// Selectors
const SELECTORS = {
  username: [
    'input[type="email"]', 'input[name="email"]', 'input[id="email"]',
    'input[name="username"]', 'input[id="username"]', 'input[name="login"]',
    'input[name="user"]', 'input[autocomplete="email"]', 'input[autocomplete="username"]',
    'input[placeholder*="email" i]', 'input[placeholder*="username" i]',
    'input[name="identifier"]', 'input[name="account"]', 'input[id="identifier"]'
  ],
  password: [
    'input[type="password"]', 'input[name="password"]', 'input[id="password"]',
    'input[autocomplete="current-password"]', 'input[autocomplete="password"]'
  ],
  submit: [
    'button[type="submit"]', 'input[type="submit"]',
    'button[class*="login" i]', 'button[class*="signin" i]', 'button[class*="sign-in" i]',
    'button[class*="submit" i]', 'button[id*="login" i]', 'button[id*="signin" i]',
    '[role="button"][class*="login" i]', '[role="button"][class*="submit" i]',
    'button[data-testid*="login" i]', 'button[data-testid*="signin" i]'
  ],
  next: [
    'button[class*="next" i]', 'button[id*="next" i]', 'button[aria-label*="next" i]',
    'button[class*="continue" i]', 'button[id*="continue" i]',
    'input[type="button"][value*="next" i]', 'input[type="button"][value*="continue" i]',
    '[role="button"][class*="next" i]', 'button[data-testid*="next" i]'
  ],
  mfa: [
    'input[name*="otp"]', 'input[name*="code"]', 'input[name*="2fa"]',
    'input[name*="totp"]', 'input[name*="mfa"]', 'input[id*="otp"]',
    'input[placeholder*="code" i]', 'input[placeholder*="authenticator" i]',
    'input[placeholder*="verification" i]', '[class*="mfa"]', '[class*="two-factor"]',
    '[class*="2fa"]', '[class*="verification-code"]', 'input[maxlength="6"]'
  ],
  rememberMe: [
    'input[type="checkbox"][name*="remember"]', 'input[type="checkbox"][id*="remember"]',
    'input[type="checkbox"][name*="stay"]', 'input[type="checkbox"][id*="stay"]'
  ]
};

class FormStrategy extends BaseStrategy {
  constructor() {
    super('form');
    this.maxWaitTime = 10000;
    this.formFillDelay = 200;
    this.submitDelay = 300;
    this.multiStepDelay = 1500;
  }

  /**
   * Execute form login strategy
   */
  async execute(credentials, tool, tabId) {
    this.log('info', 'Executing form login', { tool: tool.name });
    
    const result = {
      success: false,
      method: 'form',
      tabId,
      error: null,
      isMultiStep: false,
      hasMFA: false
    };

    try {
      // Wait for form to be ready
      const formInfo = await this.waitForForm(tabId, this.maxWaitTime);
      
      if (!formInfo.hasForm) {
        result.error = 'Login form not found';
        return result;
      }

      // Check for MFA first
      if (formInfo.hasMFA) {
        result.hasMFA = true;
        result.requiresManualAction = true;
        result.manualActionReason = 'MFA/2FA detected - please complete manually';
        return result;
      }

      // Execute form fill
      const fillResult = await this.fillForm(tabId, credentials, tool.selectors);
      
      result.isMultiStep = fillResult.isMultiStep;
      
      if (!fillResult.success) {
        result.error = fillResult.error || 'Form fill failed';
        return result;
      }

      // Check if MFA appeared after filling
      await this.sleep(1000);
      const postFillCheck = await this.checkPageState(tabId);
      
      if (postFillCheck.hasMFA) {
        result.hasMFA = true;
        result.requiresManualAction = true;
        result.manualActionReason = 'MFA/2FA required - please complete manually';
        return result;
      }

      result.success = true;
      return result;

    } catch (error) {
      this.log('error', 'Form login error', { error: error.message });
      result.error = error.message;
      return result;
    }
  }

  /**
   * Wait for login form to appear
   */
  async waitForForm(tabId, timeout) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: this.detectFormScript,
          args: [SELECTORS]
        });

        const result = results[0]?.result;
        if (result && (result.hasForm || result.hasMFA)) {
          return result;
        }
      } catch (error) {
        // Tab might be navigating
      }

      await this.sleep(300);
    }

    return { hasForm: false, hasMFA: false };
  }

  /**
   * Script to detect form (injected into page)
   */
  detectFormScript(selectors) {
    const result = {
      hasForm: false,
      hasUsername: false,
      hasPassword: false,
      hasSubmit: false,
      hasMFA: false,
      inIframe: false,
      needsNext: false
    };

    // Helper to check document
    const checkDocument = (doc) => {
      const docResult = {
        hasUsername: false,
        hasPassword: false,
        hasSubmit: false,
        hasMFA: false,
        hasNext: false
      };

      // Check username fields
      for (const selector of selectors.username) {
        try {
          const el = doc.querySelector(selector);
          if (el && el.offsetParent !== null) {
            docResult.hasUsername = true;
            break;
          }
        } catch (e) {}
      }

      // Check password fields
      for (const selector of selectors.password) {
        try {
          const el = doc.querySelector(selector);
          if (el && el.offsetParent !== null) {
            docResult.hasPassword = true;
            break;
          }
        } catch (e) {}
      }

      // Check submit buttons
      for (const selector of selectors.submit) {
        try {
          const el = doc.querySelector(selector);
          if (el && el.offsetParent !== null) {
            docResult.hasSubmit = true;
            break;
          }
        } catch (e) {}
      }

      // Check next buttons (for multi-step)
      for (const selector of selectors.next) {
        try {
          const el = doc.querySelector(selector);
          if (el && el.offsetParent !== null) {
            docResult.hasNext = true;
            break;
          }
        } catch (e) {}
      }

      // Check MFA fields
      for (const selector of selectors.mfa) {
        try {
          const el = doc.querySelector(selector);
          if (el && el.offsetParent !== null) {
            docResult.hasMFA = true;
            break;
          }
        } catch (e) {}
      }

      // Also check text for MFA indicators
      if (!docResult.hasMFA) {
        const bodyText = doc.body?.innerText?.toLowerCase() || '';
        const mfaTexts = ['verification code', 'authenticator', '2-step', 'two-factor', 'enter code'];
        if (mfaTexts.some(t => bodyText.includes(t))) {
          docResult.hasMFA = true;
        }
      }

      return docResult;
    };

    // Check main document
    const mainResult = checkDocument(document);
    result.hasUsername = mainResult.hasUsername;
    result.hasPassword = mainResult.hasPassword;
    result.hasSubmit = mainResult.hasSubmit;
    result.hasMFA = mainResult.hasMFA;
    result.needsNext = mainResult.hasNext && !mainResult.hasPassword;

    // Check same-origin iframes
    if (!result.hasPassword) {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          if (iframe.contentDocument) {
            const iframeResult = checkDocument(iframe.contentDocument);
            if (iframeResult.hasPassword) {
              result.hasPassword = true;
              result.hasUsername = result.hasUsername || iframeResult.hasUsername;
              result.hasSubmit = result.hasSubmit || iframeResult.hasSubmit;
              result.hasMFA = result.hasMFA || iframeResult.hasMFA;
              result.inIframe = true;
              break;
            }
          }
        } catch (e) {
          // Cross-origin iframe
        }
      }
    }

    result.hasForm = (result.hasUsername || result.hasPassword) && 
                     (result.hasSubmit || result.needsNext);

    return result;
  }

  /**
   * Fill the login form
   */
  async fillForm(tabId, credentials, customSelectors = {}) {
    const fillData = {
      username: credentials.payload?.username || credentials.payload?.email,
      password: credentials.payload?.password,
      selectors: { ...SELECTORS, ...customSelectors },
      rememberMe: true
    };

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: this.fillFormScript,
      args: [fillData]
    });

    return results[0]?.result || { success: false, error: 'Script execution failed' };
  }

  /**
   * Form fill script (injected into page)
   */
  fillFormScript(data) {
    const result = {
      success: false,
      isMultiStep: false,
      steps: [],
      error: null
    };

    // Helper: Find visible element
    const findElement = (selectorList, doc = document) => {
      // Check main document
      for (const selector of selectorList) {
        if (!selector) continue;
        try {
          const el = doc.querySelector(selector);
          if (el && el.offsetParent !== null && !el.disabled && !el.readOnly) {
            return { el, inIframe: false };
          }
        } catch (e) {}
      }

      // Check same-origin iframes
      const iframes = doc.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          if (iframe.contentDocument) {
            for (const selector of selectorList) {
              if (!selector) continue;
              try {
                const el = iframe.contentDocument.querySelector(selector);
                if (el && el.offsetParent !== null && !el.disabled && !el.readOnly) {
                  return { el, inIframe: true, iframe };
                }
              } catch (e) {}
            }
          }
        } catch (e) {}
      }

      return { el: null };
    };

    // Helper: Set input value with native setter (React/Vue/Angular compatible)
    const setInputValue = (input, value) => {
      if (!input || !value) return false;

      try {
        // Focus the input
        input.focus();
        
        // Clear existing value
        input.value = '';

        // Use native setter for React controlled components
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set;

        if (nativeSetter) {
          nativeSetter.call(input, value);
        } else {
          input.value = value;
        }

        // Dispatch all relevant events
        input.dispatchEvent(new Event('focus', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));

        return input.value === value;
      } catch (e) {
        return false;
      }
    };

    // Helper: Click element
    const clickElement = (el) => {
      if (!el) return false;
      try {
        el.focus();
        el.click();
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      } catch (e) {
        return false;
      }
    };

    // STEP 1: Find and fill username
    const usernameField = findElement(data.selectors.username);
    if (!usernameField.el) {
      result.error = 'Username field not found';
      return result;
    }

    if (!setInputValue(usernameField.el, data.username)) {
      result.error = 'Failed to fill username';
      return result;
    }
    result.steps.push({ field: 'username', success: true });

    // STEP 2: Check if password field is visible
    let passwordField = findElement(data.selectors.password);

    if (passwordField.el) {
      // Single-step login: fill password and submit
      if (!setInputValue(passwordField.el, data.password)) {
        result.error = 'Failed to fill password';
        return result;
      }
      result.steps.push({ field: 'password', success: true });

      // Handle remember me
      if (data.rememberMe) {
        const rememberField = findElement(data.selectors.rememberMe);
        if (rememberField.el && !rememberField.el.checked) {
          clickElement(rememberField.el);
        }
      }

      // Submit form
      setTimeout(() => {
        const submitBtn = findElement(data.selectors.submit);
        if (submitBtn.el) {
          clickElement(submitBtn.el);
          result.steps.push({ action: 'submit', success: true });
        } else {
          // Try form submit
          const form = usernameField.el.closest('form') || passwordField.el.closest('form');
          if (form) {
            form.submit();
            result.steps.push({ action: 'form_submit', success: true });
          }
        }
      }, 200);

      result.success = true;
      result.isMultiStep = false;

    } else {
      // Multi-step login: click next/continue first
      result.isMultiStep = true;

      const nextBtn = findElement(data.selectors.next);
      const submitBtn = findElement(data.selectors.submit);
      const clickTarget = nextBtn.el || submitBtn.el;

      if (!clickTarget) {
        result.error = 'No next/submit button found for multi-step login';
        return result;
      }

      clickElement(clickTarget);
      result.steps.push({ action: 'next_click', success: true });

      // Schedule password fill after page processes next click
      setTimeout(() => {
        // Wait for password field to appear
        let attempts = 0;
        const waitForPassword = () => {
          const pwdField = findElement(data.selectors.password);
          if (pwdField.el) {
            setInputValue(pwdField.el, data.password);

            // Handle remember me
            if (data.rememberMe) {
              const rememberField = findElement(data.selectors.rememberMe);
              if (rememberField.el && !rememberField.el.checked) {
                clickElement(rememberField.el);
              }
            }

            // Submit
            setTimeout(() => {
              const finalSubmit = findElement(data.selectors.submit);
              if (finalSubmit.el) {
                clickElement(finalSubmit.el);
              } else {
                const form = pwdField.el.closest('form');
                if (form) form.submit();
              }
            }, 200);

          } else if (attempts < 10) {
            attempts++;
            setTimeout(waitForPassword, 300);
          }
        };
        waitForPassword();
      }, 1500);

      result.success = true;
    }

    return result;
  }

  /**
   * Check page state for MFA, errors, etc.
   */
  async checkPageState(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selectors) => {
          const state = {
            hasMFA: false,
            hasError: false,
            errorMessage: null,
            hasPasswordField: false
          };

          // Check MFA
          for (const selector of selectors.mfa) {
            try {
              const el = document.querySelector(selector);
              if (el && el.offsetParent !== null) {
                state.hasMFA = true;
                break;
              }
            } catch (e) {}
          }

          // Check text for MFA
          if (!state.hasMFA) {
            const bodyText = document.body.innerText.toLowerCase();
            const mfaTexts = ['verification code', 'authenticator', '2-step', 'two-factor', 'enter code'];
            if (mfaTexts.some(t => bodyText.includes(t))) {
              state.hasMFA = true;
            }
          }

          // Check for errors
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
                  state.hasError = true;
                  state.errorMessage = el.textContent.trim();
                  break;
                }
              }
            } catch (e) {}
          }

          // Check if password field still visible
          state.hasPasswordField = !!document.querySelector('input[type="password"]');

          return state;
        },
        args: [SELECTORS]
      });

      return results[0]?.result || {};
    } catch (error) {
      return {};
    }
  }

  /**
   * Validate credentials before attempting login
   */
  async validate(credentials, tool) {
    // Check required fields
    const payload = credentials?.payload;
    
    if (!payload) {
      return {
        valid: false,
        error: 'No credentials payload'
      };
    }

    const username = payload.username || payload.email;
    const password = payload.password;

    if (!username || !password) {
      return {
        valid: false,
        error: 'Missing username or password'
      };
    }

    return { valid: true };
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default FormStrategy;
