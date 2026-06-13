/**
 * Tool Configurations for Auto-Login System
 * 
 * UNIFIED CREDENTIAL SCHEMA (v2.0):
 * {
 *   type: "form" | "sso" | "headers" | "cookies" | "token" | "localStorage" | "sessionStorage" | "none",
 *   payload: { ... type-specific data ... },
 *   selectors: { ... CSS selectors for form elements ... },
 *   successCheck: { ... validation after login ... }
 * }
 * 
 * TYPE-SPECIFIC PAYLOADS:
 * - form: { username, password, loginUrl?, rememberMe? }
 * - sso: { authStartUrl, postLoginUrl, provider?, autoClick? }
 * - headers: { headers: [{name, value, prefix?}] }
 * - cookies: Array of cookie objects [{name, value, domain?, path?, ...}]
 * - token: { value, storageKey?, injectToStorage?, header?, prefix? }
 * - localStorage/sessionStorage: { key: value, ... }
 */

// Default strategy order for tools without specific config
export const DEFAULT_STRATEGY_ORDER = ['cookie', 'token', 'form', 'sso', 'headers'];

// Strategy mapping from unified types to strategy names
export const TYPE_TO_STRATEGY_MAP = {
  'form': ['form'],
  'sso': ['sso', 'oauth'],
  'headers': ['headers', 'token'],
  'cookies': ['cookie'],
  'token': ['token'],
  'localStorage': ['token'],
  'sessionStorage': ['token'],
  'none': []
};

// Default timeouts
export const TIMEOUTS = {
  pageLoad: 10000,
  formFill: 5000,
  strategyExecution: 15000,
  spaRouteChange: 2000,
  ssoCallback: 30000,
  retryDelay: 1000
};

// Retry configuration
export const RETRY_CONFIG = {
  maxAttempts: 3,
  backoffMultiplier: 1.5,
  maxDelay: 5000
};

// Login detection patterns
export const LOGIN_INDICATORS = {
  // URL patterns that indicate a login page
  urlPatterns: [
    /\/login/i,
    /\/signin/i,
    /\/sign-in/i,
    /\/auth/i,
    /\/authenticate/i,
    /\/session\/new/i,
    /\/account\/login/i,
    /\/user\/login/i,
    /oauth/i,
    /\/sso/i
  ],
  // DOM elements that indicate a login form
  formSelectors: [
    'form[action*="login"]',
    'form[action*="signin"]',
    'form[action*="auth"]',
    'form[id*="login"]',
    'form[id*="signin"]',
    'form[class*="login"]',
    'form[class*="signin"]',
    '#login-form',
    '#signin-form',
    '.login-form',
    '.signin-form'
  ],
  // Input fields that indicate a login form
  inputSelectors: [
    'input[type="password"]',
    'input[name="password"]',
    'input[id="password"]',
    'input[autocomplete="current-password"]'
  ]
};

// Logged-in detection patterns
export const LOGGED_IN_INDICATORS = {
  // Selectors that indicate user is logged in
  selectors: [
    '[class*="logout"]',
    '[class*="signout"]',
    '[class*="sign-out"]',
    '[id*="logout"]',
    '[id*="signout"]',
    'a[href*="logout"]',
    'a[href*="signout"]',
    'button[class*="logout"]',
    '[class*="user-menu"]',
    '[class*="user-avatar"]',
    '[class*="profile-menu"]',
    '[class*="account-menu"]',
    '[data-testid*="user"]',
    '[data-testid*="avatar"]'
  ],
  // Cookie names that indicate logged-in state
  cookies: [
    'session',
    'sessionid',
    'session_id',
    'auth',
    'auth_token',
    'access_token',
    'jwt',
    'token',
    'user_token',
    'logged_in',
    'is_logged_in'
  ],
  // localStorage keys that indicate logged-in state
  storageKeys: [
    'token',
    'auth_token',
    'access_token',
    'jwt',
    'user',
    'session',
    'auth'
  ]
};

