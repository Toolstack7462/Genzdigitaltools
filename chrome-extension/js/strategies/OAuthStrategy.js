/**
 * OAuth Strategy
 * Handles OAuth/SSO authentication flows
 * Provides foundation for various OAuth providers
 */
import { BaseStrategy } from './BaseStrategy.js';

export class OAuthStrategy extends BaseStrategy {
  constructor() {
    super('OAuth');
    
    // Common OAuth providers configuration
    this.providers = {
      google: {
        name: 'Google',
        authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        scopes: ['openid', 'email', 'profile'],
        buttonSelectors: [
          '[data-provider="google"]',
          'button[class*="google"]',
          'a[href*="google"]',
          '[aria-label*="Google"]',
          '.google-login',
          '#google-signin'
        ]
      },
      microsoft: {
        name: 'Microsoft',
        authEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        scopes: ['openid', 'email', 'profile'],
        buttonSelectors: [
          '[data-provider="microsoft"]',
          'button[class*="microsoft"]',
          'a[href*="microsoft"]',
          '[aria-label*="Microsoft"]',
          '.microsoft-login'
        ]
      },
      github: {
        name: 'GitHub',
        authEndpoint: 'https://github.com/login/oauth/authorize',
        tokenEndpoint: 'https://github.com/login/oauth/access_token',
        scopes: ['read:user', 'user:email'],
        buttonSelectors: [
          '[data-provider="github"]',
          'button[class*="github"]',
          'a[href*="github"]',
          '[aria-label*="GitHub"]',
          '.github-login'
        ]
      },
      okta: {
        name: 'Okta',
        buttonSelectors: [
          '[data-provider="okta"]',
          'button[class*="okta"]',
          'a[href*="okta"]',
          '.okta-login'
        ]
      },
      saml: {
        name: 'SAML/SSO',
        buttonSelectors: [
          '[data-provider="sso"]',
          'button[class*="sso"]',
          'a[href*="sso"]',
          '.sso-login',
          'button[class*="enterprise"]',
          'a[href*="saml"]'
        ]
      }
    };
  }
  
  /**
   * Check if this strategy can handle the config
   */
  canHandle(config) {
    return config.oauth && (config.oauth.provider || config.oauth.authUrl);
  }
  
  /**
   * Execute OAuth authentication
   */
  async execute(config, context) {
    this.log('Executing OAuth strategy', { 
      provider: config.oauth.provider,
      domain: config.domain 
    });
    
    const oauthConfig = config.oauth;
    
    // If we have pre-authenticated tokens, inject them
    if (oauthConfig.tokens) {
      return this.injectOAuthTokens(config, context);
    }
    
    // If we have session bootstrap data, use it
    if (oauthConfig.sessionData) {
      return this.bootstrapSession(config, context);
    }
    
    // If we need to trigger OAuth flow via button click
    if (oauthConfig.provider || oauthConfig.buttonSelector) {
      return this.triggerOAuthFlow(config, context);
    }
    
    // If we have a direct auth URL
    if (oauthConfig.authUrl) {
      return this.redirectToAuth(config, context);
    }
    
    return {
      success: false,
      strategy: this.name,
      error: 'No valid OAuth configuration found'
    };
  }
  
