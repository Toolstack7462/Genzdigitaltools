// Renders the friendly expired screen. TWO completely separate cases, decided by the
// `reason` query param (no secrets):
//   • SESSION expired  → 20-min idle timeout (reason=idle_timeout). The subscription is
//                        still active; just relaunch from the dashboard. "Go to Dashboard".
//   • SUBSCRIPTION/ASSIGNMENT expired → backend-confirmed (reason=expired/revoked/removed/
//                        blocked/…). "Renew your plan" via WhatsApp support.
// The idle path must NEVER show the renew/subscription message. CSP forbids inline scripts,
// so this lives in its own file.
(function () {
  try {
    const params = new URLSearchParams(location.search);
    const rawName = (params.get('tool') || '').slice(0, 80).trim();
    const reason = (params.get('reason') || '').slice(0, 40);
    const safeName = rawName && /^[\w .,'&()\-]+$/.test(rawName) ? rawName : '';

    // Idle-timeout reasons → SESSION expired (subscription is still valid). Kept as an
    // explicit allowlist so anything backend-driven falls through to the subscription path.
    const SESSION_REASONS = ['idle_timeout', 'idle', 'session_timeout', 'session_expired'];
    const isSession = SESSION_REASONS.indexOf(reason) !== -1;

    const titleEl = document.getElementById('title');
    const msgEl = document.getElementById('message');
    const btn = document.getElementById('renew');
    const fallbackEl = document.getElementById('renew-fallback');
    const toolLabel = safeName || 'this tool';

    if (isSession) {
      // ── SESSION EXPIRED (idle timeout) — never mentions plan/subscription ──────
      document.title = 'Session expired — Gen Z Digital Store';
      if (titleEl) titleEl.textContent = 'Session expired';
      if (msgEl) {
        msgEl.innerHTML = safeName
          ? `Your <span class="tool">${escapeHtml(toolLabel)}</span> session has expired due to inactivity. Please launch the tool again from your Gen Z Dashboard.`
          : 'Your session has expired due to inactivity. Please launch the tool again from your Gen Z Dashboard.';
      }
      if (fallbackEl) fallbackEl.style.display = 'none';
      if (btn) {
        // "Go to Dashboard" — navigate to the member dashboard (same tab). `app` is the
        // dashboard origin passed by the extension; validated before use.
        let app = (params.get('app') || '').slice(0, 200).replace(/\/+$/, '');
        if (!/^https:\/\/[\w.-]+$/i.test(app)) app = 'https://app.genzdigitalstore.com';
        btn.textContent = 'Go to Dashboard';
        btn.href = app + '/client/dashboard';
        btn.target = '_self';
        btn.removeAttribute('rel');
      }
      return; // do NOT run any subscription/renew logic
    }

    // ── SUBSCRIPTION / ASSIGNMENT EXPIRED (backend-confirmed) — renew your plan ──
    document.title = 'Access expired — Gen Z Digital Store';
    const nameEl = document.getElementById('tool-name');
    if (nameEl && safeName) nameEl.textContent = safeName;
    if (msgEl) {
      const verb =
        reason === 'revoked' ? 'has been revoked'
        : reason === 'tool_removed' || reason === 'removed' ? 'is no longer available'
        : reason === 'blocked' ? 'has been blocked'
        : 'has expired';
      msgEl.innerHTML = `Your access to <span class="tool">${escapeHtml(toolLabel)}</span> ${verb}. Please renew your plan to continue.`;
    }

    // "Renew your plan" opens WhatsApp support with a safe pre-filled message.
    // Central support number (wa.me format: no '+'/spaces). Safe info only — never
    // tokens, cookies, sessions, or secrets.
    const SUPPORT_WHATSAPP_NUMBER = '923027467462';
    const email = (params.get('email') || '').slice(0, 120);
    const name = (params.get('name') || '').slice(0, 80);
    const lines = ['Hello, I want to renew my plan.'];
    if (safeName) lines.push(`Tool: ${safeName}`);
    if (reason) lines.push(`Status: ${reason === 'revoked' ? 'revoked' : reason === 'removed' || reason === 'tool_removed' ? 'removed' : 'expired'}`);
    const who = name || email;
    if (who && /^[\w .,'@+\-]+$/.test(who)) lines.push(`Account: ${who}`);
    const waUrl = `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(lines.join('\n'))}`;

    if (btn) {
      btn.textContent = 'Renew your plan';
      btn.href = waUrl;
      btn.target = '_blank';
      btn.rel = 'noopener noreferrer';
      btn.addEventListener('click', () => {
        if (fallbackEl) setTimeout(() => { fallbackEl.style.display = 'block'; }, 1200);
      });
    }
  } catch (_) { /* leave the static fallback message in place */ }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
})();
