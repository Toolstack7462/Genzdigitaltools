/**
 * Strategy Engine
 * Orchestrates login strategies with intelligent fallback
 */
import { CookieStrategy } from './CookieStrategy.js';
import { TokenStrategy } from './TokenStrategy.js';
import { FormStrategy } from './FormStrategy.js';
import { OAuthStrategy } from './OAuthStrategy.js';
import { SSOStrategy } from './SSOStrategy.js';
import { HeadersStrategy } from './HeadersStrategy.js';
import { DEFAULT_STRATEGY_ORDER, TIMEOUTS, RETRY_CONFIG } from '../config/toolConfigs.js';

export class StrategyEngine {
  constructor() {
    // Initialize all strategies
    this.strategies = {
      cookie: new CookieStrategy(),
      token: new TokenStrategy(),
      form: new FormStrategy(),
      oauth: new OAuthStrategy(),
      sso: new SSOStrategy(),
      headers: new HeadersStrategy()
    };
    
    // Track execution results
    this.executionHistory = new Map();
    
    // Track success rates per domain for intelligent ordering
    this.successRates = new Map();
  }
  
  /**
   * Execute login strategies in order with fallback and retry
   * @param {Object} config - Tool configuration
   * @param {Object} context - Execution context (tabId, url, etc.)
   * @returns {Promise<Object>} Combined result
   */
  async execute(config, context) {
    const strategyOrder = this.getOptimalStrategyOrder(config);
    const results = [];
    let finalResult = null;
    const retryAttempts = config.options?.retryAttempts || RETRY_CONFIG.maxAttempts;
    
    this.log(`Starting strategy execution for ${config.domain}`, { 
      strategies: strategyOrder,
      context,
      retryAttempts
    });
    
    for (const strategyName of strategyOrder) {
      const strategy = this.strategies[strategyName];
      
      if (!strategy) {
        this.log(`Strategy not found: ${strategyName}`);
        continue;
      }
      
      // Check if strategy can handle this config
      if (!strategy.canHandle(config)) {
        this.log(`Strategy ${strategyName} cannot handle config, skipping`);
        results.push({
          strategy: strategyName,
          skipped: true,
          reason: 'Cannot handle config'
        });
        continue;
      }
      
      this.log(`Executing strategy: ${strategyName}`);
      
      // Execute with retry
      let attemptCount = 0;
      let lastError = null;
      let result = null;
      
      while (attemptCount < retryAttempts) {
        attemptCount++;
        
        try {
          // Execute strategy with timeout
          // FIX20: Pass a factory fn so AbortSignal is threaded into strategy
          result = await this.executeWithTimeout(
            (signal) => strategy.execute(config, { ...context, signal }),
            TIMEOUTS.strategyExecution
          );
          
          if (result.success) {
            // Update success tracking
            this.updateSuccessRate(config.domain, strategyName, true);
            break;
          }
          
          lastError = result.error;
          
          // Don't retry if it's a configuration issue
          if (result.skipRetry) {
            break;
          }
          
          // Wait before retry with exponential backoff
          if (attemptCount < retryAttempts) {
            const delay = Math.min(
              (config.options?.retryDelayMs || RETRY_CONFIG.retryDelay) * Math.pow(RETRY_CONFIG.backoffMultiplier, attemptCount - 1),
              RETRY_CONFIG.maxDelay
            );
            this.log(`Strategy ${strategyName} failed, retrying in ${delay}ms (attempt ${attemptCount}/${retryAttempts})`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        } catch (error) {
          lastError = error.message;
          this.log(`Strategy ${strategyName} threw error: ${error.message}`);
          
          if (error.message === 'Strategy timeout') {
            break; // Don't retry timeouts
          }
        }
      }
      
      const strategyResult = result || {
        success: false,
        strategy: strategyName,
        error: lastError || 'Unknown error',
        attempts: attemptCount
      };
      
      strategyResult.attempts = attemptCount;
      results.push(strategyResult);
      
      // If successful, we're done (unless we need to continue for completeness)
      if (strategyResult.success) {
        this.log(`Strategy ${strategyName} succeeded after ${attemptCount} attempt(s)`);
        finalResult = strategyResult;
        
        // Some strategies may indicate we should continue (e.g., cookie + token)
        if (!strategyResult.continueStrategies) {
          break;
        }
      } else if (strategyResult.partial) {
        // Partial success - continue but remember this result
        this.log(`Strategy ${strategyName} partially succeeded`);
        this.updateSuccessRate(config.domain, strategyName, false);
        if (!finalResult) {
          finalResult = strategyResult;
        }
      } else {
        this.log(`Strategy ${strategyName} failed: ${strategyResult.error || 'Unknown error'}`);
        this.updateSuccessRate(config.domain, strategyName, false);
      }
    }
    
    // Store execution history
    this.executionHistory.set(config.domain, {
      timestamp: Date.now(),
      results,
      finalResult
    });
    
    // Build combined result
    const combinedResult = {
      success: finalResult?.success || false,
      partial: finalResult?.partial || false,
      strategies: results,
      executedCount: results.filter(r => !r.skipped).length,
      successfulStrategy: finalResult?.strategy || null,
      needsReload: finalResult?.needsReload || false,
      needsTab: results.some(r => r.needsTab)
    };
    
    this.log('Strategy execution complete', combinedResult);
    
    return combinedResult;
  }
  
  /**
   * Get optimal strategy order based on config and success history
   */
  getOptimalStrategyOrder(config) {
    const baseOrder = config.strategies || DEFAULT_STRATEGY_ORDER;
    const domainHistory = this.successRates.get(config.domain);
    
    if (!domainHistory) {
      return baseOrder;
    }
    
    // Sort by success rate (descending)
    return [...baseOrder].sort((a, b) => {
      const rateA = domainHistory[a]?.successRate || 0;
      const rateB = domainHistory[b]?.successRate || 0;
      return rateB - rateA;
    });
  }
  
  /**
   * Update success rate tracking
   */
  updateSuccessRate(domain, strategy, success) {
    if (!this.successRates.has(domain)) {
      this.successRates.set(domain, {});
    }
    
    const domainRates = this.successRates.get(domain);
    
    if (!domainRates[strategy]) {
      domainRates[strategy] = { attempts: 0, successes: 0, successRate: 0 };
    }
    
    domainRates[strategy].attempts++;
    if (success) {
      domainRates[strategy].successes++;
    }
    domainRates[strategy].successRate = 
      domainRates[strategy].successes / domainRates[strategy].attempts;
  }
  
  /**
   * Execute with timeout and AbortController signal
   * FIX20: The strategy receives an AbortSignal so it can self-cancel
   * rather than continuing to run silently after the race resolves.
   */
  async executeWithTimeout(strategyExecuteFn, timeout) {
    const controller = new AbortController();
    const { signal } = controller;

    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeout);

    try {
      const result = await Promise.race([
        strategyExecuteFn(signal),
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Strategy timeout')), { once: true });
        })
      ]);
      clearTimeout(timeoutId);
      return result;
    } catch (err) {
      clearTimeout(timeoutId);
      controller.abort(); // ensure strategy is signalled to stop
      throw err;
    }
  }
  
  /**
   * Pre-execute strategies that don't need a tab (cookies)
   * @param {Object} config - Tool configuration
   * @returns {Promise<Object>} Pre-execution result
   */
  async preExecute(config) {
    const results = [];
    
    // Only cookie strategy can run before tab is opened
    if (this.strategies.cookie.canHandle(config)) {
      this.log('Pre-executing cookie strategy');
      
      const result = await this.strategies.cookie.execute(config, {});
      results.push({ strategy: 'cookie', ...result });
      
      if (result.success) {
        return {
          success: true,
          preExecuted: ['cookie'],
          results,
          needsReload: true
        };
      }
    }
    
    return {
      success: false,
      preExecuted: [],
      results
    };
  }
  
  /**
   * Post-execute strategies that need a tab (token, form, oauth)
   * @param {Object} config - Tool configuration
   * @param {Object} context - Execution context with tabId
   * @param {Array} skipStrategies - Strategies to skip (already executed)
   * @returns {Promise<Object>} Post-execution result
   */
  async postExecute(config, context, skipStrategies = []) {
    const strategyOrder = (config.strategies || DEFAULT_STRATEGY_ORDER)
      .filter(s => !skipStrategies.includes(s));
    
    return this.execute({ ...config, strategies: strategyOrder }, context);
  }
  
  /**
   * Verify login status
   * @param {Object} config - Tool configuration
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Verification result
   */
  async verify(config, context) {
    const lastExecution = this.executionHistory.get(config.domain);
    
    if (!lastExecution || !lastExecution.finalResult) {
      return { verified: false, reason: 'No execution history' };
    }
    
    const strategyName = lastExecution.finalResult.strategy;
    const strategy = this.strategies[strategyName];
    
    if (!strategy) {
      return { verified: false, reason: 'Strategy not found' };
    }
    
    try {
      const verified = await strategy.verify(config, context);
      return { verified, strategy: strategyName };
    } catch (error) {
      return { verified: false, error: error.message };
    }
  }
  
  /**
   * Get best strategy for a tool based on config and history
   * @param {Object} config - Tool configuration
   * @returns {string} Best strategy name
   */
  getBestStrategy(config) {
    // Check execution history for successful strategies
    const history = this.executionHistory.get(config.domain);
    if (history?.finalResult?.success) {
      return history.finalResult.strategy;
    }
    
    // Check config for strategies that can handle
    const strategyOrder = config.strategies || DEFAULT_STRATEGY_ORDER;
    
    for (const strategyName of strategyOrder) {
      const strategy = this.strategies[strategyName];
      if (strategy?.canHandle(config)) {
        return strategyName;
      }
    }
    
    return strategyOrder[0] || 'cookie';
  }
  
  /**
   * Detect login state on current page
   * @param {number} tabId - Tab ID to check
   * @returns {Promise<Object>} Login state
   */
  async detectLoginState(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Check URL for login indicators
          const url = window.location.href.toLowerCase();
          const isLoginPage = /\/(login|signin|sign-in|auth|authenticate)/.test(url);
          
          // Check for password field
          const hasPasswordField = !!document.querySelector('input[type="password"]');
          
          // Check for logged-in indicators
          const loggedInSelectors = [
            '[class*="logout"]', '[class*="signout"]', 'a[href*="logout"]',
            '[class*="user-menu"]', '[class*="user-avatar"]', '[class*="profile-menu"]'
          ];
          const hasLoggedInIndicator = loggedInSelectors.some(s => document.querySelector(s));
          
          // Check localStorage for common auth tokens
          const authKeys = ['token', 'auth_token', 'access_token', 'jwt', 'user', 'session'];
          const hasStoredAuth = authKeys.some(k => localStorage.getItem(k));
          
          return {
            url,
            isLoginPage,
            hasPasswordField,
            hasLoggedInIndicator,
            hasStoredAuth,
            isLoggedIn: hasLoggedInIndicator || (hasStoredAuth && !isLoginPage),
            needsLogin: isLoginPage || (hasPasswordField && !hasLoggedInIndicator)
          };
        }
      });
      
      return results[0]?.result || { isLoggedIn: false, needsLogin: true };
    } catch (error) {
      this.log(`Login state detection error: ${error.message}`);
      return { isLoggedIn: false, needsLogin: true, error: error.message };
    }
  }
  
  /**
   * Get form strategy for login page detection
   */
  getFormStrategy() {
    return this.strategies.form;
  }
  
  /**
   * Get OAuth strategy for provider detection
   */
  getOAuthStrategy() {
    return this.strategies.oauth;
  }
  
  /**
   * Get SSO strategy for one-click flows
   */
  getSSOStrategy() {
    return this.strategies.sso;
  }
  
  /**
   * Get Headers strategy
   */
  getHeadersStrategy() {
    return this.strategies.headers;
  }
  
  /**
   * Get all available strategies
   */
  getAvailableStrategies() {
    return Object.keys(this.strategies);
  }
  
  /**
   * Get success rates for a domain
   */
  getDomainSuccessRates(domain) {
    return this.successRates.get(domain) || {};
  }
  
  /**
   * Clear success rate history
   */
  clearSuccessRates(domain = null) {
    if (domain) {
      this.successRates.delete(domain);
    } else {
      this.successRates.clear();
    }
  }
  
  /**
   * Log message
   */
  log(message, data = null) {
    const logMsg = `[StrategyEngine] ${message}`;
    if (data) {
      console.log(logMsg, data);
    } else {
      console.log(logMsg);
    }
  }
}

// Singleton instance
let engineInstance = null;

export function getStrategyEngine() {
  if (!engineInstance) {
    engineInstance = new StrategyEngine();
  }
  return engineInstance;
}

export default StrategyEngine;
