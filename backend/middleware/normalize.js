/**
 * Input Normalization Middleware
 * 
 * This middleware normalizes common input fields BEFORE validation
 * to prevent login issues from whitespace and case sensitivity.
 * 
 * IMPORTANT: This must run BEFORE validation middleware
 */

/**
 * Normalize authentication inputs
 * - Trims and lowercases email
 * - Trims password (but keeps case)
 * - Trims deviceId if present
 */
const normalizeAuthInputs = (req, res, next) => {
  if (req.body) {
    // Normalize email
    if (req.body.email && typeof req.body.email === 'string') {
      req.body.email = req.body.email.trim().toLowerCase();
    }
    
    // Normalize password (trim only, keep case sensitivity)
    if (req.body.password && typeof req.body.password === 'string') {
      req.body.password = req.body.password.trim();
    }
    
    // Normalize deviceId if present
    if (req.body.deviceId && typeof req.body.deviceId === 'string') {
      req.body.deviceId = req.body.deviceId.trim();
    }
    
    // Normalize fullName if present
    if (req.body.fullName && typeof req.body.fullName === 'string') {
      req.body.fullName = req.body.fullName.trim();
    }
  }
  
  next();
};

/**
 * Normalize general string inputs
 * - Trims all string fields
 * - Lowercases email fields
 */
const normalizeStringInputs = (req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    Object.keys(req.body).forEach(key => {
      const value = req.body[key];
      
      if (typeof value === 'string') {
        // Trim all strings
        req.body[key] = value.trim();
        
        // Lowercase email fields
        if (key === 'email' || key.toLowerCase().includes('email')) {
          req.body[key] = req.body[key].toLowerCase();
        }
      }
    });
  }
  
  next();
};

module.exports = {
  normalizeAuthInputs,
  normalizeStringInputs
};
