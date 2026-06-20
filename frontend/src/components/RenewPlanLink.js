import React from 'react';
import { authService } from '../services/authService';
import { buildRenewWhatsAppUrl, SUPPORT_CONTACT_PATH } from '../lib/support';

/**
 * Reusable "Renew Plan" action that opens WhatsApp support in a new tab with a
 * pre-filled, safe renewal message. Pulls the client's name/email from the
 * current session itself (no secrets). Falls back to the contact page if the
 * WhatsApp window is blocked.
 *
 * Props: { toolName?, status?, className?, children?, ...anchorProps }
 */
export default function RenewPlanLink({ toolName, status = 'expired', className, children, onClick, ...rest }) {
  let user = null;
  try { user = authService.getCurrentUser(); } catch (_) {}

  const href = buildRenewWhatsAppUrl({
    clientName: user?.fullName || null,
    clientEmail: user?.email || null,
    toolName: toolName || null,
    status,
  });

  const handleClick = (e) => {
    if (onClick) onClick(e);
    if (e.defaultPrevented) return;
    // Best-effort new-tab open; if the browser blocks it, fall back to contact.
    try {
      const win = window.open(href, '_blank', 'noopener,noreferrer');
      if (win) { e.preventDefault(); return; }
      // Popup blocked → let the anchor's own href handle navigation (target=_blank).
    } catch (_) {
      e.preventDefault();
      window.location.href = SUPPORT_CONTACT_PATH;
    }
  };

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      onClick={handleClick}
      {...rest}
    >
      {children || 'Renew Plan'}
    </a>
  );
}
