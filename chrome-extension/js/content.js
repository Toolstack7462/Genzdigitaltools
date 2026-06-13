/**
 * Content Script v2.1 for Auto-Login
 * 
 * Enhanced with:
 * - MutationObserver for dynamic form detection
 * - Iframe support for same-origin login forms
 * - Multi-step login detection
 * - MFA detection
 * - Improved SPA route change handling
 * - Better logging without exposing secrets
 */

// Configuration
const CONFIG = {
  checkInterval: 1000,
  maxChecks: 15,
  spaRouteDebounce: 500,
  mutationDebounce: 300,
  iframeCheckInterval: 500
};

// State
let isInitialized = false;
let currentUrl = window.location.href;
let loginCheckCount = 0;
let routeChangeTimer = null;
let mutationTimer = null;
let formObserver = null;

// ============================================================================
// LOGIN PAGE INDICATORS
// ============================================================================

const LOGIN_INDICATORS = {
  urlPatterns: [
    /\/login/i, /\/signin/i, /\/sign-in/i, /\/auth/i,
    /\/authenticate/i, /\/session\/new/i, /\/account\/login/i,
    /\/user\/login/i, /oauth/i, /\/sso/i, /\/saml/i
  ],
  formSelectors: [
    'form[action*="login"]', 'form[action*="signin"]', 'form[action*="auth"]',
    'form[id*="login"]', 'form[id*="signin"]', 'form[class*="login"]',
    'form[class*="signin"]', '#login-form', '#signin-form', '.login-form',
    '.signin-form', '[data-testid*="login"]', '[data-testid*="signin"]'
  ],
  inputSelectors: [
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]'
  ],
  mfaSelectors: [
    'input[name*="otp"]', 'input[name*="code"]', 'input[name*="2fa"]',
    'input[name*="totp"]', 'input[name*="mfa"]', 'input[id*="otp"]',
    'input[placeholder*="code" i]', 'input[placeholder*="authenticator" i]',
    '[class*="mfa"]', '[class*="two-factor"]', '[class*="2fa"]',
    '[class*="verification-code"]'
  ]
};

// Logged-in indicators
const LOGGED_IN_INDICATORS = {
  selectors: [
    '[class*="logout"]', '[class*="signout"]', '[class*="sign-out"]',
    '[id*="logout"]', '[id*="signout"]', 'a[href*="logout"]',
    'a[href*="signout"]', 'button[class*="logout"]',
    '[class*="user-menu"]', '[class*="user-avatar"]', '[class*="profile-menu"]',
    '[class*="account-menu"]', '[data-testid*="user"]', '[data-testid*="avatar"]',
    '[class*="user-dropdown"]', '[class*="profile-dropdown"]',
    'nav [class*="user"]', 'header [class*="avatar"]'
  ],
  storageKeys: [
    'token', 'auth_token', 'access_token', 'jwt', 'user',
    'session', 'auth', 'id_token', 'refresh_token'
  ]
};

// ============================================================================
// LOGGING (without secrets)
// ============================================================================

function log(level, message, data = null) {
  const prefix = '[GenZ Content]';
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  
  // Sanitize data
  const sanitized = data ? sanitizeLogData(data) : null;
  
  if (sanitized) {
    console[level](`${prefix} [${timestamp}] ${message}`, sanitized);
  } else {
    console[level](`${prefix} [${timestamp}] ${message}`);
  }
}

