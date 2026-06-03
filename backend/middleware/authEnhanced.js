const jwt = require('jsonwebtoken');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const crypto = require('crypto');

// Validate required environment variables
const requiredEnvVars = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'COOKIES_ENCRYPTION_KEY'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('\n❌ CRITICAL ERROR: Missing required environment variables:');
  missingVars.forEach(varName => {
    console.error(`   - ${varName}`);
  });
  console.error('\n💡 Please set these in your .env file. See .env.example for reference.\n');
  process.exit(1);
}

// Check encryption key format
const encryptionKey = process.env.COOKIES_ENCRYPTION_KEY;
if (encryptionKey.length !== 64 || !/^[0-9a-f]{64}$/i.test(encryptionKey)) {
  console.error('\n❌ CRITICAL ERROR: COOKIES_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.');
  console.error('💡 Generate one using: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const JWT_ACCESS_TOKEN_EXPIRY = process.env.JWT_ACCESS_TOKEN_EXPIRY || '15m';
const JWT_REFRESH_TOKEN_EXPIRY = process.env.JWT_REFRESH_TOKEN_EXPIRY || '7d';

console.log('✅ All required security environment variables are set');

/**
 * Generate access token (short-lived)
 */
function generateAccessToken(userId, role, tokenVersion) {
  return jwt.sign(
    { 
      userId, 
      role,
      tokenVersion,
      type: 'access'
    },
    JWT_SECRET,
    { expiresIn: JWT_ACCESS_TOKEN_EXPIRY }
  );
}

/**
 * Generate refresh token (long-lived)
 */
function generateRefreshToken(userId, role) {
  return jwt.sign(
    { 
      userId, 
      role,
      type: 'refresh'
    },
    JWT_REFRESH_SECRET,
    { expiresIn: JWT_REFRESH_TOKEN_EXPIRY }
  );
}

/**
 * Generate random refresh token string
 */
function generateRefreshTokenString() {
  return crypto.randomBytes(64).toString('hex');
}

/**
 * Hash a refresh token for safe DB storage.
 * The raw token is kept in the cookie; only the hash is stored in MySQL/MariaDB.
 * This prevents DB compromise from yielding valid refresh tokens.
 */
function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate token pair and save refresh token to DB
 */
async function generateTokenPair(user, ipAddress) {
  const accessToken = generateAccessToken(user._id, user.role, user.tokenVersion);
  const refreshTokenString = generateRefreshTokenString();
  
  // Calculate expiry date (7 days from now)
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  
  // Store only the SHA-256 hash in DB — raw token lives only in the httpOnly cookie
  const tokenHash = hashRefreshToken(refreshTokenString);
  await RefreshToken.create({
    userId: user._id,
    token: tokenHash,
    expiresAt,
    createdByIp: ipAddress
  });
  
  return {
    accessToken,
    refreshToken: refreshTokenString
  };
}

/**
 * Verify access token
 */
function verifyAccessToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'access') {
      return null;
    }
    return decoded;
  } catch (error) {
    return null;
  }
}

/**
 * Verify refresh token
 */
function verifyRefreshToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_REFRESH_SECRET);
    if (decoded.type !== 'refresh') {
      return null;
    }
    return decoded;
  } catch (error) {
    return null;
  }
}

/**
 * Middleware: Require authentication
 */
async function requireAuth(req, res, next) {
  try {
    // Get token from Authorization header or cookie
    let token = null;
    
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies && req.cookies.accessToken) {
      token = req.cookies.accessToken;
    }
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const decoded = verifyAccessToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    
    // Get user from database
    const user = await User.findById(decoded.userId).select('-passwordHash');
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    if (user.status === 'disabled') {
      return res.status(403).json({ error: 'Account is disabled' });
    }
    
    // Check token version (for force logout)
    if (decoded.tokenVersion !== user.tokenVersion) {
      return res.status(401).json({ 
        error: 'Session has been invalidated. Please login again.',
        code: 'TOKEN_VERSION_MISMATCH'
      });
    }
    
    // Attach user to request
    req.user = user;
    req.userId = user._id;
    req.userRole = user.role;
    
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

/**
 * Middleware: Require specific role
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    
    next();
  };
}

/**
 * Middleware: Require admin role (SUPER_ADMIN or ADMIN)
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (!req.user.isAdmin()) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  next();
}

/**
 * Get client IP address
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.headers['x-real-ip'] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress ||
         'unknown';
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateTokenPair,
  verifyAccessToken,
  verifyRefreshToken,
  requireAuth,
  requireRole,
  requireAdmin,
  getClientIp,
  JWT_ACCESS_TOKEN_EXPIRY,
  JWT_REFRESH_TOKEN_EXPIRY
};
