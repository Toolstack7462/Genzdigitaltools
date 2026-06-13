const Joi = require('joi');

/**
 * Validation middleware wrapper
 */
const validate = (schema) => {
  return (req, res, next) => {
    const { error } = schema.validate(req.body, { abortEarly: false });
    
    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));
      
      return res.status(400).json({
        error: 'Validation failed',
        details: errors
      });
    }
    
    next();
  };
};

/**
 * Common validation schemas
 */
const schemas = {
  // Auth schemas
  adminLogin: Joi.object({
    email: Joi.string().email().required().messages({
      'string.email': 'Please provide a valid email address',
      'any.required': 'Email is required'
    }),
    password: Joi.string().min(6).required().messages({
      'string.min': 'Password must be at least 6 characters',
      'any.required': 'Password is required'
    })
  }),
  
  clientLogin: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(6).required(),
    deviceId: Joi.string().required().messages({
      'any.required': 'Device ID is required for security'
    })
  }),
  
  register: Joi.object({
    fullName: Joi.string().min(2).max(100).required().messages({
      'string.min': 'Full name must be at least 2 characters',
      'any.required': 'Full name is required'
    }),
    email: Joi.string().email().required(),
    password: Joi.string().min(8).pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).required().messages({
      'string.min': 'Password must be at least 8 characters',
      'string.pattern.base': 'Password must contain uppercase, lowercase, and number',
      'any.required': 'Password is required'
    })
  }),
  
  refreshToken: Joi.object({
    refreshToken: Joi.string().required().messages({
      'any.required': 'Refresh token is required'
    })
  }),
  
  // Client schemas
  createClient: Joi.object({
    fullName: Joi.string().min(2).max(100).required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(8).required(),
    status: Joi.string().valid('active', 'disabled').default('active'),
    devicePolicyEnabled: Joi.boolean().default(true),
    notes: Joi.string().allow('', null).max(500)
  }),
  
  updateClient: Joi.object({
    fullName: Joi.string().min(2).max(100),
    email: Joi.string().email(),
    password: Joi.string().min(8),
    status: Joi.string().valid('active', 'disabled'),
    devicePolicyEnabled: Joi.boolean(),
    notes: Joi.string().allow('', null).max(500)
  }).min(1),
  
  // Tool schemas
  createTool: Joi.object({
    name: Joi.string().min(2).max(200).required(),
    description: Joi.string().max(1000).allow('', null),
    targetUrl: Joi.string().uri().required().messages({
      'string.uri': 'Please provide a valid URL'
    }),
    loginUrl: Joi.string().uri().allow('', null),
    category: Joi.string().valid(
      'AI', 'Academic', 'SEO', 'Productivity', 
      'Graphics & SEO', 'Text Humanizers', 
      'Career-Oriented', 'Miscellaneous', 'Other'
    ).default('Other'),
    status: Joi.string().valid('active', 'inactive').default('active'),
    // Updated to support unified credential types
    credentialType: Joi.string().valid('form', 'sso', 'headers', 'cookies', 'token', 'localStorage', 'sessionStorage', 'none').default('cookies'),
    // Legacy credential fields
    cookiesEncrypted: Joi.string().allow('', null),
    tokenEncrypted: Joi.string().allow('', null),
    tokenHeader: Joi.string().max(100).default('Authorization'),
    tokenPrefix: Joi.string().max(50).allow('').default('Bearer '),
    localStorageEncrypted: Joi.string().allow('', null),
    // New unified credentials field
    credentials: Joi.object({
      type: Joi.string().valid('form', 'sso', 'headers', 'cookies', 'token', 'localStorage', 'sessionStorage', 'none').required(),
      payload: Joi.object().allow(null),
      selectors: Joi.object({
        username: Joi.string().allow(''),
        password: Joi.string().allow(''),
        submit: Joi.string().allow(''),
        next: Joi.string().allow(''),
        rememberMe: Joi.string().allow(''),
        twoFactor: Joi.string().allow(''),
        errorMessage: Joi.string().allow(''),
        ssoButton: Joi.string().allow('')
      }).allow(null),
      successCheck: Joi.object({
        urlIncludes: Joi.string().allow(''),
        urlExcludes: Joi.string().allow(''),
        urlPattern: Joi.string().allow(''),
        cookieNames: Joi.array().items(Joi.string()),
        cookieValues: Joi.object(),
        elementExists: Joi.string().allow(''),
        elementNotExists: Joi.string().allow(''),
        storageKeys: Joi.array().items(Joi.string()),
        customRules: Joi.string().allow('')
      }).allow(null),
      tokenHeader: Joi.string().allow(''),
      tokenPrefix: Joi.string().allow('')
    }).allow(null),
    // Universal Combo Auth - allows ANY two auth types combined with parallel mode
    comboAuth: Joi.object({
      enabled: Joi.boolean().default(false),
      runMode: Joi.string().valid('sequential', 'parallel').default('sequential'),
      primaryType: Joi.string().valid('sso', 'form', 'cookies', 'token', 'headers', 'localStorage', 'sessionStorage').default('sso'),
      secondaryType: Joi.string().valid('sso', 'form', 'cookies', 'token', 'headers', 'localStorage', 'sessionStorage').default('form'),
      fallbackEnabled: Joi.boolean().default(true),
      fallbackOnlyOnce: Joi.boolean().default(true),
      skipIfLoggedIn: Joi.boolean().default(true),
      triggerOnAuto: Joi.boolean().default(true),
      parallelSettings: Joi.object({
        prepSessionFirst: Joi.boolean().default(true),
        parallelTimeout: Joi.number().min(5000).max(120000).default(30000),
        commitLock: Joi.boolean().default(true),
        verifyAfterAuth: Joi.boolean().default(true)
      }).allow(null),
      formConfig: Joi.object({
        username: Joi.string().allow(''),
        password: Joi.string().allow(''),
        loginUrl: Joi.string().uri().allow('', null),
        multiStep: Joi.boolean().default(false),
        rememberMe: Joi.boolean().default(true),
        submitDelay: Joi.number().min(0).max(5000).default(800),
        autoSubmit: Joi.boolean().default(true)
      }).allow(null),
      ssoConfig: Joi.object({
        authStartUrl: Joi.string().uri().allow('', null),
        postLoginUrl: Joi.string().uri().allow('', null),
        provider: Joi.string().allow(''),
        buttonSelector: Joi.string().allow(''),
        autoClick: Joi.boolean().default(true)
      }).allow(null),
      cookiesConfig: Joi.object({
        cookies: Joi.string().allow(''),
        injectFirst: Joi.boolean().default(true)
      }).allow(null),
      tokenConfig: Joi.object({
        token: Joi.string().allow(''),
        header: Joi.string().default('Authorization'),
        prefix: Joi.string().default('Bearer '),
        storageKey: Joi.string().default('access_token')
      }).allow(null),
      localStorageConfig: Joi.object({
        data: Joi.string().allow('')
      }).allow(null),
      sessionStorageConfig: Joi.object({
        data: Joi.string().allow('')
      }).allow(null)
    }).allow(null),
    // Session Bundle - unified storage for cookies + localStorage + sessionStorage
    sessionBundle: Joi.object({
      cookiesEncrypted: Joi.string().allow('', null),
      localStorageEncrypted: Joi.string().allow('', null),
      sessionStorageEncrypted: Joi.string().allow('', null)
    }).allow(null),
    // Enhanced extension settings
    extensionSettings: Joi.object({
      requirePermission: Joi.boolean().default(true),
      autoInject: Joi.boolean().default(true),
      injectOnPageLoad: Joi.boolean().default(true),
      clearExistingCookies: Joi.boolean().default(false),
      reloadAfterLogin: Joi.boolean().default(true),
      waitForNavigation: Joi.boolean().default(true),
      spaMode: Joi.boolean().default(false),
      retryAttempts: Joi.number().min(0).max(10).default(2),
      retryDelayMs: Joi.number().min(100).max(10000).default(1000),
      hiddenModeEnabled: Joi.boolean().default(true),
      hiddenModeTimeout: Joi.number().min(10000).max(120000).default(60000),
      autoStartEnabled: Joi.boolean().default(true),
      autoStartDelay: Joi.number().min(0).max(5000).default(800),
      maxAutoAttempts: Joi.number().min(1).max(5).default(2),
      notes: Joi.string().allow('', null)
    }).default(),
    fileMeta: Joi.object({
      name: Joi.string(),
      size: Joi.number(),
      type: Joi.string()
    }).allow(null)
  }),
  
  updateTool: Joi.object({
    name: Joi.string().min(2).max(200),
    description: Joi.string().max(1000).allow('', null),
    targetUrl: Joi.string().uri(),
    loginUrl: Joi.string().uri().allow('', null),
    category: Joi.string().valid(
      'AI', 'Academic', 'SEO', 'Productivity', 
      'Graphics & SEO', 'Text Humanizers', 
      'Career-Oriented', 'Miscellaneous', 'Other'
    ),
    status: Joi.string().valid('active', 'inactive'),
    // Updated to support unified credential types
    credentialType: Joi.string().valid('form', 'sso', 'headers', 'cookies', 'token', 'localStorage', 'sessionStorage', 'none'),
    // Legacy credential fields
    cookiesEncrypted: Joi.string().allow('', null),
    tokenEncrypted: Joi.string().allow('', null),
    tokenHeader: Joi.string().max(100),
    tokenPrefix: Joi.string().max(50).allow(''),
    localStorageEncrypted: Joi.string().allow('', null),
    // New unified credentials field
    credentials: Joi.object({
      type: Joi.string().valid('form', 'sso', 'headers', 'cookies', 'token', 'localStorage', 'sessionStorage', 'none').required(),
      payload: Joi.object().allow(null),
      selectors: Joi.object({
        username: Joi.string().allow(''),
        password: Joi.string().allow(''),
        submit: Joi.string().allow(''),
        next: Joi.string().allow(''),
        rememberMe: Joi.string().allow(''),
        twoFactor: Joi.string().allow(''),
        errorMessage: Joi.string().allow(''),
        ssoButton: Joi.string().allow('')
      }).allow(null),
      successCheck: Joi.object({
        urlIncludes: Joi.string().allow(''),
        urlExcludes: Joi.string().allow(''),
        urlPattern: Joi.string().allow(''),
        cookieNames: Joi.array().items(Joi.string()),
        cookieValues: Joi.object(),
        elementExists: Joi.string().allow(''),
        elementNotExists: Joi.string().allow(''),
        storageKeys: Joi.array().items(Joi.string()),
        customRules: Joi.string().allow('')
      }).allow(null),
      tokenHeader: Joi.string().allow(''),
      tokenPrefix: Joi.string().allow('')
    }).allow(null),
    // Combo Auth - allows both SSO and Form with parallel mode
    comboAuth: Joi.object({
      enabled: Joi.boolean(),
      runMode: Joi.string().valid('sequential', 'parallel'),
      primaryType: Joi.string().valid('sso', 'form', 'cookies', 'token', 'headers', 'localStorage', 'sessionStorage'),
      secondaryType: Joi.string().valid('sso', 'form', 'cookies', 'token', 'headers', 'localStorage', 'sessionStorage'),
      fallbackEnabled: Joi.boolean(),
      fallbackOnlyOnce: Joi.boolean(),
      skipIfLoggedIn: Joi.boolean(),
      triggerOnAuto: Joi.boolean(),
      parallelSettings: Joi.object({
        prepSessionFirst: Joi.boolean(),
        parallelTimeout: Joi.number().min(5000).max(120000),
        commitLock: Joi.boolean(),
        verifyAfterAuth: Joi.boolean()
      }).allow(null),
      formConfig: Joi.object({
        username: Joi.string().allow(''),
        password: Joi.string().allow(''),
        loginUrl: Joi.string().uri().allow('', null),
        multiStep: Joi.boolean(),
        rememberMe: Joi.boolean(),
        submitDelay: Joi.number().min(0).max(5000),
        autoSubmit: Joi.boolean()
      }).allow(null),
      ssoConfig: Joi.object({
        authStartUrl: Joi.string().uri().allow('', null),
        postLoginUrl: Joi.string().uri().allow('', null),
        provider: Joi.string().allow(''),
        buttonSelector: Joi.string().allow(''),
        autoClick: Joi.boolean()
      }).allow(null),
      cookiesConfig: Joi.object({
        cookies: Joi.string().allow(''),
        injectFirst: Joi.boolean()
      }).allow(null),
      tokenConfig: Joi.object({
        token: Joi.string().allow(''),
        header: Joi.string(),
        prefix: Joi.string(),
        storageKey: Joi.string()
      }).allow(null),
      localStorageConfig: Joi.object({
        data: Joi.string().allow('')
      }).allow(null),
      sessionStorageConfig: Joi.object({
        data: Joi.string().allow('')
      }).allow(null)
    }).allow(null),
    // Session Bundle - unified storage
    sessionBundle: Joi.object({
      cookiesEncrypted: Joi.string().allow('', null),
      localStorageEncrypted: Joi.string().allow('', null),
      sessionStorageEncrypted: Joi.string().allow('', null)
    }).allow(null),
    // Enhanced extension settings
    extensionSettings: Joi.object({
      requirePermission: Joi.boolean(),
      autoInject: Joi.boolean(),
      injectOnPageLoad: Joi.boolean(),
      clearExistingCookies: Joi.boolean(),
      reloadAfterLogin: Joi.boolean(),
      waitForNavigation: Joi.boolean(),
      spaMode: Joi.boolean(),
      retryAttempts: Joi.number().min(0).max(10),
      retryDelayMs: Joi.number().min(100).max(10000),
      hiddenModeEnabled: Joi.boolean(),
      hiddenModeTimeout: Joi.number().min(10000).max(120000),
      autoStartEnabled: Joi.boolean(),
      autoStartDelay: Joi.number().min(0).max(5000),
      maxAutoAttempts: Joi.number().min(1).max(5),
      notes: Joi.string().allow('', null)
    }),
    fileMeta: Joi.object({
      name: Joi.string(),
      size: Joi.number(),
      type: Joi.string()
    }).allow(null)
  }).min(1),
  
  // Assignment schemas
  createAssignment: Joi.object({
    clientId: Joi.string().required(),
    toolId: Joi.string().required(),
    startDate: Joi.date().iso().allow(null),
    endDate: Joi.date().iso().min(Joi.ref('startDate')).allow(null).messages({
      'date.min': 'End date must be after start date'
    }),
    durationDays: Joi.number().min(1).max(3650).allow(null),
    notes: Joi.string().max(500).allow('', null)
  }),
  
  bulkAssign: Joi.object({
    clientIds: Joi.array().items(Joi.string()).min(1).required(),
    toolIds: Joi.array().items(Joi.string()).min(1).required(),
    startDate: Joi.date().iso().allow(null),
    durationDays: Joi.number().min(1).max(3650).allow(null),
    notes: Joi.string().max(500).allow('', null)
  }),
  
  // Device schemas
  requestCookies: Joi.object({
    deviceId: Joi.string().required().messages({
      'any.required': 'Device ID is required for security'
    })
  })
};

module.exports = {
  validate,
  schemas
};