function sanitizeLogData(data) {
  if (typeof data !== 'object') return data;
  
  const sensitiveKeys = ['password', 'token', 'secret', 'auth', 'credential', 'cookie'];
  const sanitized = {};
  
  for (const [key, value] of Object.entries(data)) {
    const keyLower = key.toLowerCase();
    if (sensitiveKeys.some(s => keyLower.includes(s))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeLogData(value);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

// ============================================================================
// INITIALIZATION
// ============================================================================

function init() {
  if (isInitialized) return;
  isInitialized = true;
  
  log('log', 'Initializing on ' + window.location.hostname);
  
  // Parse URL params for auto-start mode
  const urlParams = new URLSearchParams(window.location.search);
  const isAutoMode = urlParams.get('auto') === '1' || urlParams.get('auto') === 'true';
  const isHiddenMode = urlParams.get('hidden') === '1' || urlParams.get('hidden') === 'true';
  
  if (isAutoMode) {
    log('log', 'Auto-start mode detected', { isHiddenMode });
    // Background will handle auto-login, just set up cancel listener
    setupCancelListener();
  }
  
  // Check login state on load
  checkAndTriggerLogin();
  
  // Setup SPA route change detection
  setupRouteChangeDetection();
  
  // Setup mutation observer for dynamic content
  setupMutationObserver();
  
  // Setup iframe monitoring
  setupIframeMonitoring();
  
  // Listen for messages from background
  setupMessageListener();
}

/**
 * Setup listener for login cancel event (from overlay)
 */
function setupCancelListener() {
  window.addEventListener('toolstack-login-cancelled', () => {
    log('log', 'Login cancelled by user');
    // Notify background to cancel the login flow
    notifyBackground('LOGIN_CANCELLED', {
      hostname: window.location.hostname,
      url: window.location.href
    });
  });
}

// ============================================================================
// LOGIN STATE DETECTION
// ============================================================================

/**
 * Check if current page is a login page
 * Supports main document and same-origin iframes
 */
function isLoginPage() {
  const url = window.location.href.toLowerCase();
  
  // Check URL patterns
  const matchesUrl = LOGIN_INDICATORS.urlPatterns.some(pattern => pattern.test(url));
  
  // Check main document
  let hasLoginForm = checkForLoginForm(document);
  let hasPasswordField = checkForPasswordField(document);
  
  // Check same-origin iframes
  if (!hasLoginForm && !hasPasswordField) {
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        if (iframe.contentDocument) {
          if (checkForLoginForm(iframe.contentDocument)) {
            hasLoginForm = true;
            break;
          }
          if (checkForPasswordField(iframe.contentDocument)) {
            hasPasswordField = true;
            break;
          }
        }
      } catch (e) {
        // Cross-origin iframe, skip
      }
    }
  }
  
  return matchesUrl || (hasLoginForm && hasPasswordField) || (hasPasswordField && !isLoggedIn());
}

/**
 * Check for login form in a document
 */
function checkForLoginForm(doc) {
  return LOGIN_INDICATORS.formSelectors.some(selector => {
    try {
      return doc.querySelector(selector) !== null;
    } catch (e) {
      return false;
    }
  });
}

/**
 * Check for password field in a document
 */
function checkForPasswordField(doc) {
  return LOGIN_INDICATORS.inputSelectors.some(selector => {
    try {
      const el = doc.querySelector(selector);
      return el && el.offsetParent !== null;
    } catch (e) {
      return false;
    }
  });
}

/**
 * Check for MFA/2FA fields
 */
function checkForMFA() {
  // Check main document
  let hasMFA = LOGIN_INDICATORS.mfaSelectors.some(selector => {
    try {
      const el = document.querySelector(selector);
      return el && el.offsetParent !== null;
    } catch (e) {
      return false;
    }
  });
  
  // Check text content for MFA keywords
  if (!hasMFA) {
    const bodyText = document.body.innerText.toLowerCase();
    const mfaKeywords = [
      'verification code', 'authenticator', '2-step', 'two-factor',
      'enter code', 'security code', 'one-time password', 'otp',
      '6-digit code', 'confirm your identity'
    ];
    hasMFA = mfaKeywords.some(keyword => bodyText.includes(keyword));
  }
  
  return hasMFA;
}

/**
 * Check if user is logged in
 */
function isLoggedIn() {
  // Check DOM for logged-in indicators
  const hasLoggedInElement = LOGGED_IN_INDICATORS.selectors.some(selector => {
    try {
      const el = document.querySelector(selector);
      return el && el.offsetParent !== null;
    } catch (e) {
      return false;
    }
  });
  
  // Check localStorage for auth tokens
  const hasStoredAuth = LOGGED_IN_INDICATORS.storageKeys.some(key => {
    try {
      const value = localStorage.getItem(key);
      return value && value.length > 0;
    } catch (e) {
      return false;
    }
  });
  
  // Check sessionStorage
  const hasSessionAuth = LOGGED_IN_INDICATORS.storageKeys.some(key => {
    try {
      const value = sessionStorage.getItem(key);
      return value && value.length > 0;
    } catch (e) {
      return false;
    }
  });
  
  return hasLoggedInElement || hasStoredAuth || hasSessionAuth;
}

/**
 * Detect multi-step login (email first, then password)
 */
function detectMultiStepLogin() {
  // Check for email/username field without visible password
  const emailSelectors = [
    'input[type="email"]', 'input[name="email"]', 'input[name="username"]',
    'input[name="identifier"]', 'input[autocomplete="email"]'
  ];
  
  let hasEmailField = false;
  let hasVisiblePassword = false;
  
  for (const selector of emailSelectors) {
    const el = document.querySelector(selector);
    if (el && el.offsetParent !== null) {
      hasEmailField = true;
      break;
    }
  }
  
  const passwordField = document.querySelector('input[type="password"]');
  hasVisiblePassword = passwordField && passwordField.offsetParent !== null;
  
  // Check for "Next" or "Continue" button (indicates multi-step)
  const nextButtonSelectors = [
    'button[class*="next" i]', 'button[id*="next" i]',
    'button:not([type="submit"])[class*="continue" i]',
    'input[type="button"][value*="next" i]',
    'input[type="button"][value*="continue" i]'
  ];
  
  let hasNextButton = false;
  for (const selector of nextButtonSelectors) {
    try {
      const el = document.querySelector(selector);
      if (el && el.offsetParent !== null) {
        hasNextButton = true;
        break;
      }
    } catch (e) {}
  }
  
  return {
    isMultiStep: hasEmailField && !hasVisiblePassword && hasNextButton,
    hasEmailField,
    hasVisiblePassword,
    hasNextButton
  };
}

/**
 * Get current login state
 */
function getLoginState() {
  const multiStep = detectMultiStepLogin();
  
  return {
    url: window.location.href,
    hostname: window.location.hostname,
    pathname: window.location.pathname,
    isLoginPage: isLoginPage(),
    isLoggedIn: isLoggedIn(),
    hasMFA: checkForMFA(),
    isMultiStep: multiStep.isMultiStep,
    hasPasswordField: !!document.querySelector('input[type="password"]'),
    hasVisiblePasswordField: checkForPasswordField(document),
    timestamp: Date.now()
  };
}

// ============================================================================
// LOGIN TRIGGER
// ============================================================================

/**
 * Check login state and trigger auto-login if needed
 */
async function checkAndTriggerLogin() {
  const state = getLoginState();
  
  log('log', 'Login state check', {
    isLoginPage: state.isLoginPage,
    isLoggedIn: state.isLoggedIn,
    hasMFA: state.hasMFA,
    isMultiStep: state.isMultiStep
  });
  
  // If already logged in, no action needed
  if (state.isLoggedIn && !state.isLoginPage) {
    log('log', 'Already logged in');
    notifyBackground('LOGIN_STATE', { ...state, action: 'already_logged_in' });
    return;
  }
  
  // If MFA detected, notify but don't auto-login
  if (state.hasMFA) {
    log('log', 'MFA detected - manual action required');
    notifyBackground('LOGIN_STATE', { ...state, action: 'mfa_required' });
    return;
  }
  
  // If on login page and not logged in, trigger auto-login
  if (state.isLoginPage && !state.isLoggedIn) {
    log('log', 'Login page detected, requesting credentials');
    notifyBackground('LOGIN_REQUIRED', state);
    return;
  }
  
  // If we have password field but not clearly on login page, wait and re-check
  if (state.hasPasswordField && loginCheckCount < CONFIG.maxChecks) {
    loginCheckCount++;
    setTimeout(() => checkAndTriggerLogin(), CONFIG.checkInterval);
  }
}

// ============================================================================
// SPA ROUTE CHANGE DETECTION
// ============================================================================

function setupRouteChangeDetection() {
  // Monitor pushState and replaceState
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    handleRouteChange('pushState');
  };
  
  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    handleRouteChange('replaceState');
  };
  
  // Monitor popstate
  window.addEventListener('popstate', () => handleRouteChange('popstate'));
  
  // Monitor hashchange
  window.addEventListener('hashchange', () => handleRouteChange('hashchange'));
}