// Generic form selectors (fallback)
export const GENERIC_FORM_SELECTORS = {
  // Email/Username field selectors (in priority order)
  username: [
    'input[name="email"]',
    'input[type="email"]',
    'input[id="email"]',
    'input[name="username"]',
    'input[id="username"]',
    'input[name="login"]',
    'input[id="login"]',
    'input[name="user"]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="username" i]',
    'input[aria-label*="email" i]',
    'input[aria-label*="username" i]'
  ],
  // Password field selectors
  password: [
    'input[type="password"]',
    'input[name="password"]',
    'input[id="password"]',
    'input[autocomplete="current-password"]',
    'input[placeholder*="password" i]',
    'input[aria-label*="password" i]'
  ],
  // Submit button selectors
  submit: [
    'button[type="submit"]',
    'input[type="submit"]',
    'button[class*="login"]',
    'button[class*="signin"]',
    'button[class*="submit"]',
    'button[id*="login"]',
    'button[id*="signin"]',
    'button[id*="submit"]',
    'button:contains("Sign in")',
    'button:contains("Log in")',
    'button:contains("Login")',
    'button:contains("Submit")',
    '[role="button"][class*="login"]',
    '[role="button"][class*="submit"]'
  ],
  // Remember me checkbox
  rememberMe: [
    'input[type="checkbox"][name*="remember"]',
    'input[type="checkbox"][id*="remember"]',
    'input[type="checkbox"][class*="remember"]'
  ]
};

// Per-tool configurations
// Keys are domain patterns (can use wildcards)
export const TOOL_CONFIGS = {
  // Example configurations for common tools
  // Add specific tool configs here
  
  // Generic SPA framework detection
  '_spa_frameworks': {
    react: {
      indicators: ['__REACT_DEVTOOLS_GLOBAL_HOOK__', '_reactRootContainer'],
      routeChangeEvents: ['popstate', 'pushState', 'replaceState']
    },
    vue: {
      indicators: ['__VUE__', '__VUE_DEVTOOLS_GLOBAL_HOOK__'],
      routeChangeEvents: ['popstate', 'pushState', 'replaceState']
    },
    angular: {
      indicators: ['ng-version', 'ng-app'],
      routeChangeEvents: ['popstate']
    },
    nextjs: {
      indicators: ['__NEXT_DATA__', '__next'],
      routeChangeEvents: ['popstate', 'pushState', 'replaceState']
    }
  }
};

/**
 * Get configuration for a specific domain
 * @param {string} domain - The domain to get config for
 * @returns {Object|null} Tool configuration or null
 */
export function getToolConfig(domain) {
  // Direct match
  if (TOOL_CONFIGS[domain]) {
    return TOOL_CONFIGS[domain];
  }
  
  // Wildcard match
  for (const pattern of Object.keys(TOOL_CONFIGS)) {
    if (pattern.startsWith('_')) continue; // Skip special keys
    
    // Convert pattern to regex
    const regex = new RegExp(
      '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'
    );
    
    if (regex.test(domain)) {
      return TOOL_CONFIGS[pattern];
    }
  }
  
  return null;
}

/**
 * Create a tool configuration dynamically from API response
 * Supports both unified and legacy credential formats
 * 
 * @param {Object} tool - Tool data from API
 * @param {Object} credentials - Credentials data from API (unified format)
 * @returns {Object} Tool configuration for strategy engine
 */