  /**
   * Inject pre-authenticated OAuth tokens
   */
  async injectOAuthTokens(config, context) {
    if (!context.tabId) {
      return { success: false, error: 'No tab ID for token injection' };
    }
    
    const tokens = config.oauth.tokens;
    
    try {
      await chrome.scripting.executeScript({
        target: { tabId: context.tabId },
        func: (tokenData) => {
          // Store tokens in common locations
          if (tokenData.accessToken) {
            localStorage.setItem('access_token', tokenData.accessToken);
            localStorage.setItem('token', tokenData.accessToken);
          }
          if (tokenData.refreshToken) {
            localStorage.setItem('refresh_token', tokenData.refreshToken);
          }
          if (tokenData.idToken) {
            localStorage.setItem('id_token', tokenData.idToken);
          }
          if (tokenData.expiresAt) {
            localStorage.setItem('token_expires_at', tokenData.expiresAt);
          }
          
          // Store full auth object
          localStorage.setItem('auth', JSON.stringify(tokenData));
        },
        args: [tokens]
      });
      
      this.log('OAuth tokens injected successfully');
      
      return {
        success: true,
        strategy: this.name,
        type: 'token_injection',
        needsReload: true
      };
    } catch (error) {
      this.logError('Token injection failed', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Bootstrap session with OAuth data (cookies + tokens)
   */
  async bootstrapSession(config, context) {
    const sessionData = config.oauth.sessionData;
    const results = { cookies: null, storage: null };
    
    // Inject cookies if provided
    if (sessionData.cookies && sessionData.cookies.length > 0) {
      const targetUrl = config.targetUrl || `https://${config.domain}/`;
      results.cookies = await this.injectSessionCookies(targetUrl, sessionData.cookies);
    }
    
    // Inject storage if provided
    if (sessionData.storage && context.tabId) {
      results.storage = await this.injectSessionStorage(
        context.tabId,
        sessionData.storage,
        sessionData.storageType || 'localStorage'
      );
    }
    
    const success = (results.cookies?.success || !sessionData.cookies) &&
                    (results.storage?.success || !sessionData.storage);
    
    return {
      success,
      strategy: this.name,
      type: 'session_bootstrap',
      results,
      needsReload: success
    };
  }
  
  /**
   * Inject session cookies
   */
  async injectSessionCookies(targetUrl, cookies) {
    const domain = new URL(targetUrl).hostname;
    const isHttps = targetUrl.startsWith('https');
    let setCount = 0;
    
    for (const cookie of cookies) {
      try {
        const protocol = isHttps ? 'https' : 'http';
        const cleanDomain = cookie.domain?.startsWith('.') 
          ? cookie.domain.substring(1) 
          : (cookie.domain || domain);
        
        await chrome.cookies.set({
          url: `${protocol}://${cleanDomain}/`,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || '/',
          secure: cookie.secure !== false,
          httpOnly: cookie.httpOnly || false,
          sameSite: cookie.sameSite || 'lax',
          expirationDate: cookie.expirationDate || (Date.now() / 1000 + 86400 * 30)
        });
        setCount++;
      } catch (e) {
        this.logError(`Failed to set cookie: ${cookie.name}`, e);
      }
    }
    
    return { success: setCount > 0, set: setCount, total: cookies.length };
  }
  
  /**
   * Inject session storage
   */
  async injectSessionStorage(tabId, data, storageType) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (storageData, type) => {
          const storage = type === 'sessionStorage' ? sessionStorage : localStorage;
          let setCount = 0;
          for (const [key, value] of Object.entries(storageData)) {
            storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
            setCount++;
          }
          return { success: true, set: setCount };
        },
        args: [data, storageType]
      });
      return results[0]?.result || { success: false };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  
  /**
   * Trigger OAuth flow by clicking provider button
   */
  async triggerOAuthFlow(config, context) {
    if (!context.tabId) {
      return { success: false, error: 'No tab ID for OAuth trigger' };
    }
    
    const provider = config.oauth.provider;
    const providerConfig = this.providers[provider];
    
    const buttonSelectors = config.oauth.buttonSelector 
      ? [config.oauth.buttonSelector]
      : (providerConfig?.buttonSelectors || []);
    
    if (buttonSelectors.length === 0) {
      return { success: false, error: `No button selectors for provider: ${provider}` };
    }
    
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: context.tabId },
        func: (selectors) => {
          for (const selector of selectors) {
            const button = document.querySelector(selector);
            if (button && button.offsetParent !== null) {
              button.click();
              return { success: true, selector, clicked: true };
            }
          }
          return { success: false, error: 'OAuth button not found' };
        },
        args: [buttonSelectors]
      });
      
      const result = results[0]?.result;
      
      if (result?.clicked) {
        this.log(`OAuth button clicked: ${result.selector}`);
      }
      
      return {
        success: result?.success || false,
        strategy: this.name,
        type: 'button_click',
        ...result,
        needsReload: false // OAuth redirect handles navigation
      };
    } catch (error) {
      this.logError('OAuth trigger failed', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Redirect to OAuth auth URL
   */
  async redirectToAuth(config, context) {
    const authUrl = config.oauth.authUrl;
    
    if (context.tabId) {
      await chrome.tabs.update(context.tabId, { url: authUrl });
    } else {
      await chrome.tabs.create({ url: authUrl });
    }
    
    return {
      success: true,
      strategy: this.name,
      type: 'redirect',
      authUrl,
      needsReload: false
    };
  }
  
  /**
   * Detect available OAuth providers on page
   */
  async detectOAuthProviders(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (providers) => {
          const found = [];
          
          for (const [name, config] of Object.entries(providers)) {
            for (const selector of config.buttonSelectors) {
              const el = document.querySelector(selector);
              if (el && el.offsetParent !== null) {
                found.push({
                  provider: name,
                  name: config.name,
                  selector,
                  text: el.textContent?.trim()
                });
                break;
              }
            }
          }
          
          return found;
        },
        args: [this.providers]
      });
      
      return results[0]?.result || [];
    } catch (error) {
      this.logError('OAuth provider detection failed', error);
      return [];
    }
  }
}

export default OAuthStrategy;
