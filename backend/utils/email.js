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
 * Low-level send. Best-effort: returns { id } on success, { skipped: true } when
 * email is not configured, or { error, status, domainNotVerified } on failure.
 * Never throws.
 */
async function sendEmail({ to, subject, html, text }) {
  const { apiKey, from } = getConfig();
  if (!apiKey || !from) {
    console.warn('[email] RESEND_API_KEY/EMAIL_FROM not configured — skipping email send.');
    return { skipped: true };
  }
  if (!to || !EMAIL_RE.test(String(to))) return { error: 'Invalid recipient email address' };
  if (!subject || (!html && !text)) return { error: 'Email is missing subject or body' };

  // Cap the outbound Resend call. A slow/unreachable email API must never hang the
  // request that triggered it — signup AWAITS this, and without a timeout the await
  // blocked past the client's limit, surfacing to users as
  // "Server is busy, please try again later". 8s keeps signup well under that limit.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
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
    clearTimeout(timer);

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
      console.error(`[email] Resend rejected "${subject}" — HTTP ${resp.status}: ${detail}`);
      const domainNotVerified =
        resp.status === 403 || /not verified|verify (a |your )?domain|domain is not/i.test(detail);
      return { error: detail || `Resend HTTP ${resp.status}`, status: resp.status, domainNotVerified };
    }

    const data = await resp.json().catch(() => ({}));
    return { id: data.id };
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === 'AbortError';
    console.error('[email] Failed to send email:', aborted ? 'timed out after 8s' : err.message);
    return { error: aborted ? 'Email service timed out' : 'Failed to send email' };
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

async function sendVerificationEmail(to, code) {
  const inner = `
    <h1 class="h1" style="margin:0 0 10px;color:${INK};font-size:24px;font-weight:800">Verify your email</h1>
    <p style="margin:0 0 22px;color:${SLATE};font-size:15px;line-height:23px">Welcome to ${BRAND}! Use the code below to verify your email address and activate your account.</p>
    <div style="text-align:center;margin:0 0 18px">
      <div style="display:inline-block;font-size:32px;letter-spacing:10px;font-weight:800;color:${NAVY};background:#f1f6fb;border:1px solid #e3ebf3;border-radius:14px;padding:16px 26px">${code}</div>
    </div>
    <p style="margin:0;color:${MUTED};font-size:13px;line-height:20px">This code expires in 10 minutes and can be used once.</p>
  `;
  const text = `Welcome to ${BRAND}! Your email verification code is ${code}. It expires in 10 minutes and can be used once. If you did not request this, you can ignore this email.`;
  return sendEmail({ to, subject: `${BRAND} — your verification code`, html: emailShell('Your verification code', inner), text });
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

module.exports = {
  isEmailEnabled,
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordResetSuccessEmail,
};
