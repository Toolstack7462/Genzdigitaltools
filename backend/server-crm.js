const express = require('express');
const helmet = require('helmet'); // FIX24: security headers
const mysqlAdapter = require('./db/mysqlAdapter');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');
const path = require('path');
const bcrypt = require('bcryptjs');

// Load environment variables FIRST
dotenv.config({ path: path.join(__dirname, '.env') });

// ============================================================================
// STARTUP ENVIRONMENT VALIDATION — fail hard if critical vars are missing
// ============================================================================
const REQUIRED_ENV = {
  JWT_SECRET:                { minLength: 32 },
  JWT_REFRESH_SECRET:        { minLength: 32 },
  COOKIES_ENCRYPTION_KEY:    { minLength: 64 },
  DATABASE_URL:              { minLength: 10 },
  INITIAL_ADMIN_EMAIL:       { minLength: 5  },
  INITIAL_ADMIN_PASSWORD:    { minLength: 12 },
};

let startupFailed = false;
Object.entries(REQUIRED_ENV).forEach(([key, opts]) => {
  const val = process.env[key];
  if (!val) {
    console.error(`FATAL: Missing required environment variable: ${key}`);
    startupFailed = true;
  } else if (opts.minLength && val.length < opts.minLength) {
    console.error(`FATAL: ${key} must be at least ${opts.minLength} characters (currently ${val.length})`);
    startupFailed = true;
  }
});

if (startupFailed) {
  console.error('\nServer cannot start due to missing or weak environment variables.');
  console.error('Copy .env.example to .env and fill in all required values.\n');
  process.exit(1);
}

