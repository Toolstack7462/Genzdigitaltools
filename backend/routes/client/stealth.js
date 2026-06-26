'use strict';
/**
 * Client routes for the StealthWriter Proxy Gateway module.
 * Mounted at /api/crm/client/stealth.
 *
 *  GET  /          → dashboard data (plan, status, expiry, used/remaining, reset time)
 *  POST /open      → validate status/expiry/limits, mint a signed lease, return the
 *                    gateway open URL (https://stealth1.genzdigitalstore.com/gateway?lease=…)
 */
const express = require('express');
const router = express.Router();

const StealthClient = require('../../models/stealth/StealthClient');
const StealthLease = require('../../models/stealth/StealthLease');
const StealthAccount = require('../../models/stealth/StealthAccount');
const ActivityLog = require('../../models/ActivityLog');
const { requireAuth, requireRole, getClientIp } = require('../../middleware/authEnhanced');
const access = require('../../utils/stealth/access');
const config = require('../../utils/stealth/config');
const accountSelect = require('../../utils/stealth/accountSelect');
const lease = require('../../utils/stealth/lease');
const { nextResetAt, RESET_LABEL } = require('../../utils/stealth/time');

// Human-readable phrasing for a pinned account's health (no secrets) — used in
// the client-facing "your assigned account is currently …" message.
const HEALTH_TEXT = {
  working: 'available',
  needs_login: 'in need of re-login',
  expired: 'expired (needs re-login)',
  blocked: 'blocked',
  limit_reached: 'at its usage limit',
  needs_verification: 'pending verification',
  missing: 'no longer available',
};

router.use(requireAuth);
router.use(requireRole('CLIENT'));

// ─── Dashboard ────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const client = await StealthClient.findOne({ userId: req.userId });
    if (!client) {
      return res.json({ success: true, hasPlan: false, resetLabel: RESET_LABEL });
    }
    const snap = await access.snapshot(client);
    return res.json({
      success: true,
      hasPlan: true,
      plan: {
        planName: client.planName,
        status: snap.status,
        active: snap.active,
        expired: snap.expired,
        expiryDate: snap.expiryDate,
        limits: snap.limits,
        used: snap.used,
        remaining: snap.remaining,
      },
      resetLabel: RESET_LABEL,
      nextResetAt: nextResetAt(),
    });
  } catch (err) {
    console.error('Stealth client dashboard error:', err.message);
    return res.status(500).json({ error: 'Failed to load StealthWriter dashboard' });
  }
});

