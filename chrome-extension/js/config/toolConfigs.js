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

// ============================================================================
// ACCOUNT / LOGOUT SHIELD (extension-opened tools)
// SINGLE source of truth for the hide/block rules used by js/shield.js. The proxy
// gateways carry their own equivalent (proxy-gateway/overlay.js + server.js) because
// they are a SEPARATE deploy unit; within the extension these rules live only here so
// shield.js stays config-driven and we don't duplicate selector lists.
//
// SAFETY: these target only post-login account/billing/logout CHROME. shield.js never
// hides inputs/textareas/contenteditable/forms/iframes or anything inside the working
// area, and never touches captcha widgets — so it cannot break login, the editor, the
// chat/upload area, or anti-aboot challenges.
// ============================================================================
export const SHIELD_DEFAULTS = {
  enabled: true,
  // <a href*> substrings → matching links hidden.
  hrefSubstrings: [
    'pricing', 'billing', 'account', 'affiliate', 'discord', '/faq', 'support',
    'subscription', 'upgrade', 'refer', '/plans', '/settings', '/profile', '/me',
    'api-key', 'apikey', 'logout', 'log-out', 'sign-out', 'signout'
  ],
  // aria-label / data-testid substrings → matching controls hidden.
  attrSubstrings: [
    'account', 'profile', 'user menu', 'usermenu', 'user-menu', 'avatar',
    'upgrade', 'billing', 'subscription', 'affiliate', 'log out', 'logout', 'sign out'
  ],
  // Exact extra CSS selectors (per-tool overrides append here).
  hideSelectors: [],
  // Visible-label regex (source string) for controls to hide.
  hideTextSource: '^(account|my account|account settings|account details|profile|my profile|settings|preferences|log\\s?out|sign\\s?out|logout|plans?\\s*&?\\s*pricing|pricing|subscription|manage subscription|billing|manage plan|upgrade|upgrade plan|api keys?|api key|affiliate|refer a friend|invite friends?|rewards)$',
  // Labels we must NEVER hide (working area / primary nav).
  keepTextSource: '^(dashboard|home|new|history|humanizer|ai detector|ai-detector|humanize|check for ai|detect ai|bypass|paraphrase|input|output|copy|paste|chat|send|upload|download|new chat|regenerate)$',
  // Route path fragments → navigating here is blocked with a friendly toast.
  blockRouteFragments: [
    '/logout', '/log-out', '/sign-out', '/signout', '/billing', '/subscription',
    '/subscriptions', '/account', '/account-settings', '/settings', '/upgrade',
    '/pricing', '/plans', '/profile', '/affiliate'
  ]
};

// Per-host overrides (matched on registrable host / hostname).
export const SHIELD_OVERRIDES = {
  'chatgpt.com': { hideSelectors: ['[data-testid="accounts-profile-button"]', '[data-testid*="account" i]'] }
};

/**
 * Merge shield config for a tool URL. Layers: SHIELD_DEFAULTS → host override →
 * backend per-assignment override (tool.extensionSettings.shield) → kill switch.
 */
export function getShieldConfig(url, tool) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) {}
  const cfg = {
    enabled: SHIELD_DEFAULTS.enabled,
    hrefSubstrings: SHIELD_DEFAULTS.hrefSubstrings.slice(),
    attrSubstrings: SHIELD_DEFAULTS.attrSubstrings.slice(),
    hideSelectors: SHIELD_DEFAULTS.hideSelectors.slice(),
    hideTextSource: SHIELD_DEFAULTS.hideTextSource,
    keepTextSource: SHIELD_DEFAULTS.keepTextSource,
    blockRouteFragments: SHIELD_DEFAULTS.blockRouteFragments.slice()
  };
  for (const k in SHIELD_OVERRIDES) {
    if (host === k || host.endsWith('.' + k)) {
      const o = SHIELD_OVERRIDES[k];
      if (o.enabled === false) cfg.enabled = false;
      if (Array.isArray(o.hideSelectors)) cfg.hideSelectors = cfg.hideSelectors.concat(o.hideSelectors);
      if (Array.isArray(o.hrefSubstrings)) cfg.hrefSubstrings = cfg.hrefSubstrings.concat(o.hrefSubstrings);
    }
  }
  const ts = tool && tool.extensionSettings && tool.extensionSettings.shield;
  if (ts) {
    if (ts.enabled === false) cfg.enabled = false;
    if (Array.isArray(ts.hideSelectors)) cfg.hideSelectors = cfg.hideSelectors.concat(ts.hideSelectors);
    if (Array.isArray(ts.blockRouteFragments)) cfg.blockRouteFragments = ts.blockRouteFragments;
  }
  if (tool && tool.shield === false) cfg.enabled = false;
  return cfg;
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
  createToolConfig,
  SHIELD_DEFAULTS,
  SHIELD_OVERRIDES,
  getShieldConfig
};