/**
 * Handle route change in SPA
 */
function handleRouteChange(source) {
  const newUrl = window.location.href;
  
  if (newUrl === currentUrl) return;
  
  log('log', 'Route change detected', { source, newUrl: newUrl.substring(0, 100) });
  currentUrl = newUrl;
  loginCheckCount = 0;
  
  // Debounce to allow page to render
  clearTimeout(routeChangeTimer);
  routeChangeTimer = setTimeout(() => {
    checkAndTriggerLogin();
  }, CONFIG.spaRouteDebounce);
}

// ============================================================================
// MUTATION OBSERVER FOR DYNAMIC CONTENT
// ============================================================================

function setupMutationObserver() {
  // Disconnect existing observer if any
  if (formObserver) {
    formObserver.disconnect();
  }
  
  formObserver = new MutationObserver((mutations) => {
    let shouldCheck = false;
    
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if added node contains login elements
            if (node.querySelector) {
              // Password field added
              if (node.querySelector('input[type="password"]')) {
                shouldCheck = true;
                break;
              }
              // Login form added
              if (node.matches?.('[class*="login"]') || node.querySelector('[class*="login"]')) {
                shouldCheck = true;
                break;
              }
              // MFA field added
              if (node.querySelector('input[name*="otp"], input[name*="code"]')) {
                shouldCheck = true;
                break;
              }
            }
          }
        }
      }
      
      if (shouldCheck) break;
    }
    
    if (shouldCheck) {
      // Debounce mutation checks
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(() => {
        log('log', 'Login form detected via mutation');
        loginCheckCount = 0;
        checkAndTriggerLogin();
      }, CONFIG.mutationDebounce);
    }
  });
  
  // Start observing
  formObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// ============================================================================
