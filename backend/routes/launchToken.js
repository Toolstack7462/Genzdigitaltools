'use strict';
/**
 * Launch CSRF token endpoint. Mounted at /api/crm/launch-token.
 *
 *   GET / → { success:true, csrfToken } and sets the matching HttpOnly cookie.
 *
 * Deliberately role-agnostic (any authenticated session — client or admin) because both the
 * client tool-launch and the admin "capture session through proxy" launch are cookie-
 * authenticated POSTs that need the same protection. It returns no account data of any kind,
 * so it leaks nothing to a session that is already authenticated.
 *
 * See middleware/csrf.js for why a double-submit token is the right shape here.
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authEnhanced');
const csrf = require('../middleware/csrf');
const { apiLimiter } = require('../middleware/rateLimiter');

router.get('/', apiLimiter, requireAuth, (req, res) => {
  const token = csrf.issue(res);
  // no-store: this response carries a token; it must never sit in a shared/back-forward cache.
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  return res.json({ success: true, csrfToken: token, enforced: csrf.enforcing() });
});

module.exports = router;