export function createToolConfig(tool, credentials) {
  const config = {
    id: tool.id,
    name: tool.name,
    domain: extractDomain(tool.targetUrl),
    targetUrl: tool.targetUrl,
    loginUrl: tool.loginUrl || tool.targetUrl,
    strategies: [],
    selectors: {},
    storage: {},
    cookies: [],
    formData: null,
    oauth: null,
    headers: [],
    options: {
      reloadAfterLogin: tool.extensionSettings?.reloadAfterLogin ?? true,
      waitForNavigation: tool.extensionSettings?.waitForNavigation ?? true,
      spaMode: tool.extensionSettings?.spaMode ?? false,
      retryAttempts: tool.extensionSettings?.retryAttempts ?? 2,
      retryDelayMs: tool.extensionSettings?.retryDelayMs ?? 1000,
      autoSubmit: true,
      rememberMe: true
    },
    successCheck: {}
  };
  
  if (!credentials) {
    return config;
  }
  
  // Set success check from credentials
  if (credentials.successCheck) {
    config.successCheck = credentials.successCheck;
  }
  
  // Set selectors from credentials
  if (credentials.selectors) {
    config.selectors = credentials.selectors;
  }
  
  // Configure based on unified credential type
  const credType = credentials.type;
  const payload = credentials.payload;
  
  switch (credType) {
    case 'cookies':
      config.strategies = ['cookie'];
      // Payload is array of cookies or wrapped in 'cookies' key
      config.cookies = Array.isArray(payload) ? payload : (payload.cookies || []);
      break;
      
    case 'token':
      config.strategies = ['token'];
      // Token can be injected to storage and/or used as header
      if (payload.value) {
        config.storage = {
          type: payload.storageType || 'localStorage',
          data: {
            [payload.storageKey || 'token']: payload.value,
            'access_token': payload.value,
            'auth_token': payload.value
          },
          injectToStorage: payload.injectToStorage !== false
        };
        // Also prepare for header injection if MV3 server-side is used
        config.tokenHeader = credentials.tokenHeader || payload.header || 'Authorization';
        config.tokenPrefix = credentials.tokenPrefix || payload.prefix || 'Bearer ';
        config.tokenValue = payload.value;
      }
      break;
      
    case 'localStorage':
    case 'sessionStorage':
      config.strategies = ['token'];
      config.storage = {
        type: credType,
        data: payload
      };
      break;
      
    case 'form':
      config.strategies = ['form'];
      config.formData = {
        username: payload.username || payload.email,
        password: payload.password
      };
      config.loginUrl = payload.loginUrl || credentials.loginUrl || tool.loginUrl || tool.targetUrl;
      // Merge selectors from credentials
      config.selectors = {
        username: credentials.selectors?.username,
        password: credentials.selectors?.password,
        submit: credentials.selectors?.submit,
        rememberMe: credentials.selectors?.rememberMe,
        errorMessage: credentials.selectors?.errorMessage,
        twoFactor: credentials.selectors?.twoFactor
      };
      break;
      
    case 'sso':
      config.strategies = ['sso', 'oauth'];
      config.oauth = {
        provider: payload.provider,
        authStartUrl: payload.authStartUrl,
        postLoginUrl: payload.postLoginUrl,
        autoClick: payload.autoClick,
        buttonSelector: payload.buttonSelector,
        // SSO may also provide session bootstrap data
        sessionData: payload.sessionData,
        tokens: payload.tokens
      };
      config.ssoConfig = {
        authStartUrl: payload.authStartUrl,
        postLoginUrl: payload.postLoginUrl || tool.targetUrl,
        successCheck: credentials.successCheck
      };
      break;
      
    case 'headers':
      config.strategies = ['headers', 'token'];
      // Multiple headers support
      config.headers = payload.headers || [];
      // For backward compatibility, also support single header
      if (payload.value && !config.headers.length) {
        config.headers = [{
          name: credentials.tokenHeader || payload.header || 'Authorization',
          value: payload.value,
          prefix: credentials.tokenPrefix || payload.prefix || ''
        }];
      }
      // Note: MV3 cannot modify headers directly, prefer server-side session bootstrap
      // If cookies are also provided, use them
      if (payload.cookies) {
        config.cookies = payload.cookies;
        config.strategies.unshift('cookie');
      }
      break;
      
    case 'none':
      config.strategies = [];
      break;
      
    default:
      // Legacy format support - map old 'data' to new 'payload'
      if (credentials.data) {
        return createToolConfig(tool, {
          type: credType,
          payload: credentials.data,
          selectors: credentials.selectors || {},
          successCheck: credentials.successCheck || {},
          tokenHeader: credentials.tokenHeader,
          tokenPrefix: credentials.tokenPrefix
        });
      }
      // Default to trying all strategies
      config.strategies = DEFAULT_STRATEGY_ORDER;
  }
  
  // Merge with stored tool config if exists
  const storedConfig = getToolConfig(config.domain);
  if (storedConfig) {
    return { ...storedConfig, ...config };
  }
  
  return config;
}

/**
 * Extract domain from URL
 */
function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return url;
  }
}

export default {
  DEFAULT_STRATEGY_ORDER,
  TYPE_TO_STRATEGY_MAP,
  TIMEOUTS,
  RETRY_CONFIG,
  LOGIN_INDICATORS,
  LOGGED_IN_INDICATORS,
  GENERIC_FORM_SELECTORS,
  TOOL_CONFIGS,
  getToolConfig,
  createToolConfig
};