// IFRAME MONITORING
// ============================================================================

function setupIframeMonitoring() {
  // Check existing iframes
  const iframes = document.querySelectorAll('iframe');
  iframes.forEach(iframe => monitorIframe(iframe));
  
  // Monitor for new iframes
  const iframeObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeName === 'IFRAME') {
          monitorIframe(node);
        }
      }
    }
  });
  
  iframeObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}

function monitorIframe(iframe) {
  // Wait for iframe to load
  iframe.addEventListener('load', () => {
    try {
      // Only monitor same-origin iframes
      if (iframe.contentDocument) {
        // Check for login form in iframe
        if (checkForPasswordField(iframe.contentDocument)) {
          log('log', 'Login form detected in iframe');
          loginCheckCount = 0;
          checkAndTriggerLogin();
        }
      }
    } catch (e) {
      // Cross-origin iframe, ignore
    }
  });
}

// ============================================================================
// MESSAGE LISTENER
// ============================================================================

function setupMessageListener() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log('log', 'Message received', { type: message.type });
    
    switch (message.type) {
      case 'GET_LOGIN_STATE':
        sendResponse(getLoginState());
        break;
        
      case 'FILL_FORM':
        fillLoginForm(message.data)
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
        
      case 'INJECT_STORAGE':
        injectStorage(message.data)
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
        
      case 'CHECK_LOGGED_IN':
        sendResponse({ isLoggedIn: isLoggedIn(), state: getLoginState() });
        break;
        
      case 'TRIGGER_LOGIN_CHECK':
        loginCheckCount = 0;
        checkAndTriggerLogin();
        sendResponse({ triggered: true });
        break;
        
      case 'CHECK_MFA':
        sendResponse({ hasMFA: checkForMFA() });
        break;
        
      case 'GET_FORM_INFO':
        sendResponse(getFormInfo());
        break;
        
      default:
        sendResponse({ error: 'Unknown message type' });
    }
  });
}

// ============================================================================
// FORM FILLING
// ============================================================================

/**
 * Fill login form with credentials
 * Supports single-step and multi-step logins
 */