// Validate COOKIES_ENCRYPTION_KEY is valid hex
if (!/^[0-9a-fA-F]{64}$/.test(process.env.COOKIES_ENCRYPTION_KEY)) {
  console.error('FATAL: COOKIES_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.');
  console.error('Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

console.log('✅ All required environment variables validated.');

const app = express();

// Hostinger runs Node.js apps behind a reverse proxy.
// Required for express-rate-limit and correct client IP handling.
app.set('trust proxy', 1);

// ============================================================================
// CORS CONFIGURATION — explicit allowlist via environment variable
// ============================================================================
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : [];

if (ALLOWED_ORIGINS.length === 0) {
  console.warn('⚠️  WARNING: ALLOWED_ORIGINS is not set. No browser origins will be permitted.');
  console.warn('   Set ALLOWED_ORIGINS in .env, e.g.: https://app.example.com,http://localhost:3000');
}

const corsOptions = {
  origin: function (origin, callback) {
    // Allow server-to-server calls (no Origin header)
    if (!origin) return callback(null, true);

    if (ALLOWED_ORIGINS.includes(origin)) {
      console.log(`✅ CORS: Allowed origin: ${origin}`);
      return callback(null, true);
    }

    console.warn(`⚠️  CORS: Blocked origin: ${origin}`);
    return callback(new Error(`CORS policy: origin '${origin}' is not allowed`));
  },
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(helmet({ contentSecurityPolicy: false })); // FIX24: security headers (CSP off — managed elsewhere)
// FIX: Reduced global body limit from 10MB to 100KB. The large limit was a DoS
// vector — any unauthenticated endpoint (including /auth) could receive 10MB payloads.
// Admin routes that upload session bundles use a higher limit applied per-route below.
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(cookieParser());

// ============================================================================
// PERSISTENT MYSQL/MARIADB DATABASE CONNECTION
// ============================================================================
const DATABASE_URL = process.env.DATABASE_URL || process.env.MYSQL_URL;
const DB_NAME = (() => {
  try { return new URL(DATABASE_URL).pathname.replace(/^\//, '') || 'genz_digital_tools'; }
  catch (_) { return process.env.DB_NAME || 'genz_digital_tools'; }
})();

console.log('\n' + '='.repeat(70));
console.log('🔌 MYSQL/MARIADB CONNECTION DETAILS');
console.log('='.repeat(70));
console.log(`Database: ${DB_NAME}`);
console.log(`URL: ${mysqlAdapter.sanitizeUrl(DATABASE_URL)}`);
console.log('='.repeat(70) + '\n');

mysqlAdapter.connect()
  .then(async (info) => {
    console.log('✅ MySQL/MariaDB connected successfully!');
    console.log(`   - Host: ${info.host}`);
    console.log(`   - Database: ${info.database}`);
    await ensureIndexes();
    await bootstrapAdmin();
  })
  .catch(err => {
    console.error('❌ MySQL/MariaDB connection FAILED:', err.message);
    console.error('   Please check DATABASE_URL in .env file');
    process.exit(1);
  });

// ============================================================================
// ENSURE DATABASE TABLES / INDEXES
// ============================================================================
async function ensureIndexes() {
  try {
    await mysqlAdapter.ensureTables();
    console.log('✅ MySQL/MariaDB tables ensured.');
  } catch (err) {
    console.warn('⚠️  MySQL table/index warning:', err.message);
  }
}

// ============================================================================
// ADMIN BOOTSTRAP — with proper bcrypt hashing
// ============================================================================
async function bootstrapAdmin() {
  try {
    const User = require('./models/User');

    const adminCount = await User.countDocuments({
      role: { $in: ['SUPER_ADMIN', 'ADMIN'] }
    });

    if (adminCount === 0) {
      console.log('\n⚠️  No admin accounts found in database!');
      console.log('📝 Creating default admin account...\n');

      const adminEmail    = process.env.INITIAL_ADMIN_EMAIL.trim().toLowerCase();
      const adminPassword = process.env.INITIAL_ADMIN_PASSWORD;
      const adminName     = process.env.INITIAL_ADMIN_NAME || 'Super Admin';

      // Explicitly hash the password here (User model pre-save hook also does this,
      // but we are defensive — we never pass a raw password as passwordHash)
      const SALT_ROUNDS = 12;
      const hashedPassword = await bcrypt.hash(adminPassword, SALT_ROUNDS);

      const admin = await User.create({
        email: adminEmail,
        fullName: adminName,
        passwordHash: hashedPassword,
        _passwordPreHashed: true,   // Tell pre-save hook this is already a bcrypt hash
        role: 'SUPER_ADMIN',
        status: 'active',
        devicePolicy: {
          enabled: false,
          maxDevices: 10
        }
      });

      console.log('✅ Default admin created successfully!');
      console.log(`   - Email: ${admin.email}`);
      console.log(`   - Name:  ${admin.fullName}`);
      console.log(`   - Role:  ${admin.role}`);
      console.log(`   - ID:    ${admin._id}`);
      console.log('⚠️  IMPORTANT: Change the default password after first login!\n');

      const newAdminCount = await User.countDocuments({ role: { $in: ['SUPER_ADMIN', 'ADMIN'] } });
      const clientCount   = await User.countDocuments({ role: 'CLIENT' });
      console.log(`📊 Database Status: ${newAdminCount} admin(s), ${clientCount} client(s)\n`);
    } else {
      console.log(`✅ Admin accounts verified: ${adminCount} admin(s) exist in database\n`);
      const clientCount = await User.countDocuments({ role: 'CLIENT' });
      console.log(`📊 Database Status: ${adminCount} admin(s), ${clientCount} client(s)\n`);
    }

  } catch (error) {
    console.error('❌ Bootstrap error:', error.message);
    // Non-fatal — let server continue
  }
}

// Import enhanced routes
const authRoutes              = require('./routes/authEnhanced');
const publicRoutes            = require('./routes/public');
const adminToolsRoutes        = require('./routes/admin/toolsEnhanced');
const adminClientsRoutes      = require('./routes/admin/clientsEnhanced');
const adminAssignmentsRoutes  = require('./routes/admin/assignments');
const adminActivityRoutes     = require('./routes/admin/activity');
const adminBlogRoutes         = require('./routes/admin/blog');
const adminContactsRoutes     = require('./routes/admin/contacts');
const adminSecurityAlertsRoutes = require('./routes/admin/securityAlerts');
const clientToolsRoutes       = require('./routes/client/tools');
const clientAssignmentsRoutes = require('./routes/client/assignmentsEnhanced');
const clientNotificationsRoutes = require('./routes/client/notifications');
const clientProfileRoutes     = require('./routes/client/profile');
const clientExtensionRoutes   = require('./routes/client/extension');
const extensionRoutes         = require('./routes/extension');

// Mount routes
app.use('/api/crm/auth',             authRoutes);
app.use('/api/crm/public',           publicRoutes);
app.use('/api/crm/extension',        extensionRoutes);
// Admin tools routes get a higher body limit for session bundle uploads (cookies/storage JSON)
app.use('/api/crm/admin/tools', express.json({ limit: '10mb' }), adminToolsRoutes);
app.use('/api/crm/admin/clients',    adminClientsRoutes);
app.use('/api/crm/admin/assignments',adminAssignmentsRoutes);
app.use('/api/crm/admin/activity',   adminActivityRoutes);
app.use('/api/crm/admin/blog',       adminBlogRoutes);
app.use('/api/crm/admin/contacts',       adminContactsRoutes);
app.use('/api/crm/admin/security-alerts', adminSecurityAlertsRoutes);
app.use('/api/crm/client/tools',     clientToolsRoutes);
app.use('/api/crm/client/assignments', clientAssignmentsRoutes);
app.use('/api/crm/client/notifications', clientNotificationsRoutes);
app.use('/api/crm/client/extension', clientExtensionRoutes);
app.use('/api/crm/client',           clientProfileRoutes);

// Health check
app.get('/api/crm/health', (req, res) => {
  const dbStatus = mysqlAdapter.getStatus();
  res.json({
    status: 'ok',
    service: 'Gen Z Digital Store CRM',
    version: '2.0.0-mysql',
    mysql: {
      state: dbStatus.connected ? 'connected' : 'disconnected',
      host: dbStatus.host,
      database: dbStatus.database
    },
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

// Global error handler — never leak stack traces to client
app.use((err, req, res, next) => {
  const isDev = process.env.NODE_ENV !== 'production';
  console.error('Unhandled error:', err);

  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: 'Validation failed', details: err.details });
  }
  if (err.name === 'MongoError' || err.name === 'database adapterError' || err.code === 'ECONNREFUSED') {
    return res.status(500).json({ error: 'Database error' });
  }

  res.status(err.status || 500).json({
    error: isDev ? (err.message || 'Internal server error') : 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const PORT = process.env.PORT || process.env.CRM_PORT || 8002;

// FIX23: Global safety handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED_REJECTION]', { reason: reason?.message || reason, promise });
  // Do NOT exit — log and continue; process manager handles crashes
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT_EXCEPTION]', err);
  // Graceful shutdown — give active requests 5s to complete
  setTimeout(() => process.exit(1), 5000);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log('🚀 Gen Z Digital Store CRM API Server');
  console.log(`${'='.repeat(60)}`);
  console.log(`📡 Running on: http://localhost:${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🗄️  Database: ${DB_NAME}`);
  console.log(`${'='.repeat(60)}\n`);
});

process.on('SIGINT', async () => {
  console.log('\n⚠️  Shutting down gracefully...');
  await mysqlAdapter.close();
  process.exit(0);
});

module.exports = app;
