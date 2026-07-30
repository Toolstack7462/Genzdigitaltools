'use strict';

/**
 * Resend email helper.
 *
 * Configuration comes ONLY from environment variables:
 *   RESEND_API_KEY  - Resend API key (secret; never logged)
 *   EMAIL_FROM      - verified "from", e.g. "Gen Z Digital Store <noreply@genzdigitalstore.com>"
 *   FRONTEND_URL    - base URL for links, e.g. https://app.genzdigitalstore.com
 *
 * If RESEND_API_KEY or EMAIL_FROM are missing the helper degrades gracefully
 * (returns { skipped: true }). No OTP codes, reset tokens, passwords, API keys
 * or email bodies are ever logged — only Resend's safe validation message.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_DOMAINS_ENDPOINT = 'https://api.resend.com/domains';
// One-shot guard so a clamped EMAIL_TIMEOUT_MS is reported once at first send, not per email.
let warnedTimeoutClamp = false;

/**
 * TWO TIMEOUT BUDGETS, because there are two genuinely different situations.
 *
 * REQUEST budget (2.5s, ceiling 3s). A send that an HTTP request is WAITING ON must fail
 * inside the web server's worker-kill window, or LiteSpeed kills the worker and serves its
 * own CORS-less 503 instead of our structured error. Measured kills: 3.1s, 5.2s, 5.4s. That
 * is why this cap is aggressive and why it has a hard ceiling.
 *
 * DEFERRED budget (20s, ceiling 60s). Since sends were moved OFF the request path
 * (utils/deferredSend.js), nothing is waiting on them — there is no worker to kill and no
 * 503 to avoid. Applying the request cap to those sends is therefore not protection, it is
 * pure truncation: a healthy send takes ~1.1s, but a merely SLOW one is aborted at 2.5s and
 * the mail is silently lost while the caller has already been told "we're sending". The
 * budget a deferred send needs is "long enough to actually finish", not "short enough to
 * beat a deadline that no longer applies".
 *
 * Module scope so /api/crm/health can report BOTH effective values — without that, a stale
 * env value or an un-landed deploy is invisible from outside while mail quietly fails.
 */
const EMAIL_TIMEOUT_CEILING_MS = 3000;
const EMAIL_TIMEOUT_DEFAULT_MS = 2500;
const DEFERRED_TIMEOUT_CEILING_MS = 60000;
const DEFERRED_TIMEOUT_DEFAULT_MS = 20000;

function resolveTimeoutMs({ deferred = false } = {}) {
  const envRaw = deferred ? process.env.EMAIL_DEFERRED_TIMEOUT_MS : process.env.EMAIL_TIMEOUT_MS;
  const fallback = deferred ? DEFERRED_TIMEOUT_DEFAULT_MS : EMAIL_TIMEOUT_DEFAULT_MS;
  const ceiling = deferred ? DEFERRED_TIMEOUT_CEILING_MS : EMAIL_TIMEOUT_CEILING_MS;
  const requested = Number(envRaw) || fallback;
  return { requested, effective: Math.max(500, Math.min(ceiling, requested)), ceiling, deferred };
}

/** Secret-free view of the mailer's effective configuration, for /api/crm/health. */
function diagnostics() {
  const t = resolveTimeoutMs();
  const d = resolveTimeoutMs({ deferred: true });
  return {
    enabled: isEmailEnabled(),
    // Unchanged field names: existing deploy-verification greps key on these.
    effectiveTimeoutMs: t.effective,
    envTimeoutMs: process.env.EMAIL_TIMEOUT_MS ? t.requested : null,
    ceilingMs: EMAIL_TIMEOUT_CEILING_MS,
    clamped: t.requested > EMAIL_TIMEOUT_CEILING_MS,
    // The budget that actually governs signup/renewal mail, which is sent off-request.
    deferredTimeoutMs: d.effective,
    deferredEnvTimeoutMs: process.env.EMAIL_DEFERRED_TIMEOUT_MS ? d.requested : null,
    deferredCeilingMs: DEFERRED_TIMEOUT_CEILING_MS,
    deferredClamped: d.requested > DEFERRED_TIMEOUT_CEILING_MS,
  };
}