async function fillLoginForm(data) {
  const { username, password, selectors = {}, autoSubmit = true, rememberMe = true } = data;
  
  const result = {
    success: false,
    usernameField: null,
    passwordField: null,
    submitted: false,
    isMultiStep: false,
    errors: []
  };
  
  // Selector lists
  const usernameSelectors = [
    ...(selectors.username ? [selectors.username] : []),
    'input[name="email"]', 'input[type="email"]', 'input[id="email"]',
    'input[name="username"]', 'input[id="username"]', 'input[name="login"]',
    'input[name="identifier"]', 'input[autocomplete="email"]',
    'input[autocomplete="username"]', 'input[placeholder*="email" i]',
    'input[placeholder*="username" i]'
  ];
  
  const passwordSelectors = [
    ...(selectors.password ? [selectors.password] : []),
    'input[type="password"]', 'input[name="password"]', 'input[id="password"]',
    'input[autocomplete="current-password"]'
  ];
  
  const submitSelectors = [
    ...(selectors.submit ? [selectors.submit] : []),
    'button[type="submit"]', 'input[type="submit"]',
    'button[class*="login"]', 'button[class*="signin"]',
    'button[id*="login"]', 'button[id*="signin"]'
  ];
  
  const nextSelectors = [
    'button[class*="next" i]', 'button[id*="next" i]',
    'button:not([type="submit"])[class*="continue" i]'
  ];
  
  // Find and fill username (check both main document and iframes)
  const usernameField = findVisibleElement(usernameSelectors);
  if (usernameField) {
    result.usernameField = usernameField.name || usernameField.id || 'found';
    setInputValue(usernameField, username);
  } else {
    result.errors.push('Username field not found');
    return result;
  }
  
  // Check if password field is visible
  let passwordField = findVisibleElement(passwordSelectors);
  
  if (passwordField) {
    // Single-step login
    result.passwordField = passwordField.name || passwordField.id || 'found';
    setInputValue(passwordField, password);
    
    // Handle remember me
    if (rememberMe) {
      const rememberMeSelectors = [
        'input[type="checkbox"][name*="remember"]',
        'input[type="checkbox"][id*="remember"]'
      ];
      const checkbox = findVisibleElement(rememberMeSelectors);
      if (checkbox && !checkbox.checked) {
        checkbox.click();
      }
    }
    
    // Submit form
    if (autoSubmit) {
      await sleep(100);
      
      const submitButton = findVisibleElement(submitSelectors);
      if (submitButton) {
        submitButton.click();
        result.submitted = true;
      } else {
        const form = usernameField.closest('form') || passwordField.closest('form');
        if (form) {
          form.submit();
          result.submitted = true;
        } else {
          result.errors.push('Submit button/form not found');
        }
      }
    }
    
    result.success = true;
    
  } else {
    // Multi-step login - click next first
    result.isMultiStep = true;
    log('log', 'Detected multi-step login');
    
    const nextButton = findVisibleElement(nextSelectors);
    const submitButton = findVisibleElement(submitSelectors);
    const clickTarget = nextButton || submitButton;
    
    if (clickTarget) {
      clickTarget.click();
      
      // Wait for password field to appear
      await waitForElement(passwordSelectors, 5000);
      
      passwordField = findVisibleElement(passwordSelectors);
      if (passwordField) {
        result.passwordField = passwordField.name || passwordField.id || 'found';
        setInputValue(passwordField, password);
        
        if (autoSubmit) {
          await sleep(200);
          const finalSubmit = findVisibleElement(submitSelectors);
          if (finalSubmit) {
            finalSubmit.click();
            result.submitted = true;
          } else {
            const form = passwordField.closest('form');
            if (form) {
              form.submit();
              result.submitted = true;
            }
          }
        }
        
        result.success = true;
      } else {
        result.errors.push('Password field did not appear after clicking next');
      }
    } else {
      result.errors.push('No next or submit button found for multi-step login');
    }
  }
  
  return result;
}

/**
 * Get information about the login form
 */
