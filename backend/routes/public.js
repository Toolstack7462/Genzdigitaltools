const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const Blog = require('../models/Blog');
const Contact = require('../models/Contact');
const User = require('../models/User');
const EmailVerification = require('../models/EmailVerification');
const { sendVerificationEmail, isEmailEnabled } = require('../utils/email');
const { normalizeAuthInputs } = require('../middleware/normalize');
const {
  normalizeEmail, emailMatch, isValidEmail, classifyExisting, RESEND_COOLDOWN_MS,
} = require('../utils/signupPolicy');

const maskE = (e) => { const s = String(e || ''); const at = s.indexOf('@'); return at <= 0 ? (s ? '***' : '(none)') : s[0] + '***' + s.slice(at); };

// POST /api/crm/public/register - Public client registration
//
// ORDER MATTERS. Nothing is written to `users` here. The flow is:
//   pending registration (hashed OTP) → send the email → only report "code sent"
//   once the provider ACCEPTED it. The account itself is created by
//   POST /auth/verify-email, and only after the correct code is presented.
//
// This replaces the previous "create the account first, email best-effort after"
// order, which produced active unverified accounts whenever mail delivery failed
// and then permanently blocked the retry with "Email already exists".
router.post('/register', normalizeAuthInputs, async (req, res) => {
  const t0 = Date.now(); // [signup-diag] total request timing
  try {
    const { fullName, password } = req.body;
    const email = normalizeEmail(req.body && req.body.email);
    console.log(`[signup] stage=attempt rid=${req.requestId || ''} email=${maskE(email)}`);

    // Validation
    if (!fullName || !email || !password) {
      return res.status(400).json({
        error: 'Full name, email, and password are required',
        code: 'SIGNUP_VALIDATION',
      });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address', code: 'SIGNUP_VALIDATION' });
    }
    if (password.length < 6) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters',
        code: 'SIGNUP_VALIDATION',
      });
    }

    if (!isEmailEnabled()) {
      // Without a mailer we cannot verify anyone, and we refuse to fall back to
      // creating an unverified account — that is the bug being fixed.
      console.error('[signup] stage=email result=not_configured');
      return res.status(503).json({
        error: 'We cannot send verification emails right now. Please try again shortly.',
        code: 'EMAIL_NOT_CONFIGURED',
      });
    }

    // Case-insensitive existence check. A bare findOne({email}) resolves through the
    // adapter's case-SENSITIVE compare and misses legacy rows, which is how duplicate
    // accounts got created for the same person.
    const existingUser = await User.findOne({ email: emailMatch(email) });
    const kind = classifyExisting(existingUser);

    if (kind === 'verified') {
      // A proven account. Never modify it, never leak more than the caller already knows.
      console.log(`[signup] stage=exists_verified rid=${req.requestId || ''} email=${maskE(email)}`);
      return res.status(409).json({
        error: 'An account with this email already exists. Please log in, or use "forgot password" if you need a new one.',
        code: 'ACCOUNT_EXISTS',
      });
    }

    if (kind === 'unverified') {
      // Legacy account created by the OLD flow (or an interrupted one). Let the real
      // owner finish verifying — but do NOT touch the stored password: these accounts
      // can already log in, so accepting a new password here would be account takeover.
      const { code } = await EmailVerification.issueOtp({ userId: existingUser._id, email });
      const r = await sendVerificationEmail(email, code);
      if (r.error || r.skipped) {
        console.error(`[signup] stage=email result=failed kind=legacy code=${r.code || 'UNKNOWN'}`);
        return res.status(502).json({
          error: 'We could not send your verification code. Please try again in a moment.',
          code: r.code || 'EMAIL_SEND_FAILED',
        });
      }
      console.log(`[signup] stage=resume_legacy rid=${req.requestId || ''} email=${maskE(email)} ms=${Date.now() - t0}`);
      return res.status(200).json({
        success: true,
        emailVerificationRequired: true,
        resumed: true,
        code: 'VERIFICATION_RESUMED',
        message: 'This email is already registered but not verified. We just sent you a new code — enter it to finish, then log in with your existing password.',
      });
    }

    // ── No account exists: pending registration only ─────────────────────────
    // Hash now so the plaintext password never reaches storage, not even the
    // pending record. User.preSave detects an existing bcrypt hash and will not
    // re-hash it when the account is finally created.
    const passwordHash = await bcrypt.hash(password, 12);

    const issued = await EmailVerification.issueSignupOtp({
      email,
      fullName: String(fullName).trim(),
      passwordHash,
    });

    if (issued.cooldownMs) {
      const retryAfter = Math.ceil(issued.cooldownMs / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: `Please wait ${retryAfter}s before requesting another code.`,
        code: 'RESEND_COOLDOWN',
        retryAfterSeconds: retryAfter,
      });
    }
    if (issued.sendsExhausted) {
      return res.status(429).json({
        error: 'Too many codes requested for this email. Please try again later.',
        code: 'RESEND_LIMIT',
        retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_MS / 1000),
      });
    }

    // Send BEFORE reporting success. If this fails we report failure and no account
    // exists — the pending record stays 'active' so the very next attempt just
    // re-issues a code (a failed send never consumes the cooldown or send budget).
    const te = Date.now();
    const r = await sendVerificationEmail(email, issued.code);
    if (r.error || r.skipped) {
      console.error(`[signup] stage=email result=failed rid=${req.requestId || ''} code=${r.code || 'UNKNOWN'} emailMs=${Date.now() - te}`);
      return res.status(502).json({
        error: 'We could not send your verification code. Please check the address and try again.',
        code: r.code || 'EMAIL_SEND_FAILED',
      });
    }
    await EmailVerification.markSignupSent(email);
    console.log(`[signup] stage=email result=sent rid=${req.requestId || ''} email=${maskE(email)} msgId=${r.messageId || '-'} emailMs=${Date.now() - te} totalMs=${Date.now() - t0}`);

    // 202 Accepted: the registration is pending verification, NOT created.
    return res.status(202).json({
      success: true,
      emailVerificationRequired: true,
      code: 'VERIFICATION_SENT',
      message: 'Check your email for a 6-digit verification code to finish creating your account.',
    });
  } catch (error) {
    // [signup-diag] Capture the EXACT failure point + timing + error so a generic
    // "Server is busy" / "Registration failed" is never a mystery again.
    console.error(`[signup] stage=error rid=${req.requestId || ''} totalMs=${Date.now() - t0} name=${error && error.name} code=${error && (error.code || error.errno)} msg=${error && error.message}`);
    console.error(error && error.stack ? error.stack : error);

    // Handle validation errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({ error: errors.join(', '), code: 'SIGNUP_VALIDATION' });
    }

    // Duplicate email — Mongo (11000) OR MySQL (errno 1062 / ER_DUP_ENTRY). The old
    // check only handled the Mongo code, which never fires on this MySQL adapter.
    if (error.code === 11000 || error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
      return res.status(409).json({ error: 'An account with this email already exists', code: 'SIGNUP_DUPLICATE' });
    }

    res.status(500).json({ error: 'Registration failed. Please try again.', code: 'SIGNUP_SERVER_ERROR' });
  }
});