// ─── Open StealthWriter (mint a lease) ──────────────────────────────────────────
router.post('/open', async (req, res) => {
  try {
    const client = await StealthClient.findOne({ userId: req.userId });
    if (!client) return res.status(404).json({ error: 'No StealthWriter plan assigned', code: 'no_plan' });

    // Re-validate against the database (single source of truth) — never trust the client.
    const snap = await access.snapshot(client);
    if (!snap.active) {
      const code = snap.expired ? 'plan_expired' : 'client_disabled';
      return res.status(403).json({ error: snap.expired ? 'Your StealthWriter plan has expired' : 'Your StealthWriter access is disabled', code });
    }
    // Block opening only when there is no usable capacity at all today.
    const hRem = snap.remaining.humanizer; // null = unlimited
    const dRem = snap.remaining.detector;
    const noCapacity = (hRem !== null && hRem <= 0) && (dRem !== null && dRem <= 0);
    if (noCapacity) {
      return res.status(403).json({ error: 'Daily limit reached for both Humanizer and AI Detector', code: 'limit_reached' });
    }

    const settings = await config.getSettingsObject();

    // ── Account Vault selection (multi-account) ──────────────────────────────
    // Pick one of the operator's own active StealthWriter accounts for this lease.
    // If the vault is empty we proceed without an account (legacy: manual login in
    // the gateway). If accounts exist but none are active, block — admin must
    // refresh a session or mark an account active.
    const accounts = await StealthAccount.find({});
    let account = null;
    if (accounts.length > 0) {
      // Honor an optional per-client pin. With mode 'auto' (the default) this is
      // identical to the previous global-pool selection.
      const sel = accountSelect.selectAccountForClient(accounts, settings.accountSelectionMode, {
        mode: client.accountPinMode,
        accountId: client.pinnedAccountId,
      });
      account = sel.account;

      if (!account) {
        if (sel.source === 'pinned_unavailable') {
          // 'Specific account only' and that account is expired/blocked/limit
          // reached/needs login → clear status, NO fallback, NO bypass.
          await ActivityLog.log('CLIENT', req.userId, 'STEALTH_PINNED_ACCOUNT_UNAVAILABLE', {
            stealthClientId: client._id, accountId: client.pinnedAccountId, accountLabel: client.pinnedAccountLabel,
            reason: sel.pinnedReason, health: sel.pinnedHealth, ip: getClientIp(req),
          });
          const label = client.pinnedAccountLabel || 'assigned account';
          return res.status(503).json({
            error: `Your assigned StealthWriter account (${label}) is currently ${HEALTH_TEXT[sel.pinnedHealth] || 'unavailable'}. Please contact support.`,
            code: 'pinned_account_unavailable',
            accountStatus: sel.pinnedHealth || 'unavailable',
          });
        }
        // No usable account anywhere (covers pin mode 'specific_or_auto' with an
        // empty pool too). Safe per-account reasons for admin logs (no secrets).
        const reasons = accounts.map(a => ({ account_id: a._id, account_label: a.label, reason: accountSelect.unavailableReason(a) }));
        await ActivityLog.log('CLIENT', req.userId, 'STEALTH_NO_ACCOUNT_AVAILABLE', { reasons, ip: getClientIp(req) });
        return res.status(503).json({
          error: 'No StealthWriter account is currently available. Please try again shortly.',
          code: 'no_account_available',
        });
      }

      // Pinned account was down and we fell back to the pool — record it for
      // admin visibility (label-only, no secrets).
      if (sel.source === 'fallback') {
        await ActivityLog.log('CLIENT', req.userId, 'STEALTH_PINNED_FALLBACK', {
          stealthClientId: client._id,
          pinnedAccountId: client.pinnedAccountId, pinnedAccountLabel: client.pinnedAccountLabel,
          reason: sel.pinnedReason, fallbackAccountId: account._id, fallbackAccountLabel: account.label,
          ip: getClientIp(req),
        });
      }
    }

    const ttlMinutes = config.effectiveLeaseMinutes(settings);
    const fixed = settings.fixedLeaseEnabled;
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + ttlMinutes * 60 * 1000);

    // Create the lease row first so its id becomes the token's jti.
    const leaseRow = await StealthLease.create({
      userId: req.userId,
      stealthClientId: client._id,
      accountId: account ? account._id : null,
      accountLabel: account ? account.label : null, // denormalized for admin logs (label only, no secrets)
      issuedAt, expiresAt,
      fixedLease: fixed,
      revoked: false,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || '',
    });

    // Record usage on the selected account (for round-robin / least-used).
    if (account) {
      account.usageCount = Number(account.usageCount || 0) + 1;
      account.lastUsedAt = issuedAt;
      await account.save();
    }

    const token = lease.signLease({
      jti: leaseRow._id,
      userId: req.userId,
      stealthClientId: client._id,
      accountId: account ? account._id : undefined,
      fixed,
      ttlMinutes,
    });
    // Store only the hash — never the raw token.
    leaseRow.tokenHash = lease.hashToken(token);
    await leaseRow.save();

    await ActivityLog.log('CLIENT', req.userId, 'STEALTH_LEASE_ISSUED', {
      stealthClientId: client._id, leaseId: leaseRow._id, ttlMinutes, fixed,
      accountId: account ? account._id : null, accountLabel: account ? account.label : null,
      ip: getClientIp(req),
    });

    return res.json({
      success: true,
      url: lease.gatewayUrl(token),
      lease: { id: leaseRow._id, expiresAt, durationMinutes: ttlMinutes, fixedLease: fixed },
    });
  } catch (err) {
    console.error('Stealth open error:', err.message);
    return res.status(500).json({ error: 'Failed to open StealthWriter' });
  }
});

module.exports = router;
