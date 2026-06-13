/**
 * Cookie Injection Strategy v2.1
 * 
 * Enhanced with:
 * - Proper cookie attribute normalization (domain, sameSite, secure, path)
 * - Injection before navigation for best reliability
 * - Automatic reload coordination
 * - Better error handling and logging
 */

import BaseStrategy from './BaseStrategy.js';

class CookieStrategy extends BaseStrategy {
  constructor() {
    super('cookies');
    this.reloadAfterInjection = true;
    this.injectionDelay = 500;
  }

  /**
   * Execute cookie injection strategy
   */
  async execute(credentials, tool, tabId) {
    this.log('info', 'Executing cookie injection', { tool: tool.name });

    const result = {
      success: false,
      method: 'cookies',
      tabId,
      error: null,
      injected: 0,
      failed: 0
    };

    try {
      // Get cookies from credentials
      const cookies = this.extractCookies(credentials);
      
      if (!cookies || cookies.length === 0) {
        result.error = 'No cookies to inject';
        return result;
      }

      this.log('debug', 'Injecting cookies', { count: cookies.length });

      // Inject cookies BEFORE opening tab
      const injectionResult = await this.injectCookies(tool.targetUrl, cookies);
      
      result.injected = injectionResult.success;
      result.failed = injectionResult.failed;

      if (injectionResult.success === 0) {
        result.error = 'All cookie injections failed';
        result.failures = injectionResult.failures;
        return result;
      }

      // Create or update tab
      let targetTab;
      if (tabId) {
        await chrome.tabs.update(tabId, { url: tool.targetUrl, active: true });
        targetTab = await chrome.tabs.get(tabId);
      } else {
        targetTab = await chrome.tabs.create({ url: tool.targetUrl, active: false });
      }

      // Wait for page to load
      await this.waitForTabLoad(targetTab.id);

      // Reload if needed to apply cookies
      if (this.reloadAfterInjection) {
        await this.sleep(this.injectionDelay);
        await chrome.tabs.reload(targetTab.id);
        await this.waitForTabLoad(targetTab.id);
      }

      result.success = true;
      result.tabId = targetTab.id;

    } catch (error) {
      this.log('error', 'Cookie injection error', { error: error.message });
      result.error = error.message;
    }

    return result;
  }

  /**
   * Extract cookies from various credential formats
   */
  extractCookies(credentials) {
    const payload = credentials?.payload;
    
    if (!payload) return [];

    // Direct cookies array
    if (Array.isArray(payload)) {
      return payload;
    }

    // Cookies in payload.cookies
    if (payload.cookies && Array.isArray(payload.cookies)) {
      return payload.cookies;
    }

    // Single cookie object
    if (payload.name && payload.value) {
      return [payload];
    }

    return [];
  }

  /**
   * Inject cookies with proper normalization
   */
  async injectCookies(targetUrl, cookies) {
    const result = {
      success: 0,
      failed: 0,
      failures: []
    };

    // Parse target URL
    const url = new URL(targetUrl);
    const targetDomain = url.hostname;
    const isHttps = url.protocol === 'https:';

    for (const cookie of cookies) {
      try {
        const normalizedCookie = this.normalizeCookie(cookie, targetDomain, isHttps);
        const setCookie = await chrome.cookies.set(normalizedCookie);
        
        if (setCookie) {
          result.success++;
        } else {
          throw new Error('Cookie.set returned null');
        }
      } catch (error) {
        result.failed++;
        result.failures.push({
          name: cookie.name,
          error: error.message
        });
        this.log('warn', 'Failed to set cookie', { name: cookie.name, error: error.message });
      }
    }

    this.log('debug', 'Cookie injection complete', { 
      success: result.success, 
      failed: result.failed 
    });

    return result;
  }