// Public brand assets used inside emails.
const SITE_URL = 'https://genzdigitalstore.com';
const LOGO_URL = `${SITE_URL}/logo-genz-digital-store.png`;
const SUPPORT_WHATSAPP = 'https://wa.me/923027467462';
const BRAND = 'Gen Z Digital Store';
const PROMO =
  'Gen Z Digital Store helps you access premium digital tools, AI productivity support, web services, branding, and digital solutions.';

// Brand palette
const NAVY = '#0B2440';
const NAVY_SOFT = '#13304f';
const TEAL = '#06B6D4';
const INK = '#0f172a';
const SLATE = '#475569';
const MUTED = '#94a3b8';

function getConfig() {
  return {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM,
    frontendUrl: (process.env.FRONTEND_URL || '').replace(/\/+$/, ''),
  };
}

function isEmailEnabled() {
  const { apiKey, from } = getConfig();
  return Boolean(apiKey && from);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Stable, admin-safe failure codes. The caller decides what to show a human; the
 * provider's own wording stays server-side in the log. Named after the generic
 * transport vocabulary (SMTP_*) even though the transport is Resend's HTTP API,
 * so the codes remain meaningful if the provider is ever swapped.
 */
const EMAIL_CODES = {
  CONFIG_MISSING: 'EMAIL_CONFIG_MISSING',
  INVALID_RECIPIENT: 'EMAIL_INVALID_RECIPIENT',
  TEMPLATE_ERROR: 'TEMPLATE_ERROR',
  AUTH_FAILED: 'EMAIL_AUTH_FAILED',
  DOMAIN_UNVERIFIED: 'EMAIL_DOMAIN_UNVERIFIED',
  REJECTED: 'EMAIL_REJECTED',
  SUPPRESSED: 'EMAIL_SUPPRESSED',
  RATE_LIMITED: 'EMAIL_RATE_LIMITED',
  TIMEOUT: 'EMAIL_TIMEOUT',
  PROVIDER_UNAVAILABLE: 'EMAIL_PROVIDER_UNAVAILABLE',
  UNKNOWN: 'EMAIL_SEND_FAILED',
};
// Back-compat aliases. Older call sites and log greps use these NAMES; they now resolve to
// the more precise values above. Kept so a rename can never silently break a caller.
EMAIL_CODES.NOT_CONFIGURED = EMAIL_CODES.CONFIG_MISSING;
EMAIL_CODES.CONNECTION_FAILED = EMAIL_CODES.PROVIDER_UNAVAILABLE;

/**
 * Map a provider HTTP status (+ its safe message) onto a stable code.
 *
 * The distinctions here are the ones an operator ACTS on differently:
 *   401                     → the key is wrong or revoked            (rotate the key)
 *   403 + "not verified"    → the sending domain is not verified     (fix DNS at the provider)
 *   403 other               → this message/recipient was refused
 *   422/400 + suppression   → recipient is on the suppression list   (bounced/complained before)
 *   422/400 other           → this specific message/recipient refused
 *   429                     → throttled                              (back off)
 *   5xx                     → provider outage                        (retry later)
 *
 * Collapsing the domain and suppression cases into the generic buckets — as this used to do —
 * is what makes a delivery outage read as a vague "auth problem" and sends the next person
 * debugging in the wrong direction.
 */
const SUPPRESSION_RE = /suppress|suppression list|previously bounced|on the bounce list|complaint/i;
const UNVERIFIED_RE = /not verified|verify (a |your )?domain|domain is not/i;

function classifyStatus(status, detail = '') {
  if (status === 401) return EMAIL_CODES.AUTH_FAILED;
  if (status === 403) {
    return UNVERIFIED_RE.test(detail) ? EMAIL_CODES.DOMAIN_UNVERIFIED : EMAIL_CODES.REJECTED;
  }
  if (status === 429) return EMAIL_CODES.RATE_LIMITED;
  if (status === 422 || status === 400) {
    if (SUPPRESSION_RE.test(detail)) return EMAIL_CODES.SUPPRESSED;
    if (UNVERIFIED_RE.test(detail)) return EMAIL_CODES.DOMAIN_UNVERIFIED;
    return EMAIL_CODES.REJECTED;
  }
  if (status >= 500) return EMAIL_CODES.PROVIDER_UNAVAILABLE;
  return EMAIL_CODES.UNKNOWN;
}

/**
 * Short, admin-safe sentence per code. Tells the operator what to DO without
 * ever exposing the API key, the recipient list, or the message body.
 */
function adminMessageFor(code) {
  switch (code) {
    case EMAIL_CODES.CONFIG_MISSING:       return 'Email is not configured on the server (RESEND_API_KEY / EMAIL_FROM).';
    case EMAIL_CODES.AUTH_FAILED:          return 'The email provider rejected our API key. Rotate or re-issue RESEND_API_KEY.';
    case EMAIL_CODES.DOMAIN_UNVERIFIED:    return 'The sending domain is not verified at the email provider. Re-check its DNS records.';
    case EMAIL_CODES.PROVIDER_UNAVAILABLE: return 'Could not reach the email provider. It may be down, or outbound network access from this server is blocked.';
    case EMAIL_CODES.REJECTED:             return 'The email provider refused this message or recipient address.';
    case EMAIL_CODES.SUPPRESSED:           return 'This recipient is on the provider suppression list (an earlier message bounced or was marked spam). Remove them there before retrying.';
    case EMAIL_CODES.RATE_LIMITED:         return 'The email provider is rate-limiting us. Wait a moment and retry.';
    case EMAIL_CODES.TIMEOUT:              return 'The email provider did not respond in time. The message was not sent.';
    case EMAIL_CODES.INVALID_RECIPIENT:    return 'That recipient address is not a valid email address.';
    case EMAIL_CODES.TEMPLATE_ERROR:       return 'The email could not be built (missing subject or body).';
    default:                               return 'The email could not be sent. Please try again.';
  }
}

/**
 * Low-level send. Best-effort: returns { id, messageId } on success,
 * { skipped: true, code } when email is not configured, or
 * { error, code, adminMessage, status, domainNotVerified } on failure.
 * Never throws.
 */
async function sendEmail({ to, subject, html, text, deferred = false }) {
  const { apiKey, from } = getConfig();
  if (!apiKey || !from) {
    console.warn('[email] RESEND_API_KEY/EMAIL_FROM not configured — skipping email send.');
    return { skipped: true, code: EMAIL_CODES.CONFIG_MISSING, adminMessage: adminMessageFor(EMAIL_CODES.CONFIG_MISSING) };
  }
  if (!to || !EMAIL_RE.test(String(to))) {
    return { error: 'Invalid recipient email address', code: EMAIL_CODES.INVALID_RECIPIENT, adminMessage: adminMessageFor(EMAIL_CODES.INVALID_RECIPIENT) };
  }
  if (!subject || (!html && !text)) {
    return { error: 'Email is missing subject or body', code: EMAIL_CODES.TEMPLATE_ERROR, adminMessage: adminMessageFor(EMAIL_CODES.TEMPLATE_ERROR) };
  }

  // Cap the outbound Resend call. A slow/unreachable email API must never hang the
  // request that triggered it — signup AWAITS this, and without a timeout the await
  // blocked past the client's limit.
  //
  // WHY 4s AND NOT 8s (measured in production 2026-07-27): when the outbound call to
  // api.resend.com stalls, the web server kills the unresponsive worker after ~4.6-7.2s
  // and serves its OWN 503 page. That page bypasses Express, so it carries no CORS
  // header and no JSON body — the browser reports a CORS error and the UI falls back to
  // a generic message. An 8s cap always lost that race, so the caller never saw a real
  // error. Aborting first means we always return a structured EMAIL_TIMEOUT instead.
  // MEASURED AGAIN 2026-07-28, and the previous 4s cap was still losing the race. Observed
  // time-to-kill on live signups: 3.1s, 5.2s, 5.4s — plus one request that hung to a 504 at
  // 55s. So the cap has to sit BELOW the fastest observed kill (3.1s), or the worker dies
  // before Express can return its structured 502 and LiteSpeed serves the CORS-less 503 page
  // instead. A healthy send completes in ~1.1s, so 2.5s is still >2x headroom.
  //
  // The upper CLAMP is deliberate: a timeout longer than the platform's worker-kill window can
  // never produce a structured error, so it is strictly worse than useless. It exists so a
  // stale EMAIL_TIMEOUT_MS left in the server env (this box has carried one before) cannot
  // silently reintroduce the failure this constant is here to prevent.
  //
  // A DEFERRED send opts into the longer budget: it is already off the request path, so the
  // worker-kill race described above does not apply to it and the short cap would only
  // truncate a send nobody is waiting for. See resolveTimeoutMs().
  const { requested, effective: timeoutMs, ceiling } = resolveTimeoutMs({ deferred });
  if (requested > ceiling && !warnedTimeoutClamp) {
    warnedTimeoutClamp = true;
    const varName = deferred ? 'EMAIL_DEFERRED_TIMEOUT_MS' : 'EMAIL_TIMEOUT_MS';
    console.warn(`[email] ${varName}=${requested}ms exceeds the ${ceiling}ms ceiling and was clamped.`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html, text }),
      signal: controller.signal,
    });
    // NOTE: the timer is NOT cleared here. `fetch` resolves as soon as the RESPONSE HEADERS
    // arrive — the body is still streaming. Clearing the timeout at this point (which is what
    // this code used to do) left every `await resp.json()` / `await body.json()` below
    // completely uncapped, so a connection that delivered headers and then stalled would hang
    // with no abort armed at all. That is the shape of the 55-second 504 observed in
    // production. The abort now stays armed until the body is fully read; `finally` clears it.

    if (!resp.ok) {
      // Resend returns a small JSON error like { statusCode, name, message }.
      // That describes the validation problem (e.g. unverified sending domain)
      // and never contains the API key or the email HTML — safe to log/surface.
      let detail = '';
      try {
        const body = await resp.json();
        detail = [body.name, body.message].filter(Boolean).join(': ') || JSON.stringify(body);
      } catch (_) {
        try { detail = (await resp.text()).slice(0, 300); } catch (_) { /* noop */ }
      }
      const code = classifyStatus(resp.status, detail);
      console.error(`[email] Resend rejected "${subject}" — HTTP ${resp.status} code=${code}: ${detail}`);
      const domainNotVerified =
        resp.status === 403 || /not verified|verify (a |your )?domain|domain is not/i.test(detail);
      return {
        error: detail || `Resend HTTP ${resp.status}`,
        code,
        adminMessage: adminMessageFor(code),
        status: resp.status,
        domainNotVerified,
      };
    }

    // We are past `resp.ok`, so Resend has ALREADY ACCEPTED the message — the 2xx status line
    // is the acceptance. The body only carries the id. So if reading it stalls and the abort
    // fires, the correct answer is "accepted, id unknown", NOT a failure: reporting a failure
    // here would tell the user we could not send a mail that is already on its way, and push
    // them into sending a duplicate. What must never happen is HANGING, and the abort (still
    // armed, see above) now guarantees it returns promptly either way.
    let data = {};
    try {
      data = await resp.json();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        console.warn(`[email] accepted by provider (HTTP ${resp.status}) but the response body stalled and was aborted after ${timeoutMs}ms — send stands, messageId unavailable`);
      }
      data = {};
    }
    // messageId is the provider's own id for this send — the only reliable proof
    // of acceptance, and what we persist for correlation/audit.
    return { id: data.id, messageId: data.id || null };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    const code = aborted ? EMAIL_CODES.TIMEOUT : EMAIL_CODES.PROVIDER_UNAVAILABLE;
    console.error(`[email] Failed to send email code=${code} deferred=${deferred}:`, aborted ? `timed out after ${timeoutMs}ms` : err.message);
    return {
      error: aborted ? 'Email service timed out' : 'Failed to send email',
      code,
      adminMessage: adminMessageFor(code),
    };
  } finally {
    // Single clear point, covering the header wait AND the body read on every path.
    clearTimeout(timer);
  }
}

