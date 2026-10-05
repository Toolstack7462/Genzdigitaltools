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
    // Safe info only — never tokens, cookies, sessions, or secrets.
    // Support number: the admin-editable live value (GET /api/crm/public/support-contact,
    // below) wins; these two constants are the extension's ONE bundled fallback, used
    // offline / before the API answers. expired.html's static href/text mirrors them for no-JS.
    const SUPPORT_WHATSAPP_NUMBER = '923355500134';
    const SUPPORT_WHATSAPP_DISPLAY = '+92 335 5500134';
    const email = (params.get('email') || '').slice(0, 120);
    const name = (params.get('name') || '').slice(0, 80);
    const lines = ['Hello, I want to renew my plan.'];
    if (safeName) lines.push(`Tool: ${safeName}`);
    if (reason) lines.push(`Status: ${reason === 'revoked' ? 'revoked' : reason === 'removed' || reason === 'tool_removed' ? 'removed' : 'expired'}`);
    const who = name || email;
    if (who && /^[\w .,'@+\-]+$/.test(who)) lines.push(`Account: ${who}`);
    const waText = encodeURIComponent(lines.join('\n'));
    const waUrlFor = (number) => `https://wa.me/${number}?text=${waText}`;
    const waUrl = waUrlFor(SUPPORT_WHATSAPP_NUMBER);
    const numberEl = document.getElementById('support-number');
    if (numberEl) numberEl.textContent = SUPPORT_WHATSAPP_DISPLAY;

    if (btn) {
      btn.textContent = 'Renew your plan';
      btn.href = waUrl;
      btn.target = '_blank';
      btn.rel = 'noopener noreferrer';
      btn.addEventListener('click', () => {
        if (fallbackEl) setTimeout(() => { fallbackEl.style.display = 'block'; }, 1200);
      });
    }

    // ── LIVE SUPPORT CONTACT (admin-editable) ────────────────────────────────────────────
    // Best-effort, public, credential-free read. Only a well-formed number is accepted, and the
    // button is only retargeted while it is still the WhatsApp renew link (never after it has
    // flipped to "Go to Dashboard" below).
    loadLiveSupportContact((contact) => {
      if (btn && /^https:\/\/wa\.me\//.test(btn.href || '')) btn.href = waUrlFor(contact.whatsappNumber);
      if (numberEl) numberEl.textContent = contact.whatsappDisplay;
    });

    // ── AUTHORITATIVE VERIFICATION (presentation correctness + renewal recovery) ──────────
    // Everything above renders from the query string, which is USER-EDITABLE and therefore
    // presentation only — it has never granted access, and still doesn't. This step asks the
    // background (the real authority) about the EXACT assignment id that was expired, so:
    //   • the displayed product is the one that actually expired — Plus is never labelled Pro;
    //   • a renewed assignment stops showing a stale expired screen (Invariant 10).
    // Best-effort: if the background is unreachable the static text simply stays.
    const toolId = (params.get('toolId') || '').slice(0, 64);
    if (toolId && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage(
        { type: 'GENZ_EXPIRED_CONTEXT', payload: { toolId } },
        (res) => {
          try {
            if (chrome.runtime.lastError || !res || !res.success) return;

            // Correct the label from the authority, not from the query string.
            if (res.name && /^[\w .,'&()\-]+$/.test(res.name)) {
              if (nameEl) nameEl.textContent = res.name;
              if (msgEl && res.name !== toolLabel) {
                const v = reason === 'revoked' ? 'has been revoked'
                  : reason === 'tool_removed' || reason === 'removed' ? 'is no longer available'
                  : reason === 'blocked' ? 'has been blocked'
                  : 'has expired';
                msgEl.innerHTML =
                  `Your access to <span class="tool">${escapeHtml(res.name)}</span> ${v}. Please renew your plan to continue.`;
              }
            }

            // RENEWAL RECOVERY: this assignment is active again, so the expired screen is
            // stale. Offer a return to the dashboard rather than stranding the member here.
            // Deliberately NOT an automatic redirect — that risks a loop if state flaps.
            if (res.active) {
              document.title = 'Access restored — Gen Z Digital Store';
              if (titleEl) titleEl.textContent = 'Access restored';
              if (msgEl) {
                msgEl.innerHTML = res.name
                  ? `Your access to <span class="tool">${escapeHtml(res.name)}</span> is active again. Launch it from your Gen Z Dashboard.`
                  : 'Your access is active again. Launch the tool from your Gen Z Dashboard.';
              }
              if (fallbackEl) fallbackEl.style.display = 'none';
              if (btn) {
                let app = (params.get('app') || '').slice(0, 200).replace(/\/+$/, '');
                if (!/^https:\/\/[\w.-]+$/i.test(app)) app = 'https://app.genzdigitalstore.com';
                btn.textContent = 'Go to Dashboard';
                btn.href = app + '/client/dashboard';
                btn.target = '_self';
                btn.removeAttribute('rel');
              }
            }
          } catch (_) { /* keep whatever is already rendered */ }
        }
      );
    }
  } catch (_) { /* leave the static fallback message in place */ }

  function loadLiveSupportContact(apply) {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local || typeof fetch !== 'function') return;
      chrome.storage.local.get(['apiUrl'], (data) => {
        try {
          let base = String((data && data.apiUrl) || '').trim().replace(/\/+$/, '').replace(/\/api\/crm(\/extension)?$/i, '');
          if (!/^https:\/\/[\w.-]+(:\d+)?$/i.test(base)) base = 'https://api.genzdigitalstore.com';
          fetch(`${base}/api/crm/public/support-contact`, { credentials: 'omit', cache: 'no-store' })
            .then(r => (r.ok ? r.json() : null))
            .then(body => {
              const c = body && body.contact;
              if (!c || !/^\d{8,15}$/.test(String(c.whatsappNumber || ''))) return;
              const display = /^\+[\d ]{8,24}$/.test(String(c.whatsappDisplay || '')) ? c.whatsappDisplay : `+${c.whatsappNumber}`;
              apply({ whatsappNumber: String(c.whatsappNumber), whatsappDisplay: display });
            })
            .catch(() => { /* offline / API down → keep the bundled number */ });
        } catch (_) { /* keep the bundled number */ }
      });
    } catch (_) { /* keep the bundled number */ }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
})();
