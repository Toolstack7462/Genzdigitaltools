import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import AdminLayout from '../../components/AdminLayout';
import { ArrowLeft, Save, Package, Link as LinkIcon, FileText, Key, Settings, Shield, Database, LogIn, Globe, AlertCircle, CheckCircle, Info, Zap, ToggleLeft, ToggleRight } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const AdminToolForm = () => {
  const navigate = useNavigate();
  const { id } = useParams();
  const isEdit = Boolean(id);
  const { showSuccess, showError } = useToast();
  
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    targetUrl: '',
    loginUrl: '',
    category: 'Other',
    credentialType: 'cookies',
    // Unified credential fields
    credentials: {
      type: 'cookies',
      payload: {},
      selectors: {},
      successCheck: {}
    },
    // Legacy fields (for backward compatibility)
    cookiesEncrypted: '',
    tokenEncrypted: '',
    tokenHeader: 'Authorization',
    tokenPrefix: 'Bearer ',
    localStorageEncrypted: '',
    status: 'active',
    extensionSettings: {
      requirePermission: true,
      autoInject: true,
      injectOnPageLoad: true,
      clearExistingCookies: false,
      reloadAfterLogin: true,
      waitForNavigation: true,
      spaMode: false,
      retryAttempts: 2,
      retryDelayMs: 1000,
      hiddenModeEnabled: true,
      hiddenModeTimeout: 60000,
      autoStartEnabled: true,
      autoStartDelay: 800,
      maxAutoAttempts: 2
    }
  });

  // Universal Combo Auth state - allows ANY two auth types combined
  const [comboAuth, setComboAuth] = useState({
    enabled: false,
    // Run mode: 'sequential' (primary->fallback) or 'parallel' (simultaneous)
    runMode: 'sequential',
    // Universal: Select which two types to combine
    primaryType: 'sso',      // First auth type to try
    secondaryType: 'form',   // Second auth type (fallback)
    fallbackEnabled: true,
    fallbackOnlyOnce: true,  // Only try fallback once
    skipIfLoggedIn: true,    // Skip if already logged in
    triggerOnAuto: true,
    // Parallel mode settings
    parallelSettings: {
      prepSessionFirst: true,    // Apply session bundle before auth
      parallelTimeout: 30000,    // Timeout for parallel execution (ms)
      commitLock: true,          // Ensure only one navigation
      verifyAfterAuth: true      // Verify login after auth
    },
    // Form login configuration
    formConfig: {
      username: '',
      password: '',
      loginUrl: '',
      multiStep: false,
      rememberMe: true,
      submitDelay: 800,
      autoSubmit: true
    },
    // SSO configuration
    ssoConfig: {
      authStartUrl: '',
      postLoginUrl: '',
      provider: '',
      buttonSelector: '',
      autoClick: true
    },
    // Cookies configuration (for Cookies + SSO or Cookies + Form combos)
    cookiesConfig: {
      cookies: '',  // JSON array of cookies
      injectFirst: true  // Inject cookies before trying other auth
    },
    // Token configuration
    tokenConfig: {
      token: '',
      header: 'Authorization',
      prefix: 'Bearer ',
      storageKey: 'access_token'
    },
    // Headers configuration  
    headersConfig: {
      headers: []  // Array of {name, value, prefix}
    },
    // LocalStorage configuration
    localStorageConfig: {
      data: ''  // JSON object
    },
    // SessionStorage configuration
    sessionStorageConfig: {
      data: ''  // JSON object
    }
  });

  // Session Bundle state - unified storage for cookies + localStorage + sessionStorage
  const [sessionBundle, setSessionBundle] = useState({
    cookies: '',
    localStorage: '',
    sessionStorage: ''
  });
  const [sessionBundleVersion, setSessionBundleVersion] = useState(null);
  const [savingBundle, setSavingBundle] = useState(false);

  // Combo auth tab state - dynamically set based on selected types
  const [comboAuthTab, setComboAuthTab] = useState('primary');

  // Available combo types
  const COMBO_AUTH_TYPES = [
    { value: 'sso', label: 'SSO / OAuth', icon: '🔐' },
    { value: 'form', label: 'Form Login', icon: '📝' },
    { value: 'cookies', label: 'Cookies', icon: '🍪' },
    { value: 'token', label: 'Bearer Token', icon: '🔑' },
    { value: 'headers', label: 'Custom Headers', icon: '📋' },
    { value: 'localStorage', label: 'Local Storage', icon: '💾' },
    { value: 'sessionStorage', label: 'Session Storage', icon: '📦' }
  ];

  const CATEGORIES = ['AI', 'Academic', 'SEO', 'Productivity', 'Graphics & SEO', 'Text Humanizers', 'Career-Oriented', 'Miscellaneous', 'Other'];
  
  // Unified credential types with better descriptions
  const CREDENTIAL_TYPES = [
    { 
      value: 'combo', 
      label: 'Combo Auth', 
      icon: '🔀', 
      description: 'Combine ANY two auth types',
      hint: 'Cookies+SSO, SSO+Form, etc.',
      isCombo: true
    },
    { 
      value: 'form', 
      label: 'Form Login', 
      icon: '📝', 
      description: 'Username/password form auto-fill',
      hint: 'Best for traditional login pages'
    },
    { 
      value: 'sso', 
      label: 'SSO / OAuth', 
      icon: '🔐', 
      description: 'One-click SSO authentication',
      hint: 'Google, Microsoft, SAML, etc.'
    },
    { 
      value: 'cookies', 
      label: 'Cookies', 
      icon: '🍪', 
      description: 'Inject browser cookies',
      hint: 'Export from browser DevTools'
    },
    { 
      value: 'token', 
      label: 'Bearer Token', 
      icon: '🔑', 
      description: 'JWT / API token injection',
      hint: 'Stored in localStorage'
    },
    { 
      value: 'headers', 
      label: 'Custom Headers', 
      icon: '📋', 
      description: 'Multiple header auth (MV3 limited)',
      hint: 'Prefer cookies for MV3'
    },
    { 
      value: 'localStorage', 
      label: 'Local Storage', 
      icon: '💾', 
      description: 'Inject localStorage data',
      hint: 'Key-value pairs'
    },
    { 
      value: 'sessionStorage', 
      label: 'Session Storage', 
      icon: '⏱️', 
      description: 'Inject sessionStorage data',
      hint: 'Cleared on tab close'
    },
    { 
      value: 'none', 
      label: 'None', 
      icon: '⭕', 
      description: 'No credentials needed',
      hint: 'Public tool'
    }
  ];

  // Form-specific state
  const [formLoginData, setFormLoginData] = useState({
    username: '',
    password: '',
    loginUrl: ''
  });
  
  const [formOptions, setFormOptions] = useState({
    multiStep: false,
    rememberMe: true,
    clearFieldsFirst: true,
    submitDelay: 200,
    autoSubmit: true  // NEW: Auto-submit form when ?auto=1
  });
  
  const [formSelectors, setFormSelectors] = useState({
    username: '',
    password: '',
    submit: '',
    next: '',
    rememberMe: '',
    errorMessage: ''
  });
  
  const [successCheck, setSuccessCheck] = useState({
    urlIncludes: '',
    urlExcludes: '',
    elementExists: '',
    elementNotExists: '',
    cookieNames: ''
  });
  
  // SSO-specific state
  const [ssoData, setSsoData] = useState({
    authStartUrl: '',
    postLoginUrl: '',
    provider: '',
    buttonSelector: '',
    autoClick: true
  });
  
  const [ssoOptions, setSsoOptions] = useState({
    flowType: 'redirect',
    autoClickProvider: true,
    waitForAccountChooser: true,
    accountHint: ''
  });
  
  // MFA handling options
  const [mfaOptions, setMfaOptions] = useState({
    detectMFA: true,
    action: 'notify',
    mfaSelectors: ''
  });
  
  // Headers-specific state
  const [headersData, setHeadersData] = useState([
    { name: 'Authorization', value: '', prefix: 'Bearer ' }
  ]);

  useEffect(() => {
    if (isEdit) {
      loadTool();
    }
  }, [id]);

  const loadTool = async () => {
    try {
      const res = await api.get(`/admin/tools/${id}`);
      const tool = res.data.tool;
      
      // Check if combo auth is enabled
      const isComboEnabled = tool.comboAuth?.enabled === true;
      
      // Load form data
      setFormData({
        name: tool.name || '',
        description: tool.description || '',
        targetUrl: tool.targetUrl || '',
        loginUrl: tool.loginUrl || '',
        category: tool.category || 'Other',
        credentialType: isComboEnabled ? 'combo' : (tool.credentials?.type || tool.credentialType || 'cookies'),
        credentials: tool.credentials || { type: 'cookies', payload: {}, selectors: {}, successCheck: {} },
        cookiesEncrypted: '', // Don't show encrypted data
        tokenEncrypted: '',
        tokenHeader: tool.tokenHeader || 'Authorization',
        tokenPrefix: tool.tokenPrefix || 'Bearer ',
        localStorageEncrypted: '',
        status: tool.status || 'active',
        extensionSettings: {
          requirePermission: tool.extensionSettings?.requirePermission ?? true,
          autoInject: tool.extensionSettings?.autoInject ?? true,
          injectOnPageLoad: tool.extensionSettings?.injectOnPageLoad ?? true,
          clearExistingCookies: tool.extensionSettings?.clearExistingCookies ?? false,
          reloadAfterLogin: tool.extensionSettings?.reloadAfterLogin ?? true,
          waitForNavigation: tool.extensionSettings?.waitForNavigation ?? true,
          spaMode: tool.extensionSettings?.spaMode ?? false,
          retryAttempts: tool.extensionSettings?.retryAttempts ?? 2,
          retryDelayMs: tool.extensionSettings?.retryDelayMs ?? 1000,
          hiddenModeEnabled: tool.extensionSettings?.hiddenModeEnabled ?? true,
          hiddenModeTimeout: tool.extensionSettings?.hiddenModeTimeout ?? 60000,
          autoStartEnabled: tool.extensionSettings?.autoStartEnabled ?? true,
          autoStartDelay: tool.extensionSettings?.autoStartDelay ?? 800,
          maxAutoAttempts: tool.extensionSettings?.maxAutoAttempts ?? 2
        }
      });
      
      // Load combo auth if present
      if (tool.comboAuth) {
        setComboAuth(prev => ({
          ...prev,
          enabled: tool.comboAuth.enabled || false,
          runMode: tool.comboAuth.runMode || 'sequential',
          primaryType: tool.comboAuth.primaryType || tool.comboAuth.primary || 'sso',
          secondaryType: tool.comboAuth.secondaryType || 'form',
          fallbackEnabled: tool.comboAuth.fallbackEnabled ?? true,
          fallbackOnlyOnce: tool.comboAuth.fallbackOnlyOnce ?? true,
          skipIfLoggedIn: tool.comboAuth.skipIfLoggedIn ?? true,
          triggerOnAuto: tool.comboAuth.triggerOnAuto ?? true,
          parallelSettings: {
            prepSessionFirst: tool.comboAuth.parallelSettings?.prepSessionFirst ?? true,
            parallelTimeout: tool.comboAuth.parallelSettings?.parallelTimeout ?? 30000,
            commitLock: tool.comboAuth.parallelSettings?.commitLock ?? true,
            verifyAfterAuth: tool.comboAuth.parallelSettings?.verifyAfterAuth ?? true
          },
          formConfig: {
            username: '', // Don't load sensitive data
            password: '',
            loginUrl: tool.comboAuth.formConfig?.loginUrl || '',
            multiStep: tool.comboAuth.formConfig?.multiStep || false,
            rememberMe: tool.comboAuth.formConfig?.rememberMe ?? true,
            submitDelay: tool.comboAuth.formConfig?.submitDelay || 800,
            autoSubmit: tool.comboAuth.formConfig?.autoSubmit ?? true
          },
          ssoConfig: {
            authStartUrl: tool.comboAuth.ssoConfig?.authStartUrl || '',
            postLoginUrl: tool.comboAuth.ssoConfig?.postLoginUrl || '',
            provider: tool.comboAuth.ssoConfig?.provider || '',
            buttonSelector: tool.comboAuth.ssoConfig?.buttonSelector || '',
            autoClick: tool.comboAuth.ssoConfig?.autoClick ?? true
          },
          cookiesConfig: {
            cookies: tool.comboAuth.cookiesConfig?.cookies || '',
            injectFirst: tool.comboAuth.cookiesConfig?.injectFirst ?? true
          },
          localStorageConfig: {
            data: tool.comboAuth.localStorageConfig?.data || ''
          },
          sessionStorageConfig: {
            data: tool.comboAuth.sessionStorageConfig?.data || ''
          }
        }));
      }

      // Load session bundle version if present
      if (tool.sessionBundle) {
        setSessionBundleVersion(tool.sessionBundle.version || null);
      }
      
      // Load selectors if present
      if (tool.credentials?.selectors) {
        setFormSelectors(prev => ({
          ...prev,
          ...tool.credentials.selectors
        }));
      }
      
      // Load success check if present
      if (tool.credentials?.successCheck) {
        setSuccessCheck(prev => ({
          ...prev,
          urlIncludes: tool.credentials.successCheck.urlIncludes || '',
          urlExcludes: tool.credentials.successCheck.urlExcludes || '',
          elementExists: tool.credentials.successCheck.elementExists || '',
          elementNotExists: tool.credentials.successCheck.elementNotExists || '',
          cookieNames: (tool.credentials.successCheck.cookieNames || []).join(', ')
        }));
      }
    } catch (error) {
      showError('Failed to load tool');
      navigate('/admin/tools');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.name.trim()) {
      showError('Tool name is required');
      return;
    }
    
    if (!formData.targetUrl.trim()) {
      showError('Target URL is required');
      return;
    }

    try {
      setSaving(true);
      
      // Determine if combo auth is being used
      const isComboMode = formData.credentialType === 'combo';
      const actualCredentialType = isComboMode ? comboAuth.primaryType : formData.credentialType;
      
      const payload = {
        name: formData.name.trim(),
        description: formData.description.trim(),
        targetUrl: formData.targetUrl.trim(),
        loginUrl: formData.loginUrl.trim() || formData.targetUrl.trim(),
        category: formData.category,
        credentialType: actualCredentialType,
        status: formData.status,
        extensionSettings: formData.extensionSettings
      };
      
      // Build combo auth object if enabled
      if (isComboMode) {
        payload.comboAuth = {
          enabled: true,
          runMode: comboAuth.runMode || 'sequential',
          primaryType: comboAuth.primaryType,
          secondaryType: comboAuth.secondaryType,
          fallbackEnabled: comboAuth.fallbackEnabled,
          fallbackOnlyOnce: comboAuth.fallbackOnlyOnce,
          skipIfLoggedIn: comboAuth.skipIfLoggedIn,
          triggerOnAuto: comboAuth.triggerOnAuto,
          // Parallel settings
          parallelSettings: {
            prepSessionFirst: comboAuth.parallelSettings?.prepSessionFirst ?? true,
            parallelTimeout: comboAuth.parallelSettings?.parallelTimeout ?? 30000,
            commitLock: comboAuth.parallelSettings?.commitLock ?? true,
            verifyAfterAuth: comboAuth.parallelSettings?.verifyAfterAuth ?? true
          },
          // Form config
          formConfig: {
            username: comboAuth.formConfig.username,
            password: comboAuth.formConfig.password,
            loginUrl: comboAuth.formConfig.loginUrl || formData.loginUrl,
            multiStep: comboAuth.formConfig.multiStep,
            rememberMe: comboAuth.formConfig.rememberMe,
            submitDelay: comboAuth.formConfig.submitDelay,
            autoSubmit: comboAuth.formConfig.autoSubmit !== false
          },
          // SSO config
          ssoConfig: {
            authStartUrl: comboAuth.ssoConfig.authStartUrl,
            postLoginUrl: comboAuth.ssoConfig.postLoginUrl || formData.targetUrl,
            provider: comboAuth.ssoConfig.provider,
            buttonSelector: comboAuth.ssoConfig.buttonSelector,
            autoClick: comboAuth.ssoConfig.autoClick
          },
          // Cookies config
          cookiesConfig: {
            cookies: comboAuth.cookiesConfig.cookies,
            injectFirst: comboAuth.cookiesConfig.injectFirst
          },
          // Token config
          tokenConfig: {
            token: comboAuth.tokenConfig.token,
            header: comboAuth.tokenConfig.header,
            prefix: comboAuth.tokenConfig.prefix,
            storageKey: comboAuth.tokenConfig.storageKey
          },
          // LocalStorage config
          localStorageConfig: {
            data: comboAuth.localStorageConfig.data
          },
          // SessionStorage config
          sessionStorageConfig: {
            data: comboAuth.sessionStorageConfig?.data || ''
          }
        };
      } else {
        payload.comboAuth = { enabled: false };
      }
      
      // Build unified credentials object
      const credentials = {
        type: actualCredentialType,
        payload: {},
        selectors: {},
        successCheck: {}
      };
      
      // Build selectors
      const cleanedSelectors = {};
      Object.entries(formSelectors).forEach(([key, value]) => {
        if (value && value.trim()) {
          cleanedSelectors[key] = value.trim();
        }
      });
      if (Object.keys(cleanedSelectors).length > 0) {
        credentials.selectors = cleanedSelectors;
      }
      
      // Build success check
      const cleanedSuccessCheck = {};
      if (successCheck.urlIncludes?.trim()) {
        cleanedSuccessCheck.urlIncludes = successCheck.urlIncludes.trim();
      }
      if (successCheck.urlExcludes?.trim()) {
        cleanedSuccessCheck.urlExcludes = successCheck.urlExcludes.trim();
      }
      if (successCheck.elementExists?.trim()) {
        cleanedSuccessCheck.elementExists = successCheck.elementExists.trim();
      }
      if (successCheck.elementNotExists?.trim()) {
        cleanedSuccessCheck.elementNotExists = successCheck.elementNotExists.trim();
      }
      if (successCheck.cookieNames?.trim()) {
        cleanedSuccessCheck.cookieNames = successCheck.cookieNames.split(',').map(s => s.trim()).filter(Boolean);
      }
      if (Object.keys(cleanedSuccessCheck).length > 0) {
        credentials.successCheck = cleanedSuccessCheck;
      }
      
      // Handle credential type specific data (for non-combo mode)
      if (!isComboMode) {
        switch (formData.credentialType) {
          case 'form':
            if (formLoginData.username || formLoginData.password) {
              credentials.payload = {
                username: formLoginData.username,
                password: formLoginData.password,
                loginUrl: formLoginData.loginUrl || formData.loginUrl,
                multiStep: formOptions.multiStep,
                autoSubmit: formOptions.autoSubmit !== false  // Auto-submit like SSO auto-click
              };
              // Include form options
              credentials.formOptions = {
                multiStep: formOptions.multiStep,
                rememberMe: formOptions.rememberMe,
                autoSubmit: formOptions.autoSubmit !== false
              };
            }
            break;
            
          case 'sso':
            if (ssoData.authStartUrl) {
              credentials.payload = {
                authStartUrl: ssoData.authStartUrl,
                postLoginUrl: ssoData.postLoginUrl || formData.targetUrl,
                provider: ssoData.provider,
                buttonSelector: ssoData.buttonSelector,
                autoClick: ssoData.autoClick
              };
            }
            break;
            
          case 'headers':
            const validHeaders = headersData.filter(h => h.name && h.value);
            if (validHeaders.length > 0) {
              credentials.payload = { headers: validHeaders };
            }
            break;
            
          case 'cookies':
            if (formData.cookiesEncrypted.trim()) {
              payload.cookiesEncrypted = formData.cookiesEncrypted.trim();
            }
            break;
            
          case 'token':
            payload.tokenHeader = formData.tokenHeader;
            payload.tokenPrefix = formData.tokenPrefix;
            if (formData.tokenEncrypted.trim()) {
              payload.tokenEncrypted = formData.tokenEncrypted.trim();
            }
            break;
            
          case 'localStorage':
          case 'sessionStorage':
            if (formData.localStorageEncrypted.trim()) {
              payload.localStorageEncrypted = formData.localStorageEncrypted.trim();
            }
            break;
        }
      }
      
      // Add credentials to payload if it has meaningful data
      if (credentials.payload && Object.keys(credentials.payload).length > 0 ||
          credentials.selectors && Object.keys(credentials.selectors).length > 0 ||
          credentials.successCheck && Object.keys(credentials.successCheck).length > 0) {
        payload.credentials = credentials;
      }

      if (isEdit) {
        await api.put(`/admin/tools/${id}`, payload);
        showSuccess('Tool updated successfully');
      } else {
        await api.post('/admin/tools', payload);
        showSuccess('Tool created successfully');
      }
      
      navigate('/admin/tools');
    } catch (error) {
      console.error('Save tool error:', error);
      const errorMessage = error.response?.data?.details 
        ? error.response.data.details.map(d => d.message || d).join(', ')
        : error.response?.data?.error || 'Failed to save tool';
      showError(errorMessage);
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    
    if (name.startsWith('extensionSettings.')) {
      const settingName = name.split('.')[1];
      setFormData(prev => ({
        ...prev,
        extensionSettings: {
          ...prev.extensionSettings,
          [settingName]: type === 'checkbox' ? checked : (type === 'number' ? parseInt(value) : value)
        }
      }));
    } else {
      setFormData(prev => ({ ...prev, [name]: value }));
    }
  };

  // Render config panel for each combo auth type
  const renderComboTypeConfig = (type, role) => {
    const isHighlighted = role === 'primary' ? 'purple' : 'green';
    
    // Helper to safely get config with defaults
    const getSsoConfig = () => comboAuth.ssoConfig || { authStartUrl: '', postLoginUrl: '', provider: '', buttonSelector: '', autoClick: true };
    const getFormConfig = () => comboAuth.formConfig || { username: '', password: '', loginUrl: '', multiStep: false, rememberMe: true, submitDelay: 800, autoSubmit: true };
    const getCookiesConfig = () => comboAuth.cookiesConfig || { cookies: '', injectFirst: true };
    const getTokenConfig = () => comboAuth.tokenConfig || { token: '', header: 'Authorization', prefix: 'Bearer ', storageKey: 'access_token' };
    const getLocalStorageConfig = () => comboAuth.localStorageConfig || { data: '' };
    
    switch (type) {
      case 'sso':
        const ssoConfig = getSsoConfig();
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-genz-navy mb-2">Auth Start URL</label>
                <input
                  type="url"
                  value={ssoConfig.authStartUrl || ''}
                  onChange={(e) => setComboAuth(prev => ({ ...prev, ssoConfig: { ...getSsoConfig(), authStartUrl: e.target.value }}))}
                  className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none focus:border-purple-500"
                  placeholder="https://example.com/auth/sso"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-genz-navy mb-2">Post-Login URL</label>
                <input
                  type="url"
                  value={ssoConfig.postLoginUrl || ''}
                  onChange={(e) => setComboAuth(prev => ({ ...prev, ssoConfig: { ...getSsoConfig(), postLoginUrl: e.target.value }}))}
                  className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none focus:border-purple-500"
                  placeholder="https://example.com/dashboard"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-genz-navy mb-2">SSO Provider</label>
                <select
                  value={ssoConfig.provider || ''}
                  onChange={(e) => setComboAuth(prev => ({ ...prev, ssoConfig: { ...getSsoConfig(), provider: e.target.value }}))}
                  className="w-full px-3 py-2 bg-[#FFFFFF] border border-genz-border rounded-lg text-genz-navy focus:outline-none"
                >
                  <option value="">Auto-detect</option>
                  <option value="google">Google</option>
                  <option value="microsoft">Microsoft / Azure AD</option>
                  <option value="github">GitHub</option>
                  <option value="okta">Okta</option>
                  <option value="saml">SAML / Enterprise</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-genz-navy mb-2">Button Selector</label>
                <input
                  type="text"
                  value={ssoConfig.buttonSelector || ''}
                  onChange={(e) => setComboAuth(prev => ({ ...prev, ssoConfig: { ...getSsoConfig(), buttonSelector: e.target.value }}))}
                  className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none"
                  placeholder='button[data-provider="google"]'
                />
              </div>
            </div>
            <label className="flex items-center gap-3 p-3 bg-green-500/10 border border-green-500/30 rounded-lg cursor-pointer hover:bg-green-500/20">
              <input
                type="checkbox"
                checked={ssoConfig.autoClick !== false}
                onChange={(e) => setComboAuth(prev => ({ ...prev, ssoConfig: { ...getSsoConfig(), autoClick: e.target.checked }}))}
                className="w-5 h-5 rounded border-genz-border text-green-500 focus:ring-green-500"
              />
              <div>
                <div className="font-medium text-genz-navy text-sm">Auto-Click SSO Button</div>
                <div className="text-xs text-green-600">Automatically click when ?auto=1</div>
              </div>
            </label>
          </div>
        );
        
      case 'form':
        const formConfig = getFormConfig();
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-genz-navy mb-2">Username / Email</label>
                <input
                  type="text"
                  value={formConfig.username || ''}
                  onChange={(e) => setComboAuth(prev => ({ ...prev, formConfig: { ...getFormConfig(), username: e.target.value }}))}
                  className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none"
                  placeholder="user@example.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-genz-navy mb-2">Password</label>
                <input
                  type="password"
                  value={formConfig.password || ''}
                  onChange={(e) => setComboAuth(prev => ({ ...prev, formConfig: { ...getFormConfig(), password: e.target.value }}))}
                  className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none"
                  placeholder="••••••••"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-genz-navy mb-2">Login URL (optional)</label>
              <input
                type="url"
                value={formConfig.loginUrl || ''}
                onChange={(e) => setComboAuth(prev => ({ ...prev, formConfig: { ...getFormConfig(), loginUrl: e.target.value }}))}
                className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none"
                placeholder="https://example.com/login"
              />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <label className="flex items-center gap-3 p-3 bg-green-500/10 border border-green-500/30 rounded-lg cursor-pointer hover:bg-green-500/20">
                <input
                  type="checkbox"
                  checked={formConfig.autoSubmit !== false}
                  onChange={(e) => setComboAuth(prev => ({ ...prev, formConfig: { ...getFormConfig(), autoSubmit: e.target.checked }}))}
                  className="w-5 h-5 rounded border-genz-border text-green-500 focus:ring-green-500"
                />
                <div>
                  <div className="font-medium text-genz-navy text-sm">Auto-Submit</div>
                  <div className="text-xs text-green-600">Like SSO auto-click</div>
                </div>
              </label>
              <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-lg cursor-pointer hover:bg-genz-bg">
                <input
                  type="checkbox"
                  checked={formConfig.multiStep || false}
                  onChange={(e) => setComboAuth(prev => ({ ...prev, formConfig: { ...getFormConfig(), multiStep: e.target.checked }}))}
                  className="w-5 h-5 rounded border-genz-border text-purple-500 focus:ring-purple-500"
                />
                <div>
                  <div className="font-medium text-genz-navy text-sm">Multi-Step</div>
                  <div className="text-xs text-genz-muted">Email → Next → Pass</div>
                </div>
              </label>
              <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-lg cursor-pointer hover:bg-genz-bg">
                <input
                  type="checkbox"
                  checked={formConfig.rememberMe !== false}
                  onChange={(e) => setComboAuth(prev => ({ ...prev, formConfig: { ...getFormConfig(), rememberMe: e.target.checked }}))}
                  className="w-5 h-5 rounded border-genz-border text-purple-500 focus:ring-purple-500"
                />
                <div>
                  <div className="font-medium text-genz-navy text-sm">Remember</div>
                  <div className="text-xs text-genz-muted">Check if avail</div>
                </div>
              </label>
              <div>
                <label className="block text-xs text-genz-muted mb-1">Delay (ms)</label>
                <input
                  type="number"
                  min="0"
                  max="5000"
                  step="100"
                  value={formConfig.submitDelay || 800}
                  onChange={(e) => setComboAuth(prev => ({ ...prev, formConfig: { ...getFormConfig(), submitDelay: parseInt(e.target.value) || 800 }}))}
                  className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy focus:outline-none"
                />
              </div>
            </div>
          </div>
        );
        
      case 'cookies':
        const cookiesConfig = getCookiesConfig();
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-genz-navy mb-2">Cookies JSON</label>
              <textarea
                value={cookiesConfig.cookies || ''}
                onChange={(e) => setComboAuth(prev => ({ ...prev, cookiesConfig: { ...getCookiesConfig(), cookies: e.target.value }}))}
                rows={5}
                className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none font-mono text-sm"
                placeholder='[{"name": "session", "value": "abc123", "domain": ".example.com"}]'
              />
              <p className="mt-1 text-xs text-genz-muted">Paste cookies as JSON array. Export from DevTools.</p>
            </div>
            <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-lg cursor-pointer hover:bg-genz-bg">
              <input
                type="checkbox"
                checked={cookiesConfig.injectFirst !== false}
                onChange={(e) => setComboAuth(prev => ({ ...prev, cookiesConfig: { ...getCookiesConfig(), injectFirst: e.target.checked }}))}
                className="w-5 h-5 rounded border-genz-border text-purple-500 focus:ring-purple-500"
              />
              <div>
                <div className="font-medium text-genz-navy text-sm">Inject Cookies First</div>
                <div className="text-xs text-genz-muted">Inject cookies before trying other auth</div>
              </div>
            </label>
          </div>
        );
        
      case 'token':
        const tokenConfig = getTokenConfig();
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-genz-navy mb-2">Header Name</label>
                <input
                  type="text"
                  value={tokenConfig.header || 'Authorization'}
                  onChange={(e) => setComboAuth(prev => ({ ...prev, tokenConfig: { ...getTokenConfig(), header: e.target.value }}))}
                  className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy"
                  placeholder="Authorization"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-genz-navy mb-2">Prefix</label>
                <input
                  type="text"
                  value={tokenConfig.prefix || 'Bearer '}
                  onChange={(e) => setComboAuth(prev => ({ ...prev, tokenConfig: { ...getTokenConfig(), prefix: e.target.value }}))}
                  className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy"
                  placeholder="Bearer "
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-genz-navy mb-2">Storage Key</label>
                <input
                  type="text"
                  value={tokenConfig.storageKey || 'access_token'}
                  onChange={(e) => setComboAuth(prev => ({ ...prev, tokenConfig: { ...getTokenConfig(), storageKey: e.target.value }}))}
                  className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy"
                  placeholder="access_token"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-genz-navy mb-2">Token Value</label>
              <input
                type="password"
                value={tokenConfig.token || ''}
                onChange={(e) => setComboAuth(prev => ({ ...prev, tokenConfig: { ...getTokenConfig(), token: e.target.value }}))}
                className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted font-mono"
                placeholder="Enter token value..."
              />
            </div>
          </div>
        );
        
      case 'headers':
        return (
          <div className="space-y-4">
            <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <p className="text-sm text-yellow-200">
                <strong>Note:</strong> MV3 extensions cannot modify request headers. Headers will be converted to cookies/storage where possible.
              </p>
            </div>
            <p className="text-sm text-genz-muted">Configure custom headers (limited support in MV3)</p>
          </div>
        );
        
      case 'localStorage':
        const localStorageConfig = getLocalStorageConfig();
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-genz-navy mb-2">LocalStorage Data (JSON)</label>
              <textarea
                value={localStorageConfig.data || ''}
                onChange={(e) => setComboAuth(prev => ({ ...prev, localStorageConfig: { ...getLocalStorageConfig(), data: e.target.value }}))}
                rows={5}
                className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none font-mono text-sm"
                placeholder='{"key1": "value1", "token": "abc123"}'
              />
              <p className="mt-1 text-xs text-genz-muted">JSON object with key-value pairs to inject into localStorage</p>
            </div>
          </div>
        );

      case 'sessionStorage':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-genz-navy mb-2">SessionStorage Data (JSON)</label>
              <textarea
                value={comboAuth.sessionStorageConfig?.data || ''}
                onChange={(e) => setComboAuth(prev => ({ ...prev, sessionStorageConfig: { ...prev.sessionStorageConfig, data: e.target.value }}))}
                rows={5}
                className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none font-mono text-sm"
                placeholder='{"sessionKey": "sessionValue", "tempToken": "xyz789"}'
              />
              <p className="mt-1 text-xs text-genz-muted">JSON object with key-value pairs to inject into sessionStorage (cleared on tab close)</p>
            </div>
          </div>
        );
        
      default:
        return <p className="text-genz-muted">Select an auth type to configure</p>;
    }
  };

  if (loading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center min-h-[80vh]">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-genz-teal border-t-transparent"></div>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <button
            onClick={() => navigate('/admin/tools')}
            className="flex items-center gap-2 text-genz-muted hover:text-genz-navy transition-colors mb-4"
          >
            <ArrowLeft size={20} />
            Back to Tools
          </button>
          <h1 className="text-3xl font-bold text-genz-navy">
            {isEdit ? 'Edit Tool' : 'Create Tool'}
          </h1>
          <p className="text-genz-muted mt-1">Configure tool details and credentials for Chrome Extension</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Info Card */}
          <div className="bg-white border border-genz-border rounded-xl p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-genz-navy mb-6">
              <Package size={20} className="text-genz-teal" />
              Basic Information
            </h2>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Name */}
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-genz-navy mb-2">
                  Tool Name *
                </label>
                <input
                  type="text"
                  id="name"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  required
                  className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                  placeholder="e.g., ChatGPT Premium"
                  data-testid="tool-name-input"
                />
              </div>

              {/* Category */}
              <div>
                <label htmlFor="category" className="block text-sm font-medium text-genz-navy mb-2">
                  Category
                </label>
                <select
                  id="category"
                  name="category"
                  value={formData.category}
                  onChange={handleChange}
                  className="w-full px-4 py-3 bg-[#FFFFFF] border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal transition-colors appearance-none cursor-pointer"
                  style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 1rem center', backgroundSize: '0.75rem' }}
                  data-testid="tool-category-select"
                >
                  {CATEGORIES.map(cat => (
                    <option key={cat} value={cat} className="bg-[#FFFFFF] text-genz-navy">{cat}</option>
                  ))}
                </select>
              </div>

              {/* Target URL */}
              <div className="md:col-span-2">
                <label htmlFor="targetUrl" className="flex items-center gap-2 text-sm font-medium text-genz-navy mb-2">
                  <LinkIcon size={16} className="text-genz-teal" />
                  Target URL *
                </label>
                <input
                  type="url"
                  id="targetUrl"
                  name="targetUrl"
                  value={formData.targetUrl}
                  onChange={handleChange}
                  required
                  className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                  placeholder="https://example.com"
                  data-testid="tool-url-input"
                />
                <p className="mt-1 text-xs text-genz-muted">Main URL to open after login</p>
              </div>
              
              {/* Login URL */}
              <div className="md:col-span-2">
                <label htmlFor="loginUrl" className="flex items-center gap-2 text-sm font-medium text-genz-navy mb-2">
                  <LogIn size={16} className="text-genz-teal" />
                  Login URL (Optional)
                </label>
                <input
                  type="url"
                  id="loginUrl"
                  name="loginUrl"
                  value={formData.loginUrl}
                  onChange={handleChange}
                  className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                  placeholder="https://example.com/login (defaults to Target URL)"
                  data-testid="tool-login-url-input"
                />
                <p className="mt-1 text-xs text-genz-muted">If login page is different from target URL</p>
              </div>

              {/* Description */}
              <div className="md:col-span-2">
                <label htmlFor="description" className="flex items-center gap-2 text-sm font-medium text-genz-navy mb-2">
                  <FileText size={16} className="text-genz-teal" />
                  Description
                </label>
                <textarea
                  id="description"
                  name="description"
                  value={formData.description}
                  onChange={handleChange}
                  rows={2}
                  className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors resize-none"
                  placeholder="Brief description of the tool..."
                  data-testid="tool-description-input"
                />
              </div>
            </div>
          </div>

          {/* Credential Type Card */}
          <div className="bg-white border border-genz-border rounded-xl p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-genz-navy mb-6">
              <Key size={20} className="text-genz-teal" />
              Authentication Type
            </h2>
            
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
              {CREDENTIAL_TYPES.map(type => (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => setFormData(prev => ({ ...prev, credentialType: type.value }))}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    formData.credentialType === type.value
                      ? type.isCombo 
                        ? 'border-purple-500 bg-purple-500/20 ring-2 ring-purple-500/50'
                        : 'border-genz-teal bg-genz-teal/10'
                      : 'border-genz-border bg-genz-bg hover:border-genz-teal/50'
                  }`}
                  data-testid={`credential-type-${type.value}`}
                >
                  <div className="text-2xl mb-1">{type.icon}</div>
                  <div className="font-medium text-genz-navy text-xs">{type.label}</div>
                  <div className="text-xs text-genz-muted mt-0.5 line-clamp-2">{type.hint}</div>
                </button>
              ))}
            </div>

            {/* UNIVERSAL COMBO AUTH MODE */}
            {formData.credentialType === 'combo' && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 p-3 bg-purple-500/10 border border-purple-500/30 rounded-xl mb-4">
                  <Zap size={18} className="text-purple-500" />
                  <span className="font-medium text-genz-navy">Universal Combo Auth</span>
                  <span className="text-sm text-purple-600 ml-2">Configure auth strategies</span>
                </div>

                {/* Run Mode Selection */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-genz-navy mb-2">
                    Run Mode
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setComboAuth(prev => ({ ...prev, runMode: 'sequential' }))}
                      className={`p-3 rounded-xl border text-left transition-all ${
                        comboAuth.runMode === 'sequential'
                          ? 'border-blue-500 bg-blue-500/20 ring-2 ring-blue-500/50'
                          : 'border-genz-border bg-genz-bg hover:border-blue-500/50'
                      }`}
                    >
                      <div className="text-lg mb-1">🔄</div>
                      <div className="font-medium text-genz-navy text-sm">Sequential</div>
                      <div className="text-xs text-genz-muted">Primary → Fallback (if fails)</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setComboAuth(prev => ({ ...prev, runMode: 'parallel' }))}
                      className={`p-3 rounded-xl border text-left transition-all ${
                        comboAuth.runMode === 'parallel'
                          ? 'border-green-500 bg-green-500/20 ring-2 ring-green-500/50'
                          : 'border-genz-border bg-genz-bg hover:border-green-500/50'
                      }`}
                    >
                      <div className="text-lg mb-1">⚡</div>
                      <div className="font-medium text-genz-navy text-sm">Parallel / Simultaneous</div>
                      <div className="text-xs text-genz-muted">Apply all session data at once</div>
                    </button>
                  </div>
                </div>

                {/* ==================== SEQUENTIAL MODE ==================== */}
                {comboAuth.runMode === 'sequential' && (
                  <>
                    {/* Sequential Mode Info */}
                    <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-xl mb-4">
                      <div className="text-sm text-blue-200 mb-1 font-medium">🔄 Sequential Mode:</div>
                      <div className="text-xs text-blue-600">Try Primary auth first → If fails, try Fallback</div>
                    </div>
                
                    {/* Type Selection for Sequential */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                      <div>
                        <label className="block text-sm font-medium text-genz-navy mb-2">
                          Primary Auth Type <span className="text-purple-500">(Try First)</span>
                        </label>
                        <select
                          value={comboAuth.primaryType}
                          onChange={(e) => setComboAuth(prev => ({ ...prev, primaryType: e.target.value }))}
                          className="w-full px-3 py-2 bg-[#FFFFFF] border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:border-purple-500"
                        >
                          {COMBO_AUTH_TYPES.map(type => (
                            <option key={type.value} value={type.value}>
                              {type.icon} {type.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      
                      <div>
                        <label className="block text-sm font-medium text-genz-navy mb-2">
                          Fallback Auth Type <span className="text-green-500">(If Primary Fails)</span>
                        </label>
                        <select
                          value={comboAuth.secondaryType}
                          onChange={(e) => setComboAuth(prev => ({ ...prev, secondaryType: e.target.value }))}
                          className="w-full px-3 py-2 bg-[#FFFFFF] border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:border-purple-500"
                        >
                          {COMBO_AUTH_TYPES.filter(t => t.value !== comboAuth.primaryType).map(type => (
                            <option key={type.value} value={type.value}>
                              {type.icon} {type.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    
                    {/* Strategy Controls for Sequential */}
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
                      <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-xl cursor-pointer hover:bg-genz-bg">
                        <input
                          type="checkbox"
                          checked={comboAuth.skipIfLoggedIn}
                          onChange={(e) => setComboAuth(prev => ({ ...prev, skipIfLoggedIn: e.target.checked }))}
                          className="w-5 h-5 rounded border-genz-border text-green-500 focus:ring-green-500"
                        />
                        <div>
                          <div className="font-medium text-genz-navy text-sm">Skip if Logged In</div>
                          <div className="text-xs text-genz-muted">Check first</div>
                        </div>
                      </label>

                      <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-xl cursor-pointer hover:bg-genz-bg">
                        <input
                          type="checkbox"
                          checked={comboAuth.fallbackEnabled}
                          onChange={(e) => setComboAuth(prev => ({ ...prev, fallbackEnabled: e.target.checked }))}
                          className="w-5 h-5 rounded border-genz-border text-purple-500 focus:ring-purple-500"
                        />
                        <div>
                          <div className="font-medium text-genz-navy text-sm">Fallback Enabled</div>
                          <div className="text-xs text-genz-muted">Try secondary</div>
                        </div>
                      </label>
                      
                      <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-xl cursor-pointer hover:bg-genz-bg">
                        <input
                          type="checkbox"
                          checked={comboAuth.triggerOnAuto}
                          onChange={(e) => setComboAuth(prev => ({ ...prev, triggerOnAuto: e.target.checked }))}
                          className="w-5 h-5 rounded border-genz-border text-purple-500 focus:ring-purple-500"
                        />
                        <div>
                          <div className="font-medium text-genz-navy text-sm">Auto Only</div>
                          <div className="text-xs text-genz-muted">?auto=1</div>
                        </div>
                      </label>
                    </div>
                    
                    {/* Tabbed Interface for Sequential */}
                    <div className="border border-genz-border rounded-xl overflow-hidden">
                      <div className="flex border-b border-genz-border">
                        <button
                          type="button"
                          onClick={() => setComboAuthTab('primary')}
                          className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                            comboAuthTab === 'primary'
                              ? 'bg-purple-500/20 text-purple-600 border-b-2 border-purple-500'
                              : 'text-genz-muted hover:text-genz-navy hover:bg-genz-bg'
                          }`}
                        >
                          {COMBO_AUTH_TYPES.find(t => t.value === comboAuth.primaryType)?.icon} {COMBO_AUTH_TYPES.find(t => t.value === comboAuth.primaryType)?.label} (Primary)
                        </button>
                        <button
                          type="button"
                          onClick={() => setComboAuthTab('secondary')}
                          className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                            comboAuthTab === 'secondary'
                              ? 'bg-green-500/20 text-green-600 border-b-2 border-green-500'
                              : 'text-genz-muted hover:text-genz-navy hover:bg-genz-bg'
                          }`}
                        >
                          {COMBO_AUTH_TYPES.find(t => t.value === comboAuth.secondaryType)?.icon} {COMBO_AUTH_TYPES.find(t => t.value === comboAuth.secondaryType)?.label} (Fallback)
                        </button>
                      </div>
                      
                      <div className="p-4">
                        {comboAuthTab === 'primary' && renderComboTypeConfig(comboAuth.primaryType, 'primary')}
                        {comboAuthTab === 'secondary' && renderComboTypeConfig(comboAuth.secondaryType, 'secondary')}
                      </div>
                    </div>
                  </>
                )}

                {/* ==================== PARALLEL MODE ==================== */}
                {comboAuth.runMode === 'parallel' && (
                  <>
                    {/* Parallel Mode Info */}
                    <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-xl mb-4">
                      <div className="text-sm text-green-200 mb-2 font-medium">⚡ Parallel / Simultaneous Mode:</div>
                      <ul className="text-xs text-green-600 space-y-1">
                        <li>• All session data (Cookies + LocalStorage + SessionStorage) applied <strong>simultaneously</strong></li>
                        <li>• Then auth method (SSO or Form) runs to verify/complete login</li>
                        <li>• Best for tools that need all session data injected at once</li>
                      </ul>
                    </div>

                    {/* Parallel Options */}
                    <div className="grid grid-cols-2 gap-3 mb-4">
                      <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-xl cursor-pointer hover:bg-genz-bg">
                        <input
                          type="checkbox"
                          checked={comboAuth.skipIfLoggedIn}
                          onChange={(e) => setComboAuth(prev => ({ ...prev, skipIfLoggedIn: e.target.checked }))}
                          className="w-5 h-5 rounded border-genz-border text-green-500 focus:ring-green-500"
                        />
                        <div>
                          <div className="font-medium text-genz-navy text-sm">Skip if Already Logged In</div>
                          <div className="text-xs text-genz-muted">Check login status first</div>
                        </div>
                      </label>
                      
                      <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-xl cursor-pointer hover:bg-genz-bg">
                        <input
                          type="checkbox"
                          checked={comboAuth.triggerOnAuto}
                          onChange={(e) => setComboAuth(prev => ({ ...prev, triggerOnAuto: e.target.checked }))}
                          className="w-5 h-5 rounded border-genz-border text-green-500 focus:ring-green-500"
                        />
                        <div>
                          <div className="font-medium text-genz-navy text-sm">Auto Trigger Only</div>
                          <div className="text-xs text-genz-muted">Only when ?auto=1 in URL</div>
                        </div>
                      </label>
                    </div>

                    {/* Auth Method for Parallel (optional, after session injection) */}
                    <div className="mb-4">
                      <label className="block text-sm font-medium text-genz-navy mb-2">
                        Auth Method <span className="text-genz-muted text-xs">(After session injection)</span>
                      </label>
                      <select
                        value={comboAuth.primaryType}
                        onChange={(e) => setComboAuth(prev => ({ ...prev, primaryType: e.target.value }))}
                        className="w-full px-3 py-2 bg-[#FFFFFF] border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:border-green-500"
                      >
                        <option value="none">🔓 None (Session Only)</option>
                        <option value="sso">🔐 SSO / OAuth</option>
                        <option value="form">📝 Form Login</option>
                      </select>
                      <p className="text-xs text-genz-muted mt-1">Select auth method to run after injecting session bundle, or "None" for session-only login</p>
                    </div>

                    {/* Master Session Bundle */}
                    <div className="border border-green-500/30 rounded-xl overflow-hidden">
                      <div className="bg-green-500/10 px-4 py-3 border-b border-green-500/30">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-lg">📦</span>
                            <span className="font-medium text-genz-navy">Master Session Bundle</span>
                            {sessionBundleVersion && (
                              <span className="text-xs bg-green-500/30 text-green-600 px-2 py-0.5 rounded-full">
                                v{sessionBundleVersion}
                              </span>
                            )}
                          </div>
                        </div>
                        <p className="text-xs text-green-600 mt-1">All data below will be applied simultaneously to the browser</p>
                      </div>
                      
                      <div className="p-4 space-y-4">
                        {/* Cookies */}
                        <div>
                          <label className="flex items-center gap-2 text-sm font-medium text-genz-navy mb-2">
                            🍪 Cookies <span className="text-xs text-genz-muted">(JSON Array)</span>
                          </label>
                          <textarea
                            value={comboAuth.cookiesConfig?.cookies || ''}
                            onChange={(e) => setComboAuth(prev => ({
                              ...prev,
                              cookiesConfig: { ...prev.cookiesConfig, cookies: e.target.value }
                            }))}
                            className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-green-500 transition-colors font-mono text-sm"
                            rows={4}
                            placeholder='[{"name": "session", "value": "abc123", "domain": ".example.com"}]'
                          />
                        </div>

                        {/* LocalStorage */}
                        <div>
                          <label className="flex items-center gap-2 text-sm font-medium text-genz-navy mb-2">
                            💾 LocalStorage <span className="text-xs text-genz-muted">(JSON Object)</span>
                          </label>
                          <textarea
                            value={comboAuth.localStorageConfig?.data || ''}
                            onChange={(e) => setComboAuth(prev => ({
                              ...prev,
                              localStorageConfig: { ...prev.localStorageConfig, data: e.target.value }
                            }))}
                            className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-green-500 transition-colors font-mono text-sm"
                            rows={4}
                            placeholder='{"token": "eyJ...", "user": "{\"id\": 123}"}'
                          />
                        </div>

                        {/* SessionStorage */}
                        <div>
                          <label className="flex items-center gap-2 text-sm font-medium text-genz-navy mb-2">
                            📦 SessionStorage <span className="text-xs text-genz-muted">(JSON Object)</span>
                          </label>
                          <textarea
                            value={comboAuth.sessionStorageConfig?.data || ''}
                            onChange={(e) => setComboAuth(prev => ({
                              ...prev,
                              sessionStorageConfig: { ...prev.sessionStorageConfig, data: e.target.value }
                            }))}
                            className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-green-500 transition-colors font-mono text-sm"
                            rows={4}
                            placeholder='{"tempState": "value", "sessionId": "xyz789"}'
                          />
                        </div>

                        {/* Auth Method Config (if SSO or Form selected) */}
                        {comboAuth.primaryType === 'sso' && (
                          <div className="border-t border-genz-border pt-4">
                            <label className="flex items-center gap-2 text-sm font-medium text-genz-navy mb-3">
                              🔐 SSO Configuration
                            </label>
                            <div className="space-y-3">
                              <input
                                type="url"
                                value={comboAuth.ssoConfig?.authStartUrl || ''}
                                onChange={(e) => setComboAuth(prev => ({
                                  ...prev,
                                  ssoConfig: { ...prev.ssoConfig, authStartUrl: e.target.value }
                                }))}
                                className="w-full px-4 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none focus:border-green-500"
                                placeholder="SSO Start URL"
                              />
                              <input
                                type="text"
                                value={comboAuth.ssoConfig?.buttonSelector || ''}
                                onChange={(e) => setComboAuth(prev => ({
                                  ...prev,
                                  ssoConfig: { ...prev.ssoConfig, buttonSelector: e.target.value }
                                }))}
                                className="w-full px-4 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none focus:border-green-500"
                                placeholder="SSO Button Selector (e.g., .google-login-btn)"
                              />
                            </div>
                          </div>
                        )}

                        {comboAuth.primaryType === 'form' && (
                          <div className="border-t border-genz-border pt-4">
                            <label className="flex items-center gap-2 text-sm font-medium text-genz-navy mb-3">
                              📝 Form Login Configuration
                            </label>
                            <div className="grid grid-cols-2 gap-3">
                              <input
                                type="text"
                                value={comboAuth.formConfig?.username || ''}
                                onChange={(e) => setComboAuth(prev => ({
                                  ...prev,
                                  formConfig: { ...prev.formConfig, username: e.target.value }
                                }))}
                                className="w-full px-4 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none focus:border-green-500"
                                placeholder="Username"
                              />
                              <input
                                type="password"
                                value={comboAuth.formConfig?.password || ''}
                                onChange={(e) => setComboAuth(prev => ({
                                  ...prev,
                                  formConfig: { ...prev.formConfig, password: e.target.value }
                                }))}
                                className="w-full px-4 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none focus:border-green-500"
                                placeholder="Password"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Form Login Fields */}
            {formData.credentialType === 'form' && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 mb-4">
                  <LogIn size={18} className="text-genz-teal" />
                  <span className="font-medium text-genz-navy">Form Login Configuration</span>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-genz-navy mb-2">
                      Username / Email
                    </label>
                    <input
                      type="text"
                      value={formLoginData.username}
                      onChange={(e) => setFormLoginData(prev => ({ ...prev, username: e.target.value }))}
                      className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                      placeholder="user@example.com"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-genz-navy mb-2">
                      Password
                    </label>
                    <input
                      type="password"
                      value={formLoginData.password}
                      onChange={(e) => setFormLoginData(prev => ({ ...prev, password: e.target.value }))}
                      className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                      placeholder="••••••••"
                    />
                  </div>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-genz-navy mb-2">
                    Login URL (optional)
                  </label>
                  <input
                    type="url"
                    value={formLoginData.loginUrl}
                    onChange={(e) => setFormLoginData(prev => ({ ...prev, loginUrl: e.target.value }))}
                    className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                    placeholder="https://example.com/login (defaults to Target URL)"
                  />
                </div>
                
                {/* Form Options */}
                <div className="border-t border-genz-border pt-4 mt-4">
                  <div className="flex items-center gap-2 mb-4">
                    <Settings size={16} className="text-blue-500" />
                    <span className="text-sm font-medium text-genz-navy">Form Login Options</span>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-xl cursor-pointer hover:bg-genz-bg transition-colors">
                      <input
                        type="checkbox"
                        checked={formOptions.autoSubmit}
                        onChange={(e) => setFormOptions(prev => ({ ...prev, autoSubmit: e.target.checked }))}
                        className="w-5 h-5 rounded border-genz-border text-green-500 focus:ring-green-500"
                      />
                      <div>
                        <div className="font-medium text-genz-navy text-sm">Auto-Submit Form</div>
                        <div className="text-xs text-genz-muted">Auto-submit when ?auto=1 (like SSO)</div>
                      </div>
                    </label>
                    
                    <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-xl cursor-pointer hover:bg-genz-bg transition-colors">
                      <input
                        type="checkbox"
                        checked={formOptions.multiStep}
                        onChange={(e) => setFormOptions(prev => ({ ...prev, multiStep: e.target.checked }))}
                        className="w-5 h-5 rounded border-genz-border text-genz-teal focus:ring-genz-teal"
                      />
                      <div>
                        <div className="font-medium text-genz-navy text-sm">Multi-Step Login</div>
                        <div className="text-xs text-genz-muted">Email first, then password (Google/Microsoft style)</div>
                      </div>
                    </label>
                    
                    <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-xl cursor-pointer hover:bg-genz-bg transition-colors">
                      <input
                        type="checkbox"
                        checked={formOptions.rememberMe}
                        onChange={(e) => setFormOptions(prev => ({ ...prev, rememberMe: e.target.checked }))}
                        className="w-5 h-5 rounded border-genz-border text-genz-teal focus:ring-genz-teal"
                      />
                      <div>
                        <div className="font-medium text-genz-navy text-sm">Remember Me</div>
                        <div className="text-xs text-genz-muted">Check "remember me" if available</div>
                      </div>
                    </label>
                  </div>
                </div>
                
                {/* MFA Handling */}
                <div className="border-t border-genz-border pt-4 mt-4">
                  <div className="flex items-center gap-2 mb-4">
                    <Shield size={16} className="text-yellow-500" />
                    <span className="text-sm font-medium text-genz-navy">MFA / 2FA Handling</span>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-xl cursor-pointer hover:bg-genz-bg transition-colors">
                      <input
                        type="checkbox"
                        checked={mfaOptions.detectMFA}
                        onChange={(e) => setMfaOptions(prev => ({ ...prev, detectMFA: e.target.checked }))}
                        className="w-5 h-5 rounded border-genz-border text-genz-teal focus:ring-genz-teal"
                      />
                      <div>
                        <div className="font-medium text-genz-navy text-sm">Detect MFA</div>
                        <div className="text-xs text-genz-muted">Auto-detect 2FA/MFA pages</div>
                      </div>
                    </label>
                    
                    <div>
                      <label className="block text-xs text-genz-muted mb-1">When MFA Detected</label>
                      <select
                        value={mfaOptions.action}
                        onChange={(e) => setMfaOptions(prev => ({ ...prev, action: e.target.value }))}
                        className="w-full px-3 py-2 bg-[#FFFFFF] border border-genz-border rounded-lg text-genz-navy text-sm focus:outline-none focus:border-genz-teal"
                      >
                        <option value="notify">Notify user to complete manually</option>
                        <option value="wait">Wait for user to complete</option>
                        <option value="skip">Skip MFA detection</option>
                      </select>
                    </div>
                  </div>
                </div>
                
                {/* Custom Selectors */}
                <div className="border-t border-genz-border pt-4 mt-4">
                  <div className="flex items-center gap-2 mb-4">
                    <Info size={16} className="text-blue-500" />
                    <span className="text-sm text-genz-muted">Custom Selectors (optional - uses smart detection by default)</span>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs text-genz-muted mb-1">Username Field Selector</label>
                      <input
                        type="text"
                        value={formSelectors.username}
                        onChange={(e) => setFormSelectors(prev => ({ ...prev, username: e.target.value }))}
                        className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy text-sm placeholder-genz-muted focus:outline-none focus:border-genz-teal"
                        placeholder='input[name="email"]'
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-genz-muted mb-1">Password Field Selector</label>
                      <input
                        type="text"
                        value={formSelectors.password}
                        onChange={(e) => setFormSelectors(prev => ({ ...prev, password: e.target.value }))}
                        className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy text-sm placeholder-genz-muted focus:outline-none focus:border-genz-teal"
                        placeholder='input[type="password"]'
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-genz-muted mb-1">Submit Button Selector</label>
                      <input
                        type="text"
                        value={formSelectors.submit}
                        onChange={(e) => setFormSelectors(prev => ({ ...prev, submit: e.target.value }))}
                        className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy text-sm placeholder-genz-muted focus:outline-none focus:border-genz-teal"
                        placeholder='button[type="submit"]'
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-genz-muted mb-1">Next Button Selector (multi-step)</label>
                      <input
                        type="text"
                        value={formSelectors.next}
                        onChange={(e) => setFormSelectors(prev => ({ ...prev, next: e.target.value }))}
                        className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy text-sm placeholder-genz-muted focus:outline-none focus:border-genz-teal"
                        placeholder='button[class*="next"]'
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* SSO / OAuth Fields */}
            {formData.credentialType === 'sso' && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 mb-4">
                  <Globe size={18} className="text-genz-teal" />
                  <span className="font-medium text-genz-navy">SSO / OAuth Configuration</span>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-genz-navy mb-2">
                      Auth Start URL *
                    </label>
                    <input
                      type="url"
                      value={ssoData.authStartUrl}
                      onChange={(e) => setSsoData(prev => ({ ...prev, authStartUrl: e.target.value }))}
                      className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                      placeholder="https://example.com/auth/sso"
                    />
                    <p className="mt-1 text-xs text-genz-muted">URL to start the SSO flow</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-genz-navy mb-2">
                      Post-Login URL
                    </label>
                    <input
                      type="url"
                      value={ssoData.postLoginUrl}
                      onChange={(e) => setSsoData(prev => ({ ...prev, postLoginUrl: e.target.value }))}
                      className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                      placeholder="https://example.com/dashboard"
                    />
                    <p className="mt-1 text-xs text-genz-muted">Expected URL after successful login</p>
                  </div>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-genz-navy mb-2">
                      SSO Provider
                    </label>
                    <select
                      value={ssoData.provider}
                      onChange={(e) => setSsoData(prev => ({ ...prev, provider: e.target.value }))}
                      className="w-full px-4 py-3 bg-[#FFFFFF] border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal"
                    >
                      <option value="">Auto-detect</option>
                      <option value="google">Google</option>
                      <option value="microsoft">Microsoft / Azure AD</option>
                      <option value="github">GitHub</option>
                      <option value="okta">Okta</option>
                      <option value="auth0">Auth0</option>
                      <option value="saml">SAML / Enterprise SSO</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-genz-navy mb-2">
                      Provider Button Selector
                    </label>
                    <input
                      type="text"
                      value={ssoData.buttonSelector}
                      onChange={(e) => setSsoData(prev => ({ ...prev, buttonSelector: e.target.value }))}
                      className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                      placeholder='button[data-provider="google"]'
                    />
                  </div>
                </div>
                
                <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-xl cursor-pointer hover:bg-genz-bg transition-colors">
                  <input
                    type="checkbox"
                    checked={ssoData.autoClick}
                    onChange={(e) => setSsoData(prev => ({ ...prev, autoClick: e.target.checked }))}
                    className="w-5 h-5 rounded border-genz-border text-genz-teal focus:ring-genz-teal"
                  />
                  <div>
                    <div className="font-medium text-genz-navy">Auto-click provider button</div>
                    <div className="text-xs text-genz-muted">Automatically click the SSO provider button on the login page</div>
                  </div>
                </label>
              </div>
            )}

            {/* Custom Headers Fields */}
            {formData.credentialType === 'headers' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Database size={18} className="text-genz-teal" />
                    <span className="font-medium text-genz-navy">Custom Headers</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setHeadersData(prev => [...prev, { name: '', value: '', prefix: '' }])}
                    className="text-sm text-genz-teal hover:underline"
                  >
                    + Add Header
                  </button>
                </div>
                
                <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg mb-4">
                  <div className="flex items-start gap-2">
                    <AlertCircle size={16} className="text-yellow-500 mt-0.5" />
                    <div className="text-sm text-yellow-200">
                      <strong>MV3 Limitation:</strong> Chrome Extension MV3 cannot modify request headers directly. 
                      For best results, configure server-side session bootstrap to set cookies instead.
                    </div>
                  </div>
                </div>
                
                {headersData.map((header, index) => (
                  <div key={index} className="grid grid-cols-12 gap-3 items-center">
                    <div className="col-span-4">
                      <input
                        type="text"
                        value={header.name}
                        onChange={(e) => {
                          const newHeaders = [...headersData];
                          newHeaders[index].name = e.target.value;
                          setHeadersData(newHeaders);
                        }}
                        className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy text-sm placeholder-genz-muted focus:outline-none focus:border-genz-teal"
                        placeholder="Header Name"
                      />
                    </div>
                    <div className="col-span-2">
                      <input
                        type="text"
                        value={header.prefix}
                        onChange={(e) => {
                          const newHeaders = [...headersData];
                          newHeaders[index].prefix = e.target.value;
                          setHeadersData(newHeaders);
                        }}
                        className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy text-sm placeholder-genz-muted focus:outline-none focus:border-genz-teal"
                        placeholder="Prefix"
                      />
                    </div>
                    <div className="col-span-5">
                      <input
                        type="password"
                        value={header.value}
                        onChange={(e) => {
                          const newHeaders = [...headersData];
                          newHeaders[index].value = e.target.value;
                          setHeadersData(newHeaders);
                        }}
                        className="w-full px-3 py-2 bg-genz-bg border border-genz-border rounded-lg text-genz-navy text-sm placeholder-genz-muted focus:outline-none focus:border-genz-teal"
                        placeholder="Header Value"
                      />
                    </div>
                    <div className="col-span-1">
                      {headersData.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setHeadersData(prev => prev.filter((_, i) => i !== index))}
                          className="text-red-500 hover:text-red-600"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Cookies Input */}
            {formData.credentialType === 'cookies' && (
              <div>
                <label htmlFor="cookiesEncrypted" className="block text-sm font-medium text-genz-navy mb-2">
                  Cookies JSON {isEdit && '(leave empty to keep existing)'}
                </label>
                <textarea
                  id="cookiesEncrypted"
                  name="cookiesEncrypted"
                  value={formData.cookiesEncrypted}
                  onChange={handleChange}
                  rows={5}
                  spellCheck="false"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors resize-none font-mono text-sm"
                  placeholder='[{"name": "session", "value": "abc123", "domain": ".example.com"}]'
                  data-testid="tool-cookies-input"
                />
                <p className="mt-2 text-xs text-genz-muted">
                  Paste cookies as JSON array. Will be encrypted with AES-256-GCM.
                </p>
              </div>
            )}

            {/* Token Input */}
            {formData.credentialType === 'token' && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="tokenHeader" className="block text-sm font-medium text-genz-navy mb-2">
                      Header Name
                    </label>
                    <input
                      type="text"
                      id="tokenHeader"
                      name="tokenHeader"
                      value={formData.tokenHeader}
                      onChange={handleChange}
                      className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                      placeholder="Authorization"
                      data-testid="tool-token-header"
                    />
                  </div>
                  <div>
                    <label htmlFor="tokenPrefix" className="block text-sm font-medium text-genz-navy mb-2">
                      Token Prefix
                    </label>
                    <input
                      type="text"
                      id="tokenPrefix"
                      name="tokenPrefix"
                      value={formData.tokenPrefix}
                      onChange={handleChange}
                      className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                      placeholder="Bearer "
                      data-testid="tool-token-prefix"
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="tokenEncrypted" className="block text-sm font-medium text-genz-navy mb-2">
                    Token Value {isEdit && '(leave empty to keep existing)'}
                  </label>
                  <input
                    type="password"
                    id="tokenEncrypted"
                    name="tokenEncrypted"
                    value={formData.tokenEncrypted}
                    onChange={handleChange}
                    className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors font-mono"
                    placeholder="Enter token value..."
                    data-testid="tool-token-value"
                  />
                  <p className="mt-2 text-xs text-genz-muted">
                    Token will be stored in localStorage as: access_token, token, auth_token
                  </p>
                </div>
              </div>
            )}

            {/* LocalStorage / SessionStorage Input */}
            {(formData.credentialType === 'localStorage' || formData.credentialType === 'sessionStorage') && (
              <div>
                <label htmlFor="localStorageEncrypted" className="block text-sm font-medium text-genz-navy mb-2">
                  {formData.credentialType === 'sessionStorage' ? 'Session' : 'Local'}Storage Data {isEdit && '(leave empty to keep existing)'}
                </label>
                <textarea
                  id="localStorageEncrypted"
                  name="localStorageEncrypted"
                  value={formData.localStorageEncrypted}
                  onChange={handleChange}
                  rows={5}
                  spellCheck="false"
                  autoComplete="off"
                  className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors resize-none font-mono text-sm"
                  placeholder='{"key1": "value1", "key2": "value2"}'
                  data-testid="tool-localstorage-input"
                />
                <p className="mt-2 text-xs text-genz-muted">
                  Paste {formData.credentialType} data as JSON object. Keys will be set in browser storage.
                </p>
              </div>
            )}

            {formData.credentialType === 'none' && (
              <div className="p-4 bg-genz-bg rounded-xl text-center">
                <p className="text-genz-muted">No credentials required for this tool.</p>
              </div>
            )}
          </div>

          {/* Success Check Card (shown for form, sso, headers, combo) */}
          {['form', 'sso', 'headers', 'combo'].includes(formData.credentialType) && (
            <div className="bg-white border border-genz-border rounded-xl p-6">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-genz-navy mb-6">
                <CheckCircle size={20} className="text-green-500" />
                Success Validation (Optional)
              </h2>
              <p className="text-sm text-genz-muted mb-4">
                Define how the extension should verify that login was successful.
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-genz-navy mb-2">
                    URL Should Include
                  </label>
                  <input
                    type="text"
                    value={successCheck.urlIncludes}
                    onChange={(e) => setSuccessCheck(prev => ({ ...prev, urlIncludes: e.target.value }))}
                    className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                    placeholder="/dashboard"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-genz-navy mb-2">
                    URL Should NOT Include
                  </label>
                  <input
                    type="text"
                    value={successCheck.urlExcludes}
                    onChange={(e) => setSuccessCheck(prev => ({ ...prev, urlExcludes: e.target.value }))}
                    className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                    placeholder="/login"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-genz-navy mb-2">
                    Element Should Exist (CSS Selector)
                  </label>
                  <input
                    type="text"
                    value={successCheck.elementExists}
                    onChange={(e) => setSuccessCheck(prev => ({ ...prev, elementExists: e.target.value }))}
                    className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                    placeholder=".user-avatar, [data-testid='user-menu']"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-genz-navy mb-2">
                    Cookie Names (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={successCheck.cookieNames}
                    onChange={(e) => setSuccessCheck(prev => ({ ...prev, cookieNames: e.target.value }))}
                    className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                    placeholder="session, auth_token"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Extension Settings Card */}
          <div className="bg-white border border-genz-border rounded-xl p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-genz-navy mb-6">
              <Settings size={20} className="text-genz-teal" />
              Extension Settings
            </h2>
            
            <div className="space-y-4">
              <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-xl cursor-pointer hover:bg-genz-bg transition-colors">
                <input
                  type="checkbox"
                  name="extensionSettings.autoInject"
                  checked={formData.extensionSettings.autoInject}
                  onChange={handleChange}
                  className="w-5 h-5 rounded border-genz-border text-genz-teal focus:ring-genz-teal"
                />
                <div>
                  <div className="font-medium text-genz-navy">Auto-inject credentials</div>
                  <div className="text-xs text-genz-muted">Automatically inject when visiting tool URL</div>
                </div>
              </label>

              <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-xl cursor-pointer hover:bg-genz-bg transition-colors">
                <input
                  type="checkbox"
                  name="extensionSettings.reloadAfterLogin"
                  checked={formData.extensionSettings.reloadAfterLogin}
                  onChange={handleChange}
                  className="w-5 h-5 rounded border-genz-border text-genz-teal focus:ring-genz-teal"
                />
                <div>
                  <div className="font-medium text-genz-navy">Reload after login</div>
                  <div className="text-xs text-genz-muted">Reload the page after credentials are injected</div>
                </div>
              </label>

              <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-xl cursor-pointer hover:bg-genz-bg transition-colors">
                <input
                  type="checkbox"
                  name="extensionSettings.spaMode"
                  checked={formData.extensionSettings.spaMode}
                  onChange={handleChange}
                  className="w-5 h-5 rounded border-genz-border text-genz-teal focus:ring-genz-teal"
                />
                <div>
                  <div className="font-medium text-genz-navy">SPA Mode</div>
                  <div className="text-xs text-genz-muted">Enable for React/Vue/Angular apps with client-side routing</div>
                </div>
              </label>
              
              {/* Hidden Mode Settings */}
              <div className="border-t border-genz-border pt-4 mt-4">
                <div className="flex items-center gap-2 mb-4">
                  <Shield size={16} className="text-purple-500" />
                  <span className="text-sm font-medium text-genz-navy">Hidden Mode & Auto-Start</span>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-xl cursor-pointer hover:bg-genz-bg transition-colors">
                    <input
                      type="checkbox"
                      name="extensionSettings.hiddenModeEnabled"
                      checked={formData.extensionSettings.hiddenModeEnabled}
                      onChange={handleChange}
                      className="w-5 h-5 rounded border-genz-border text-purple-500 focus:ring-purple-500"
                    />
                    <div>
                      <div className="font-medium text-genz-navy text-sm">Hidden Mode</div>
                      <div className="text-xs text-genz-muted">Run auth in hidden tab (?hidden=1)</div>
                    </div>
                  </label>
                  
                  <label className="flex items-center gap-3 p-3 bg-genz-bg rounded-xl cursor-pointer hover:bg-genz-bg transition-colors">
                    <input
                      type="checkbox"
                      name="extensionSettings.autoStartEnabled"
                      checked={formData.extensionSettings.autoStartEnabled}
                      onChange={handleChange}
                      className="w-5 h-5 rounded border-genz-border text-purple-500 focus:ring-purple-500"
                    />
                    <div>
                      <div className="font-medium text-genz-navy text-sm">Auto-Start</div>
                      <div className="text-xs text-genz-muted">Start login when ?auto=1</div>
                    </div>
                  </label>
                </div>
              </div>
              
              {/* Timing Settings */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-genz-border mt-4">
                <div>
                  <label className="block text-sm font-medium text-genz-navy mb-2">
                    Retry Attempts
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="5"
                    name="extensionSettings.retryAttempts"
                    value={formData.extensionSettings.retryAttempts}
                    onChange={handleChange}
                    className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-genz-navy mb-2">
                    Retry Delay (ms)
                  </label>
                  <input
                    type="number"
                    min="500"
                    max="10000"
                    step="500"
                    name="extensionSettings.retryDelayMs"
                    value={formData.extensionSettings.retryDelayMs}
                    onChange={handleChange}
                    className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-genz-navy mb-2">
                    Auto-Start Delay
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="5000"
                    step="100"
                    name="extensionSettings.autoStartDelay"
                    value={formData.extensionSettings.autoStartDelay}
                    onChange={handleChange}
                    className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-genz-navy mb-2">
                    Hidden Timeout
                  </label>
                  <input
                    type="number"
                    min="10000"
                    max="120000"
                    step="5000"
                    name="extensionSettings.hiddenModeTimeout"
                    value={formData.extensionSettings.hiddenModeTimeout}
                    onChange={handleChange}
                    className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal transition-colors"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Status Card */}
          <div className="bg-white border border-genz-border rounded-xl p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-genz-navy mb-4">
              <Shield size={20} className="text-genz-teal" />
              Status
            </h2>
            
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="status"
                  value="active"
                  checked={formData.status === 'active'}
                  onChange={handleChange}
                  className="w-4 h-4 text-genz-teal focus:ring-genz-teal"
                />
                <span className="text-genz-navy">Active</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="status"
                  value="inactive"
                  checked={formData.status === 'inactive'}
                  onChange={handleChange}
                  className="w-4 h-4 text-genz-teal focus:ring-genz-teal"
                />
                <span className="text-genz-navy">Inactive</span>
              </label>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-4 pt-4">
            <button
              type="button"
              onClick={() => navigate('/admin/tools')}
              className="px-6 py-3 text-genz-muted hover:text-genz-navy transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-8 py-3 btn-grad rounded-full font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              data-testid="save-tool-btn"
            >
              <Save size={20} />
              {saving ? 'Saving...' : (isEdit ? 'Update Tool' : 'Create Tool')}
            </button>
          </div>
        </form>
      </div>
    </AdminLayout>
  );
};

export default AdminToolForm;