/**
 * REAL provider check — does not send an email.
 *
 * WHY THIS EXISTS. `isEmailEnabled()` only proves two environment variables are non-empty. It
 * cannot tell a working key from a revoked one, a verified sending domain from an unverified
 * one, or a reachable provider from a server whose outbound network is blocked — and every one
 * of those failures looks identical from outside: mail simply stops arriving while the app
 * reports success. Diagnosing the last outage took hours of black-box probing that this one
 * call answers directly.
 *
 * GET /domains is the cheapest authenticated endpoint that exercises the whole path (DNS →
 * TCP → TLS → auth), costs no send quota, and returns the per-domain verification status.
 *
 * Returns { ok, code, status, latencyMs, domains:[{name,status,region}], adminMessage }.
 * Never throws, never returns the API key, never returns an address.
 */
async function verifyProvider({ timeoutMs } = {}) {
  const { apiKey, from } = getConfig();
  const t0 = Date.now();
  if (!apiKey || !from) {
    return {
      ok: false, code: EMAIL_CODES.CONFIG_MISSING, latencyMs: 0,
      adminMessage: adminMessageFor(EMAIL_CODES.CONFIG_MISSING),
      configured: { apiKey: Boolean(apiKey), from: Boolean(from) },
    };
  }
  // This runs off any user's critical path (admin-triggered / health), so it uses the
  // deferred budget: a check that times out at 2.5s cannot distinguish "slow" from "blocked",
  // which is the exact distinction it exists to make.
  const effective = timeoutMs || resolveTimeoutMs({ deferred: true }).effective;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effective);
  try {
    const resp = await fetch(RESEND_DOMAINS_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    let body = {};
    try { body = await resp.json(); } catch (_) { body = {}; }
    const latencyMs = Date.now() - t0;

    if (!resp.ok) {
      const detail = [body.name, body.message].filter(Boolean).join(': ') || `HTTP ${resp.status}`;
      const code = classifyStatus(resp.status, detail);
      console.error(`[email] provider check FAILED code=${code} status=${resp.status}: ${detail}`);
      return { ok: false, code, status: resp.status, latencyMs, adminMessage: adminMessageFor(code), detail };
    }

    // Safe metadata only: domain name + verification status, never keys or recipients.
    const domains = (Array.isArray(body.data) ? body.data : []).map((d) => ({
      name: d.name, status: d.status, region: d.region,
    }));
    // The from-address domain is the one that actually matters for delivery.
    const fromDomain = String(from).includes('@')
      ? String(from).split('@').pop().replace(/>.*$/, '').trim().toLowerCase()
      : null;
    const sending = domains.find((d) => String(d.name || '').toLowerCase() === fromDomain) || null;
    const sendingVerified = sending ? sending.status === 'verified' : null;

    if (sending && !sendingVerified) {
      return {
        ok: false, code: EMAIL_CODES.DOMAIN_UNVERIFIED, status: resp.status, latencyMs,
        adminMessage: adminMessageFor(EMAIL_CODES.DOMAIN_UNVERIFIED),
        domains, fromDomain, sendingVerified,
      };
    }
    return { ok: true, status: resp.status, latencyMs, domains, fromDomain, sendingVerified };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    const code = aborted ? EMAIL_CODES.TIMEOUT : EMAIL_CODES.PROVIDER_UNAVAILABLE;
    const latencyMs = Date.now() - t0;
    console.error(`[email] provider check FAILED code=${code} after ${latencyMs}ms:`, aborted ? `timed out after ${effective}ms` : err.message);
    return { ok: false, code, latencyMs, adminMessage: adminMessageFor(code) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Branded, mobile-responsive shell ───────────────────────────────────────────

function emailShell(previewText, innerHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${BRAND}</title>
<style>
  @media (max-width:600px){ .card{border-radius:0 !important} .pad{padding:24px 20px !important} .h1{font-size:22px !important} }
  a{ text-decoration:none }
</style>
</head>
<body style="margin:0;padding:0;background:#eef2f7;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eef2f7">${previewText}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:28px 12px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" class="card" style="width:600px;max-width:100%;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(11,36,64,0.10)">
        <!-- Header -->
        <tr>
          <td align="center" style="background:${NAVY};background:linear-gradient(135deg,${NAVY},${NAVY_SOFT});padding:34px 24px 28px">
            <img src="${LOGO_URL}" width="72" height="72" alt="${BRAND}"
                 style="width:72px;height:72px;display:block;margin:0 auto;border:0;outline:none;border-radius:20px;background:#ffffff;padding:12px;box-shadow:0 6px 18px rgba(0,0,0,0.28)" />
            <div style="margin-top:14px;color:#ffffff;font-size:19px;font-weight:800;letter-spacing:0.3px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif">${BRAND}</div>
          </td>
        </tr>
        <tr><td style="height:4px;background:linear-gradient(90deg,${TEAL},#2563EB)"></td></tr>

        <!-- Body -->
        <tr><td class="pad" style="padding:36px 40px">
          ${innerHtml}
        </td></tr>

        <!-- Promo / support -->
        <tr><td style="padding:0 40px 8px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f6fb;border:1px solid #e3ebf3;border-radius:14px">
            <tr><td style="padding:18px 20px">
              <p style="margin:0 0 12px;color:${SLATE};font-size:13px;line-height:20px">${PROMO}</p>
              <a href="${SUPPORT_WHATSAPP}" style="display:inline-block;background:#25D366;color:#ffffff;font-size:13px;font-weight:700;padding:9px 16px;border-radius:10px">Chat with us on WhatsApp</a>
              <a href="${SITE_URL}" style="display:inline-block;margin-left:8px;color:${NAVY};font-size:13px;font-weight:700;padding:9px 12px">Visit website →</a>
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td align="center" style="padding:18px 40px 30px">
          <p style="margin:0;color:${MUTED};font-size:12px;line-height:18px">
            If you did not request this, you can safely ignore this email.<br>
            © ${new Date().getFullYear()} ${BRAND}. All rights reserved.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(href, label) {
  return `<a href="${href}" style="display:inline-block;background:${TEAL};background:linear-gradient(135deg,#2563EB,${TEAL});color:#ffffff;font-size:15px;font-weight:700;padding:14px 30px;border-radius:12px">${label}</a>`;
}

// ─── Email types ────────────────────────────────────────────────────────────────

async function sendVerificationEmail(to, code, { deferred = false } = {}) {
  const inner = `
    <h1 class="h1" style="margin:0 0 10px;color:${INK};font-size:24px;font-weight:800">Verify your email</h1>
    <p style="margin:0 0 22px;color:${SLATE};font-size:15px;line-height:23px">Welcome to ${BRAND}! Use the code below to verify your email address and activate your account.</p>
    <div style="text-align:center;margin:0 0 18px">
      <div style="display:inline-block;font-size:32px;letter-spacing:10px;font-weight:800;color:${NAVY};background:#f1f6fb;border:1px solid #e3ebf3;border-radius:14px;padding:16px 26px">${code}</div>
    </div>
    <p style="margin:0;color:${MUTED};font-size:13px;line-height:20px">This code expires in 10 minutes and can be used once.</p>
  `;
  const text = `Welcome to ${BRAND}! Your email verification code is ${code}. It expires in 10 minutes and can be used once. If you did not request this, you can ignore this email.`;
  return sendEmail({ to, subject: `${BRAND} — your verification code`, html: emailShell('Your verification code', inner), text, deferred });
}

async function sendPasswordResetEmail(to, resetUrl) {
  const inner = `
    <h1 class="h1" style="margin:0 0 10px;color:${INK};font-size:24px;font-weight:800">Reset your password</h1>
    <p style="margin:0 0 24px;color:${SLATE};font-size:15px;line-height:23px">We received a request to reset the password for your ${BRAND} account. Click the button below to choose a new password.</p>
    <div style="text-align:center;margin:0 0 24px">${button(resetUrl, 'Reset Password')}</div>
    <p style="margin:0 0 8px;color:${SLATE};font-size:13px;line-height:20px">If the button doesn't work, copy and paste this link into your browser:</p>
    <p style="margin:0 0 22px;font-size:13px;line-height:20px;word-break:break-all"><a href="${resetUrl}" style="color:#2563EB">${resetUrl}</a></p>
    <p style="margin:0;color:${MUTED};font-size:13px;line-height:20px">This link expires in 30 minutes and can be used once.</p>
  `;
  const text = `Reset your ${BRAND} password using this link: ${resetUrl}\nThis link expires in 30 minutes and can be used once. If you did not request this, you can ignore this email.`;
  return sendEmail({ to, subject: `${BRAND} — reset your password`, html: emailShell('Reset your password', inner), text });
}

async function sendPasswordResetSuccessEmail(to) {
  const { frontendUrl } = getConfig();
  const loginUrl = frontendUrl ? `${frontendUrl}/client/login` : `${SITE_URL}`;
  const inner = `
    <h1 class="h1" style="margin:0 0 10px;color:${INK};font-size:24px;font-weight:800">Your password was changed</h1>
    <p style="margin:0 0 24px;color:${SLATE};font-size:15px;line-height:23px">Your ${BRAND} account password was changed successfully. If this was you, no further action is needed.</p>
    <div style="text-align:center;margin:0 0 22px">${button(loginUrl, 'Go to Member Login')}</div>
    <p style="margin:0;color:${MUTED};font-size:13px;line-height:20px">If you did not make this change, please contact our support right away using the WhatsApp button below.</p>
  `;
  const text = `Your ${BRAND} password was changed successfully. If this wasn't you, contact support immediately. Login: ${loginUrl}`;
  return sendEmail({ to, subject: `${BRAND} — your password was changed`, html: emailShell('Your password was changed', inner), text });
}

// Minimal HTML escape for admin-entered tool names rendered inside the email.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renewal reminder — admin-triggered (manual, never automatic) email listing the
 * client's tools that are expiring soon or already expired, with a renew/contact
 * CTA. Reuses the branded shell. `tools` = [{ toolName, endDate, daysLeft, expired }]
 * (the shape the renewals engine produces; legacy `name` is still accepted).
 * `renewUrl` defaults to the support WhatsApp. Safe content only — no secrets.
 */
// Optional admin-controlled retention offer line (NEVER auto-applied — the admin
// explicitly chooses an offer per send). Plain, professional wording.
function offerClause(offer) {
  if (offer === 'discount10') return 'To help you continue without interruption, we can offer you a limited <strong>10% renewal discount valid for the next 48 hours</strong>.';
  if (offer === 'bonus2') return 'Renew now and we\'ll add <strong>2 bonus days of access</strong> on us, as a thank-you.';
  return '';
}

async function sendRenewalReminderEmail(to, { clientName, tools = [], renewUrl, offer = 'none', deferred = false } = {}) {
  const cta = renewUrl || SUPPORT_WHATSAPP;
  const anyExpired = tools.some(t => t.expired);
  const offerLine = offerClause(offer);
  const rows = (tools || []).map(t => {
    const when = t.endDate
      ? new Date(t.endDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : '—';
    const label = t.expired
      ? 'Expired'
      : (t.daysLeft === 0 ? 'Expires today' : `${t.daysLeft} day${t.daysLeft === 1 ? '' : 's'} left`);
    const color = t.expired ? '#dc2626' : (typeof t.daysLeft === 'number' && t.daysLeft <= 3 ? '#d97706' : '#0891b2');
    return `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid #eef2f7;color:${INK};font-size:14px;font-weight:600">${esc(t.toolName || t.name || 'Tool')}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #eef2f7;color:${SLATE};font-size:13px">${when}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #eef2f7;color:${color};font-size:13px;font-weight:700;text-align:right;white-space:nowrap">${label}</td>
    </tr>`;
  }).join('');
  const heading = anyExpired ? 'Your access needs renewal' : 'Your access is expiring soon';
  const inner = `
    <h1 class="h1" style="margin:0 0 10px;color:${INK};font-size:24px;font-weight:800">${heading}</h1>
    <p style="margin:0 0 20px;color:${SLATE};font-size:15px;line-height:23px">Hi ${esc(clientName || 'there')}, this is a friendly reminder from ${BRAND} about the following ${tools.length === 1 ? 'tool' : 'tools'} on your account. Renew to keep uninterrupted access.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3ebf3;border-radius:12px;overflow:hidden;margin:0 0 ${offerLine ? '18px' : '24px'}">
      <tr style="background:#f1f6fb">
        <th align="left" style="padding:10px 14px;color:${SLATE};font-size:12px;text-transform:uppercase;letter-spacing:0.04em">Tool</th>
        <th align="left" style="padding:10px 14px;color:${SLATE};font-size:12px;text-transform:uppercase;letter-spacing:0.04em">Expiry</th>
        <th align="right" style="padding:10px 14px;color:${SLATE};font-size:12px;text-transform:uppercase;letter-spacing:0.04em">Status</th>
      </tr>
      ${rows}
    </table>
    ${offerLine ? `<p style="margin:0 0 22px;color:${INK};font-size:14px;line-height:22px;background:#f1f6fb;border:1px solid #e3ebf3;border-radius:12px;padding:14px 16px">${offerLine}</p>` : ''}
    <div style="text-align:center;margin:0 0 8px">${button(cta, 'Renew / Contact Us')}</div>
  `;
  const textLines = (tools || []).map(t => `- ${t.toolName || t.name || 'Tool'}: ${t.expired ? 'Expired' : (t.daysLeft === 0 ? 'expires today' : `${t.daysLeft} days left`)}${t.endDate ? ` (${new Date(t.endDate).toLocaleDateString('en-US')})` : ''}`);
  const offerText = offer === 'discount10' ? '\nOffer: a limited 10% renewal discount valid for the next 48 hours.'
    : offer === 'bonus2' ? '\nOffer: renew now and we will add 2 bonus days of access.' : '';
  const text = `Hi ${clientName || 'there'}, a renewal reminder from ${BRAND}:\n${textLines.join('\n')}${offerText}\nRenew / contact us: ${cta}`;
  return sendEmail({ to, subject: `${BRAND} — renewal reminder`, html: emailShell('Renewal reminder', inner), text, deferred });
}

/**
 * Marketing offer email — admin-triggered (manual) promo for one client: combo
 * bundle / renewal / upgrade / recovery. Reuses the branded shell. Safe content
 * only (title/description/tools/price/expiry) — no secrets; never auto-sent.
 * `offer` = { title, description, toolNames[], priceText, expiryDate, kind }.
 */
async function sendOfferEmail(to, { clientName, offer = {}, ctaUrl } = {}) {
  const cta = ctaUrl || SUPPORT_WHATSAPP;
  const tools = Array.isArray(offer.toolNames) ? offer.toolNames.filter(Boolean) : [];
  const expiry = offer.expiryDate ? new Date(offer.expiryDate) : null;
  const expiryStr = expiry && !isNaN(expiry.getTime())
    ? expiry.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const inner = `
    <h1 class="h1" style="margin:0 0 10px;color:${INK};font-size:24px;font-weight:800">${esc(offer.title || 'A special offer for you')}</h1>
    <p style="margin:0 0 18px;color:${SLATE};font-size:15px;line-height:23px">Hi ${esc(clientName || 'there')}, here's an offer from ${BRAND}${offer.description ? ':' : '.'}</p>
    ${offer.description ? `<p style="margin:0 0 18px;color:${SLATE};font-size:14px;line-height:22px">${esc(offer.description)}</p>` : ''}
    ${tools.length ? `<p style="margin:0 0 10px;color:${SLATE};font-size:13px"><b style="color:${INK}">Included:</b> ${tools.map(esc).join(' · ')}</p>` : ''}
    ${offer.priceText ? `<div style="text-align:center;margin:0 0 18px"><span style="display:inline-block;background:#f1f6fb;border:1px solid #e3ebf3;border-radius:12px;padding:12px 22px;color:${NAVY};font-size:18px;font-weight:800">${esc(offer.priceText)}</span></div>` : ''}
    ${expiryStr ? `<p style="margin:0 0 18px;color:${MUTED};font-size:13px">Offer valid until ${expiryStr}.</p>` : ''}
    <div style="text-align:center;margin:0 0 8px">${button(cta, 'Claim this offer')}</div>
  `;
  const text = `Hi ${clientName || 'there'}, an offer from ${BRAND}: ${offer.title || ''}.`
    + (offer.description ? `\n${offer.description}` : '')
    + (tools.length ? `\nIncluded: ${tools.join(', ')}` : '')
    + (offer.priceText ? `\n${offer.priceText}` : '')
    + (expiryStr ? `\nValid until ${expiryStr}.` : '')
    + `\nClaim it: ${cta}`;
  return sendEmail({ to, subject: `${BRAND} — ${offer.title || 'a special offer'}`, html: emailShell(offer.title || 'A special offer', inner), text });
}

module.exports = {
  EMAIL_CODES,
  classifyStatus,
  adminMessageFor,
  isEmailEnabled,
  diagnostics,
  resolveTimeoutMs,
  verifyProvider,
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordResetSuccessEmail,
  sendRenewalReminderEmail,
  sendOfferEmail,
};