  /**
   * Normalize cookie attributes for Chrome cookies API
   */
  normalizeCookie(cookie, targetDomain, isHttps) {
    // Normalize domain
    let domain = cookie.domain || targetDomain;
    
    // Remove leading dot for the URL, but keep for domain attribute
    const domainForUrl = domain.startsWith('.') ? domain.substring(1) : domain;
    
    // Ensure domain starts with dot for subdomain cookies
    if (domain !== targetDomain && !domain.startsWith('.')) {
      // If it's a subdomain of target, add leading dot
      if (targetDomain.endsWith(domain) || domain.endsWith(targetDomain)) {
        domain = '.' + domain;
      }
    }

    // Normalize sameSite
    let sameSite = this.normalizeSameSite(cookie.sameSite);
    
    // SameSite=None requires Secure
    let secure = cookie.secure;
    if (sameSite === 'no_restriction') {
      secure = true;
    } else if (secure === undefined) {
      secure = isHttps;
    }

    // Build URL for the cookie
    const protocol = secure ? 'https' : 'http';
    const path = cookie.path || '/';
    const cookieUrl = `${protocol}://${domainForUrl}${path}`;

    // Build cookie details
    const cookieDetails = {
      url: cookieUrl,
      name: cookie.name,
      value: cookie.value,
      path: path,
      secure: secure,
      httpOnly: cookie.httpOnly === true,
      sameSite: sameSite
    };

    // Add domain only if it's a subdomain cookie (starts with dot)
    if (domain.startsWith('.')) {
      cookieDetails.domain = domain;
    }

    // Handle expiration
    cookieDetails.expirationDate = this.normalizeExpiration(cookie);

    return cookieDetails;
  }

  /**
   * Normalize sameSite attribute
   */
  normalizeSameSite(sameSite) {
    if (!sameSite) return 'lax';
    
    const value = sameSite.toString().toLowerCase();
    
    switch (value) {
      case 'none':
      case 'no_restriction':
        return 'no_restriction';
      case 'strict':
        return 'strict';
      case 'lax':
      default:
        return 'lax';
    }
  }

  /**
   * Normalize cookie expiration
   */
  normalizeExpiration(cookie) {
    // Already in epoch seconds
    if (cookie.expirationDate && typeof cookie.expirationDate === 'number') {
      return cookie.expirationDate;
    }

    // Expires as date string or number
    if (cookie.expires) {
      if (typeof cookie.expires === 'number') {
        // Check if it's already in seconds (< year 2100 in seconds)
        if (cookie.expires < 4102444800) {
          return cookie.expires;
        }
        // Otherwise it's in milliseconds
        return Math.floor(cookie.expires / 1000);
      }
      
      const expiresDate = new Date(cookie.expires);
      if (!isNaN(expiresDate.getTime())) {
        return Math.floor(expiresDate.getTime() / 1000);
      }
    }

    // Max-Age
    if (cookie.maxAge) {
      return Math.floor(Date.now() / 1000) + parseInt(cookie.maxAge, 10);
    }

    // Default: 30 days
    return Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
  }

  /**
   * Validate cookie credentials
   */
  async validate(credentials, tool) {
    const cookies = this.extractCookies(credentials);
    
    if (!cookies || cookies.length === 0) {
      return { valid: false, error: 'No cookies found in credentials' };
    }

    // Validate each cookie has required fields
    for (const cookie of cookies) {
      if (!cookie.name) {
        return { valid: false, error: 'Cookie missing name' };
      }
      if (cookie.value === undefined || cookie.value === null) {
        return { valid: false, error: `Cookie ${cookie.name} missing value` };
      }
    }

    return { valid: true };
  }

  /**
   * Clear cookies for a domain
   */
  async clearDomainCookies(domain) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      
      for (const cookie of cookies) {
        const url = `http${cookie.secure ? 's' : ''}://${cookie.domain}${cookie.path}`;
        await chrome.cookies.remove({
          url,
          name: cookie.name
        });
      }

      this.log('debug', 'Cleared cookies for domain', { domain, count: cookies.length });
      return { success: true, cleared: cookies.length };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all cookies for a domain
   */
  async getDomainCookies(domain) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      return cookies;
    } catch (error) {
      return [];
    }
  }

  /**
   * Wait for tab to load
   */
  waitForTabLoad(tabId, timeout = 15000) {
    // FIX: Use event-driven tabs.onUpdated instead of a 100ms polling loop.
    // The polling approach used up to 150 chrome.tabs.get() calls per load.
    return new Promise((resolve) => {
      const deadline = setTimeout(async () => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        // Resolve with current tab state on timeout rather than rejecting
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

      // Handle the case where the tab is already complete when we start listening
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

export default CookieStrategy;