function getFormInfo() {
  const info = {
    hasForm: false,
    hasUsername: false,
    hasPassword: false,
    hasSubmit: false,
    hasMFA: false,
    isMultiStep: false,
    inIframe: false,
    selectors: {}
  };
  
  // Check main document
  const passwordField = document.querySelector('input[type="password"]');
  if (passwordField && passwordField.offsetParent !== null) {
    info.hasPassword = true;
    info.hasForm = true;
    info.selectors.password = getSelector(passwordField);
  }
  
  const emailField = document.querySelector(
    'input[type="email"], input[name="email"], input[name="username"]'
  );
  if (emailField && emailField.offsetParent !== null) {
    info.hasUsername = true;
    info.selectors.username = getSelector(emailField);
  }
  
  const submitBtn = document.querySelector('button[type="submit"]');
  if (submitBtn && submitBtn.offsetParent !== null) {
    info.hasSubmit = true;
    info.selectors.submit = getSelector(submitBtn);
  }
  
  info.hasMFA = checkForMFA();
  info.isMultiStep = detectMultiStepLogin().isMultiStep;
  
  // Check iframes
  if (!info.hasPassword) {
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        if (iframe.contentDocument) {
          const iframePwd = iframe.contentDocument.querySelector('input[type="password"]');
          if (iframePwd && iframePwd.offsetParent !== null) {
            info.hasPassword = true;
            info.hasForm = true;
            info.inIframe = true;
            break;
          }
        }
      } catch (e) {}
    }
  }
  
  return info;
}

/**
 * Generate a selector for an element
 */
function getSelector(el) {
  if (el.id) return `#${el.id}`;
  if (el.name) return `[name="${el.name}"]`;
  if (el.className) return `.${el.className.split(' ')[0]}`;
  return el.tagName.toLowerCase();
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Find visible element from selector list
 * Checks both main document and same-origin iframes
 */
function findVisibleElement(selectors) {
  // Check main document first
  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      if (el && el.offsetParent !== null) {
        return el;
      }
    } catch (e) {}
  }
  
  // Check same-origin iframes
  const iframes = document.querySelectorAll('iframe');
  for (const iframe of iframes) {
    try {
      if (iframe.contentDocument) {
        for (const selector of selectors) {
          try {
            const el = iframe.contentDocument.querySelector(selector);
            if (el && el.offsetParent !== null) {
              return el;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  
  return null;
}

/**
 * Set input value with proper events (works with React, Vue, Angular)
 */
function setInputValue(input, value) {
  // Focus
  input.focus();
  
  // Clear
  input.value = '';
  
  // For React controlled inputs
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  )?.set;
  
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, value);
  } else {
    input.value = value;
  }
  
  // Dispatch events
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
  
  // Blur
  input.blur();
}

/**
 * Wait for an element to appear
 */
function waitForElement(selectors, timeout = 5000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    const check = () => {
      const el = findVisibleElement(selectors);
      if (el) {
        resolve(el);
      } else if (Date.now() - startTime > timeout) {
        resolve(null);
      } else {
        setTimeout(check, 100);
      }
    };
    
    check();
  });
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Notify background script
 */
function notifyBackground(type, data) {
  try {
    chrome.runtime.sendMessage({
      type,
      data,
      source: 'content',
      url: window.location.href,
      hostname: window.location.hostname
    });
  } catch (e) {
    log('error', 'Failed to notify background', { error: e.message });
  }
}

/**
 * Inject data into storage
 */
async function injectStorage(data) {
  const { storageType = 'localStorage', items } = data;
  const storage = storageType === 'sessionStorage' ? sessionStorage : localStorage;
  
  let setCount = 0;
  const errors = [];
  
  for (const [key, value] of Object.entries(items)) {
    try {
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
      storage.setItem(key, valueStr);
      setCount++;
    } catch (e) {
      errors.push({ key, error: e.message });
    }
  }
  
  return {
    success: setCount > 0,
    set: setCount,
    total: Object.keys(items).length,
    errors
  };
}

// ============================================================================
// INITIALIZE
// ============================================================================

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Also run on window load for late-loading SPAs
window.addEventListener('load', () => {
  setTimeout(() => {
    if (!isLoggedIn() && isLoginPage()) {
      checkAndTriggerLogin();
    }
  }, 1000);
});
