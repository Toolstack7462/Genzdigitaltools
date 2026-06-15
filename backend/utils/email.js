'use strict';

/**
 * Resend email helper.
 *
 * Configuration comes ONLY from environment variables:
 *   RESEND_API_KEY  - Resend API key (secret; never logged)
 *   EMAIL_FROM      - verified "from" address, e.g. "Genz Digital Store <noreply@genzdigitalstore.com>"
 *   FRONTEND_URL    - base URL used to build links, e.g. https://app.genzdigitalstore.com
 *
 * If RESEND_API_KEY or EMAIL_FROM are missing the helper degrades gracefully
 * (returns { skipped: true }) so existing deployments keep working without email.
 * No OTP codes, reset tokens, passwords or secrets are ever logged.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

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

/**
 * Low-level send. Best-effort: returns { id } on success, { skipped: true } when
 * email is not configured, or { error: <generic message> } on failure. Never
 * throws, so a mail failure can't break the surrounding request.
 */
async function sendEmail({ to, subject, html }) {
  const { apiKey, from } = getConfig();
  if (!apiKey || !from) {
    console.warn('[email] RESEND_API_KEY/EMAIL_FROM not configured — skipping email send.');
    return { skipped: true };
  }
  try {
    const resp = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!resp.ok) {
      // Log status only — never the body (could echo sensitive content) or the key.
      console.error(`[email] Resend responded with HTTP ${resp.status} for "${subject}".`);
      return { error: 'Email provider rejected the request' };
    }
    const data = await resp.json().catch(() => ({}));
    return { id: data.id };
  } catch (err) {
    console.error('[email] Failed to send email:', err.message);
    return { error: 'Failed to send email' };
  }
}

// ─── Branded templates ─────────────────────────────────────────────────────────

const BRAND = 'Genz Digital Store';

function shell(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f6f8fb;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
    <div style="max-width:520px;margin:0 auto;padding:32px 16px">
      <div style="background:#ffffff;border:1px solid #e6eaf0;border-radius:16px;padding:32px">
        <h1 style="margin:0 0 8px;font-size:20px;color:#0f172a">${BRAND}</h1>
        <h2 style="margin:0 0 16px;font-size:16px;color:#334155;font-weight:600">${title}</h2>
        ${bodyHtml}
      </div>
      <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:16px">
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>
  </body></html>`;
}

function btn(href, label) {
  return `<a href="${href}" style="display:inline-block;background:#0ea5a4;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:12px;font-weight:600">${label}</a>`;
}

async function sendVerificationEmail(to, code) {
  const html = shell('Verify your email', `
    <p style="margin:0 0 16px;color:#475569">Use this code to verify your email address. It expires in 10 minutes.</p>
    <div style="font-size:30px;letter-spacing:8px;font-weight:700;color:#0f172a;background:#f1f5f9;border-radius:12px;padding:16px;text-align:center">${code}</div>
    <p style="margin:16px 0 0;color:#94a3b8;font-size:13px">Enter this code on the verification screen to activate your account.</p>
  `);
  return sendEmail({ to, subject: `${BRAND} — your verification code`, html });
}

async function sendPasswordResetEmail(to, resetUrl) {
  const html = shell('Reset your password', `
    <p style="margin:0 0 20px;color:#475569">We received a request to reset your password. Click the button below to choose a new one. This link expires in 30 minutes and can be used once.</p>
    <p style="margin:0 0 20px">${btn(resetUrl, 'Reset password')}</p>
    <p style="margin:0;color:#94a3b8;font-size:13px;word-break:break-all">Or paste this link into your browser:<br>${resetUrl}</p>
  `);
  return sendEmail({ to, subject: `${BRAND} — reset your password`, html });
}

async function sendPasswordResetSuccessEmail(to) {
  const { frontendUrl } = getConfig();
  const loginUrl = frontendUrl ? `${frontendUrl}/client/login` : '';
  const html = shell('Your password was changed', `
    <p style="margin:0 0 20px;color:#475569">Your password was changed successfully. If this was you, no further action is needed.</p>
    ${loginUrl ? `<p style="margin:0 0 20px">${btn(loginUrl, 'Go to login')}</p>` : ''}
    <p style="margin:0;color:#94a3b8;font-size:13px">If you did not make this change, please contact support immediately.</p>
  `);
  return sendEmail({ to, subject: `${BRAND} — your password was changed`, html });
}

module.exports = {
  isEmailEnabled,
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordResetSuccessEmail,
};
