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

    // Point "Renew" at the dashboard. Honour an apiUrl-derived app origin if one
    // was passed; otherwise keep the production default already in the markup.
    const app = params.get('app');
    if (app && /^https:\/\/[\w.-]+\.genzdigitalstore\.com\/?/.test(app)) {
      const renew = document.getElementById('renew');
      if (renew) renew.href = app.replace(/\/+$/, '') + '/client';
    }
  } catch (_) { /* leave the static fallback message in place */ }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
})();