// GET /api/crm/public/blog - Get published blog posts
router.get('/blog', async (req, res) => {
  try {
    const { 
      category, 
      tag,
      search,
      page = 1,
      limit = 10,
      featured
    } = req.query;
    
    const query = { status: 'published' };
    
    if (category) query.category = category;
    if (tag) query.tags = tag;
    if (featured === 'true') query.featured = true;
    
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { excerpt: { $regex: search, $options: 'i' } }
      ];
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [posts, totalCount] = await Promise.all([
      Blog.find(query)
        .select('title slug excerpt coverImage category tags publishedAt views featured')
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('author', 'fullName'),
      Blog.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      posts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        totalCount,
        totalPages: Math.ceil(totalCount / parseInt(limit)),
        hasMore: skip + posts.length < totalCount
      }
    });
  } catch (error) {
    console.error('Get public blog posts error:', error);
    res.status(500).json({ error: 'Failed to fetch blog posts' });
  }
});

// GET /api/crm/public/blog/categories - Get blog categories with counts
router.get('/blog/categories', async (req, res) => {
  try {
    const categories = await Blog.aggregate([
      { $match: { status: 'published' } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    
    res.json({
      success: true,
      categories
    });
  } catch (error) {
    console.error('Get blog categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// GET /api/crm/public/blog/:slug - Get single blog post by slug
router.get('/blog/:slug', async (req, res) => {
  try {
    const post = await Blog.findOne({ 
      slug: req.params.slug,
      status: 'published'
    }).populate('author', 'fullName');
    
    if (!post) {
      return res.status(404).json({ error: 'Blog post not found' });
    }
    
    // Increment view count
    post.views += 1;
    await post.save();
    
    // Get related posts
    const relatedPosts = await Blog.find({
      _id: { $ne: post._id },
      status: 'published',
      $or: [
        { category: post.category },
        { tags: { $in: post.tags } }
      ]
    })
      .select('title slug excerpt coverImage publishedAt')
      .limit(3)
      .sort({ publishedAt: -1 });
    
    res.json({
      success: true,
      post,
      relatedPosts
    });
  } catch (error) {
    console.error('Get blog post error:', error);
    res.status(500).json({ error: 'Failed to fetch blog post' });
  }
});

// POST /api/crm/public/contact - Submit contact form
router.post('/contact', async (req, res) => {
  try {
    const { name, email, phone, subject, message } = req.body;
    
    // Validation
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ 
        error: 'Name, email, subject, and message are required' 
      });
    }
    
    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    
    // Get client info
    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                      req.socket?.remoteAddress || 
                      'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    const contact = await Contact.create({
      name,
      email,
      phone,
      subject,
      message,
      ipAddress,
      userAgent,
      status: 'new',
      priority: 'medium'
    });
    
    res.status(201).json({
      success: true,
      message: 'Thank you for contacting us! We will get back to you soon.',
      contactId: contact._id
    });
  } catch (error) {
    console.error('Submit contact error:', error);
    res.status(500).json({ error: 'Failed to submit contact form' });
  }
});

// GET /api/crm/public/tools - Get public tools listing
router.get('/tools', async (req, res) => {
  try {
    const Tool = require('../models/Tool');
    
    const { category, search } = req.query;
    
    const query = { status: 'active' };
    
    if (category) query.category = category;
    
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }
    
    const tools = await Tool.find(query)
      .select('name description category targetUrl')
      .sort({ name: 1 });
    
    res.json({
      success: true,
      tools
    });
  } catch (error) {
    console.error('Get public tools error:', error);
    res.status(500).json({ error: 'Failed to fetch tools' });
  }
});

module.exports = router;
