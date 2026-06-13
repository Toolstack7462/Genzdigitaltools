/**
 * Headers Strategy
 * Handles custom header-based authentication
 * 
 * MV3 LIMITATION NOTE:
 * Manifest V3 cannot intercept and modify request headers directly.
 * This strategy works by:
 * 1. Preferring server-side session bootstrap (cookies) when available
 * 2. Injecting tokens to localStorage/sessionStorage for client-side auth
 * 3. For APIs that strictly require headers, recommend server-side proxy
 */
import { BaseStrategy } from './BaseStrategy.js';

export class HeadersStrategy extends BaseStrategy {
  constructor() {
    super('Headers');
  }
  
  /**
   * Check if this strategy can handle the config
   */
  canHandle(config) {
    // Can handle if we have headers config or token value for header injection
    return (config.headers && config.headers.length > 0) || 
           config.tokenValue ||
           (config.storage && config.storage.data);
  }
  
  /**
   * Execute header-based authentication
   * Since MV3 cannot modify headers, we use alternative approaches
   */
  async execute(config, context) {
    this.log('Executing Headers strategy (MV3 compatible)', {
      domain: config.domain,
      hasHeaders: !!config.headers?.length,
      hasToken: !!config.tokenValue,
      hasStorage: !!config.storage?.data
    });
    
    const results = {
      cookies: null,
      storage: null,
      headerNote: 'MV3 cannot modify request headers directly'
    };
    
    // Priority 1: If cookies are provided, inject them (best MV3 approach)
    if (config.cookies && config.cookies.length > 0) {
      this.log('Using cookie-based session bootstrap (recommended for MV3)');
      results.cookies = await this.injectCookies(config.targetUrl, config.cookies);
    }
    
    // Priority 2: Inject tokens to storage for client-side auth
    if (context.tabId) {
      const storageData = this.prepareStorageData(config);
      
      if (Object.keys(storageData).length > 0) {
        results.storage = await this.injectStorage(
          context.tabId, 
          storageData,
          config.storage?.type || 'localStorage'
        );
      }
    }
    
    // Store header config for potential declarativeNetRequest rules (limited in MV3)
    if (config.headers && config.headers.length > 0) {
      await this.storeHeaderConfig(config.domain, config.headers);
    }
    
    const success = results.cookies?.success || results.storage?.success;
    
    return {
      success,
      partial: (results.cookies?.success && !results.storage?.success) ||
               (!results.cookies?.success && results.storage?.success),
      strategy: this.name,
      results,
      needsReload: success,
      mv3Note: 'Headers stored for reference. Using cookie/storage injection for MV3 compatibility.'
    };
  }
  
  /**
   * Prepare storage data from config
   */
  prepareStorageData(config) {
    const data = {};
    
    // Add explicit storage data
    if (config.storage?.data) {
      Object.assign(data, config.storage.data);
    }
    
    // Add token value to common storage keys
    if (config.tokenValue) {
      data.token = config.tokenValue;
      data.access_token = config.tokenValue;
      data.auth_token = config.tokenValue;
      
      // Store full auth config for apps that need it
      data.auth = JSON.stringify({
        token: config.tokenValue,
        header: config.tokenHeader || 'Authorization',
        prefix: config.tokenPrefix || 'Bearer '
      });
    }
    
    // Add individual header values to storage (fallback for client-side)
    if (config.headers) {
      for (const header of config.headers) {
        const storageKey = this.headerToStorageKey(header.name);
        const value = header.prefix ? `${header.prefix}${header.value}` : header.value;
        data[storageKey] = value;
      }
    }
    
    return data;
  }
  
  /**
   * Convert header name to storage key
   */
  headerToStorageKey(headerName) {
    // Common mappings
    const mappings = {
      'Authorization': 'auth_token',
      'X-API-Key': 'api_key',
      'X-Auth-Token': 'auth_token',
      'X-Access-Token': 'access_token',
      'X-Session-Token': 'session_token',
      'Bearer': 'bearer_token'
    };
    
    return mappings[headerName] || headerName.toLowerCase().replace(/-/g, '_');
  }
  
  /**
   * Store header config for reference (and potential future use)
   */
  async storeHeaderConfig(domain, headers) {
    try {
      await chrome.storage.local.set({
        [`headers_${domain}`]: {
          headers,
          updatedAt: Date.now(),
          note: 'MV3 reference only - cannot inject headers directly'
        }
      });
    } catch (e) {
      this.logError('Failed to store header config', e);
    }
  }
  
