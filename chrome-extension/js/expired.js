// Renders the friendly "access expired" message for a tool whose assignment was
// expired/revoked/removed. The tool name + reason arrive as query params (no
// secrets). CSP forbids inline scripts, so this lives in its own file.
(function () {
  try {
    const params = new URLSearchParams(location.search);
    const rawName = (params.get('tool') || '').slice(0, 80).trim();
    const reason = (params.get('reason') || '').slice(0, 40);

    const safeName = rawName && /^[\w .,'&()\-]+$/.test(rawName) ? rawName : '';
    const nameEl = document.getElementById('tool-name');
    if (nameEl && safeName) nameEl.textContent = safeName;

    const msgEl = document.getElementById('message');
    if (msgEl) {
      const toolLabel = safeName || 'this tool';
      const verb =
        reason === 'revoked' ? 'has been revoked'
        : reason === 'tool_removed' || reason === 'removed' ? 'is no longer available'
        : reason === 'blocked' ? 'has been blocked'
        : 'has expired';
      msgEl.innerHTML = `Your access to <span class="tool">${escapeHtml(toolLabel)}</span> ${verb}. Please renew your plan to continue.`;
    }

    // "Renew your plan" opens WhatsApp support with a safe pre-filled message.
    // Central support number (wa.me format: no '+'/spaces). Safe info only —
    // never tokens, cookies, sessions, or secrets.
    const SUPPORT_WHATSAPP_NUMBER = '923027467462';
    const email = (params.get('email') || '').slice(0, 120);
    const name = (params.get('name') || '').slice(0, 80);
    const lines = ['Hello, I want to renew my plan.'];
    if (safeName) lines.push(`Tool: ${safeName}`);
    if (reason) lines.push(`Status: ${reason === 'revoked' ? 'revoked' : reason === 'removed' || reason === 'tool_removed' ? 'removed' : 'expired'}`);
    const who = name || email;
    if (who && /^[\w .,'@+\-]+$/.test(who)) lines.push(`Account: ${who}`);
    const waUrl = `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(lines.join('\n'))}`;

    const renew = document.getElementById('renew');
    if (renew) {
      renew.href = waUrl;
      renew.target = '_blank';
      renew.rel = 'noopener noreferrer';
      // Fallback hint if the click is blocked from opening a window.
      renew.addEventListener('click', () => {
        const fb = document.getElementById('renew-fallback');
        if (fb) setTimeout(() => { fb.style.display = 'block'; }, 1200);
      });
    }
  } catch (_) { /* leave the static fallback message in place */ }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
})();
