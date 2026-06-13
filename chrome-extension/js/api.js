// Storage utility for Chrome extension
const Storage = {
  async get(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });
  },
  
  async set(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set(data, resolve);
    });
  },
  
  async remove(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(keys, resolve);
    });
  },
  
  async clear() {
    return new Promise((resolve) => {
      chrome.storage.local.clear(resolve);
    });
  }
};

// API client for extension
class ApiClient {
  constructor() {
    this.baseUrl = null;
    this.token = null;
  }
  
  async init() {
    const data = await Storage.get(['apiUrl', 'extensionToken']);
    this.baseUrl = data.apiUrl || '';
    this.token = data.extensionToken || null;
    return this;
  }
  
  setToken(token) {
    this.token = token;
  }
  
  setBaseUrl(url) {
    this.baseUrl = url;
  }
  
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}/api/crm/extension${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Extension-Version': chrome.runtime.getManifest().version,
      ...options.headers
    };
    
    if (this.token) {
      headers['Authorization'] = `ExtToken ${this.token}`;
    }
    
    try {
      const response = await fetch(url, {
        ...options,
        headers
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Request failed');
      }
      
      return data;
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  }
  
  async login(email, password) {
    return this.request('/auth', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
  }
  
  async logout() {
    return this.request('/logout', { method: 'POST' });
  }
  
  async getTools() {
    return this.request('/tools');
  }
  
  async getToolVersions() {
    return this.request('/tools/versions');
  }
  
  async getCredentials(toolId) {
    return this.request(`/tools/${toolId}/credentials`);
  }

  /**
   * Check if session bundle has been updated for a tool
   * Returns the latest session bundle if version changed
   */
  async checkSessionBundleUpdate(toolId, currentVersion) {
    try {
      const result = await this.getCredentials(toolId);
      
      if (result.sessionBundle) {
        const latestVersion = result.sessionBundle.version || 0;
        const hasUpdate = latestVersion > (currentVersion || 0);
        
        return {
          hasUpdate,
          currentVersion: currentVersion || 0,
          latestVersion,
          sessionBundle: hasUpdate ? result.sessionBundle : null,
          credentials: result.credentials,
          tool: result.tool
        };
      }
      
      return { hasUpdate: false, currentVersion, latestVersion: 0 };
    } catch (error) {
      console.error('Failed to check session bundle update:', error);
      return { hasUpdate: false, error: error.message };
    }
  }

  /**
   * Get cached session bundle version for a tool
   */
  async getCachedBundleVersion(toolId) {
    const key = `sessionBundle_v_${toolId}`;
    const data = await Storage.get([key]);
    return data[key] || 0;
  }

  /**
   * Cache session bundle version after applying
   */
  async setCachedBundleVersion(toolId, version) {
    const key = `sessionBundle_v_${toolId}`;
    await Storage.set({ [key]: version });
  }
  
  async logToolOpened(toolId) {
    return this.request(`/tools/${toolId}/opened`, { method: 'POST' });
  }
  
  async getProfile() {
    return this.request('/profile');
  }
  
  async getDomains() {
    return this.request('/domains');
  }
}

// Cookie utilities
const CookieUtils = {
  /**
   * Parse cookies from various formats
   */
  parseCookies(input) {
    if (!input) return [];
    
    // If already an array, return as-is
    if (Array.isArray(input)) {
      return input;
    }
    
    // If string, try to parse as JSON
    if (typeof input === 'string') {
      try {
        const parsed = JSON.parse(input);
        if (Array.isArray(parsed)) {
          return parsed;
        }
        // Single cookie object
        return [parsed];
      } catch (e) {
        // Try to parse as cookie string (name=value; name2=value2)
        return this.parseCookieString(input);
      }
    }
    
    // Single cookie object
    if (typeof input === 'object') {
      return [input];
    }
    
    return [];
  },
  
  /**
   * Parse cookie string format
   */
  parseCookieString(cookieStr) {
    if (!cookieStr) return [];
    
    return cookieStr.split(';').map(part => {
      const [name, ...valueParts] = part.trim().split('=');
      return {
        name: name.trim(),
        value: valueParts.join('=').trim()
      };
    }).filter(c => c.name);
  },
  
  /**
   * Validate cookie object
   */
  validateCookie(cookie) {
    if (!cookie || typeof cookie !== 'object') {
      return { valid: false, error: 'Invalid cookie format' };
    }
    
    if (!cookie.name || typeof cookie.name !== 'string') {
      return { valid: false, error: 'Cookie must have a name' };
    }
    
    if (cookie.value === undefined || cookie.value === null) {
      return { valid: false, error: 'Cookie must have a value' };
    }
    
    return { valid: true };
  },
  
  /**
   * Normalize cookie for Chrome API
   */
  normalizeCookie(cookie, defaultDomain) {
    const normalized = {
      name: String(cookie.name),
      value: String(cookie.value),
      path: cookie.path || '/',
      secure: cookie.secure !== false,
      httpOnly: cookie.httpOnly === true
    };
    
    // Handle domain
    if (cookie.domain) {
      normalized.domain = cookie.domain;
    } else if (defaultDomain) {
      normalized.domain = defaultDomain;
    }
    
    // Handle SameSite
    let sameSite = (cookie.sameSite || 'lax').toLowerCase();
    if (sameSite === 'none' || sameSite === 'no_restriction') {
      normalized.sameSite = 'no_restriction';
      normalized.secure = true; // SameSite=None requires Secure
    } else if (sameSite === 'strict') {
      normalized.sameSite = 'strict';
    } else {
      normalized.sameSite = 'lax';
    }
    
    // Handle expiration
    if (cookie.expirationDate) {
      normalized.expirationDate = cookie.expirationDate;
    } else if (cookie.expires) {
      const expiresDate = new Date(cookie.expires);
      if (!isNaN(expiresDate.getTime())) {
        normalized.expirationDate = Math.floor(expiresDate.getTime() / 1000);
      }
    }
    
    // Default expiration: 30 days
    if (!normalized.expirationDate) {
      normalized.expirationDate = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
    }
    
    return normalized;
  }
};

// Domain utilities
const DomainUtils = {
  /**
   * Extract hostname from URL
   */
  extractDomain(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return url;
    }
  },
  
  /**
   * Get base domain (e.g., example.com from sub.example.com)
   */
  getBaseDomain(hostname) {
    const parts = hostname.split('.');
    if (parts.length <= 2) return hostname;
    
    // Handle common multi-part TLDs
    const commonMultiPartTLDs = ['co.uk', 'com.au', 'co.nz', 'co.in', 'com.br', 'org.uk', 'net.au'];
    const lastTwo = parts.slice(-2).join('.');
    if (commonMultiPartTLDs.includes(lastTwo)) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  },
  
  /**
   * Check if two domains match (considering subdomains)
   */
  domainsMatch(domain1, domain2) {
    if (!domain1 || !domain2) return false;
    
    // Exact match
    if (domain1 === domain2) return true;
    
    // Remove leading dots
    const clean1 = domain1.replace(/^\./, '');
    const clean2 = domain2.replace(/^\./, '');
    
    // Exact match after cleaning
    if (clean1 === clean2) return true;
    
    // Subdomain match
    if (clean1.endsWith('.' + clean2) || clean2.endsWith('.' + clean1)) return true;
    
    // Base domain match
    const base1 = this.getBaseDomain(clean1);
    const base2 = this.getBaseDomain(clean2);
    return base1 === base2;
  },
  
  /**
   * Build URL for cookie API
   */
  buildCookieUrl(domain, secure = true) {
    const protocol = secure ? 'https' : 'http';
    const cleanDomain = domain.startsWith('.') ? domain.substring(1) : domain;
    return `${protocol}://${cleanDomain}/`;
  }
};

// Export for use in other files
export { Storage, ApiClient, CookieUtils, DomainUtils };