  /**
   * Inject cookies
   */
  async injectCookies(targetUrl, cookies) {
    if (!cookies || cookies.length === 0) {
      return { success: false, error: 'No cookies provided' };
    }
    
    const domain = new URL(targetUrl).hostname;
    const isHttps = targetUrl.startsWith('https');
    let setCount = 0;
    let failedCount = 0;
    
    for (const cookie of cookies) {
      try {
        const protocol = isHttps ? 'https' : 'http';
        let cookieDomain = cookie.domain || domain;
        const cleanDomain = cookieDomain.startsWith('.') 
          ? cookieDomain.substring(1) 
          : cookieDomain;
        
        // Handle SameSite
        let sameSite = (cookie.sameSite || 'lax').toLowerCase();
        if (sameSite === 'none' || sameSite === 'no_restriction') {
          sameSite = 'no_restriction';
        } else if (sameSite === 'strict') {
          sameSite = 'strict';
        } else {
          sameSite = 'lax';
        }
        
        // SameSite=None requires Secure
        const secure = sameSite === 'no_restriction' ? true : (cookie.secure !== false);
        
        const cookieDetails = {
          url: `${secure ? 'https' : 'http'}://${cleanDomain}/`,
          name: cookie.name,
          value: cookie.value,
          path: cookie.path || '/',
          secure,
          httpOnly: cookie.httpOnly || false,
          sameSite
        };
        
        if (cookieDomain.startsWith('.')) {
          cookieDetails.domain = cookieDomain;
        }
        
        // Handle expiration
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
        
        await chrome.cookies.set(cookieDetails);
        setCount++;
      } catch (e) {
        failedCount++;
        this.logError(`Failed to set cookie: ${cookie.name}`, e);
      }
    }
    
    return {
      success: setCount > 0,
      set: setCount,
      failed: failedCount,
      total: cookies.length
    };
  }
  
  /**
   * Inject storage data
   */
  async injectStorage(tabId, data, storageType = 'localStorage') {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (storageData, type) => {
          const storage = type === 'sessionStorage' ? sessionStorage : localStorage;
          let setCount = 0;
          const errors = [];
          
          for (const [key, value] of Object.entries(storageData)) {
            try {
              const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
              storage.setItem(key, valueStr);
              setCount++;
            } catch (e) {
              errors.push({ key, error: e.message });
            }
          }
          
          return { success: setCount > 0, set: setCount, errors };
        },
        args: [data, storageType]
      });
      
      return results[0]?.result || { success: false };
    } catch (error) {
      this.logError('Storage injection failed', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Get stored header config for a domain
   */
  async getHeaderConfig(domain) {
    try {
      const data = await chrome.storage.local.get([`headers_${domain}`]);
      return data[`headers_${domain}`] || null;
    } catch (e) {
      return null;
    }
  }
  
  /**
   * Verify headers would be sent (for debugging)
   */
  async verify(config, context) {
    if (!context.tabId) return false;
    
    // Check if storage keys are set
    const expectedKeys = [];
    
    if (config.tokenValue) {
      expectedKeys.push('token', 'access_token', 'auth_token');
    }
    
    if (config.headers) {
      for (const header of config.headers) {
        expectedKeys.push(this.headerToStorageKey(header.name));
      }
    }
    
    if (expectedKeys.length === 0) return true;
    
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: context.tabId },
        func: (keys) => {
          return keys.every(key => localStorage.getItem(key) !== null);
        },
        args: [expectedKeys]
      });
      
      return results[0]?.result || false;
    } catch (e) {
      return false;
    }
  }
  
  /**
   * Get instructions for server-side header injection (for admin reference)
   */
  getServerSideInstructions(headers) {
    return {
      note: 'MV3 cannot modify request headers. For strict header requirements:',
      options: [
        '1. Use server-side session bootstrap to set authentication cookies',
        '2. Create a proxy server that adds headers to requests',
        '3. Use the app\'s native token storage mechanism (localStorage/sessionStorage)'
      ],
      headers: headers.map(h => ({
        name: h.name,
        format: h.prefix ? `${h.prefix}[value]` : '[value]',
        suggestion: `Store in localStorage key: ${this.headerToStorageKey(h.name)}`
      }))
    };
  }
}

export default HeadersStrategy;
