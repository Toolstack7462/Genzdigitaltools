import { useState, useEffect, useMemo, useCallback } from 'react';
import { MessageCircle, X, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';
import {
  normalizeWhatsAppNumber, isValidWhatsAppNumber, buildWhatsAppUrl,
} from './whatsappTemplates';

/**
 * WhatsAppSendDialog — lets an admin confirm/override the recipient number and
 * review the (editable) professional message BEFORE opening WhatsApp. Improves the
 * existing wa.me flow; it does NOT auto-send (wa.me always needs a manual Send tap)
 * and contains only safe content (no tokens/cookies/sessions/secrets).
 *
 * Props:
 *   open       : boolean
 *   onClose    : () => void
 *   client     : { fullName?, email?, phone? }  (phone pre-fills if ever present)
 *   message    : string  (initial, editable)
 *   onConfirm  : ({ number }) => void  (fired after wa.me opens, e.g. to log it)
 *   canSave    : boolean (default false) — show "save number" only if a safe
 *                client phone field exists; this build has none, so it stays off.
 *   onSaveNumber : (normalizedNumber) => void  (only used when canSave)
 */
const WhatsAppSendDialog = ({ open, onClose, client = {}, message = '', onConfirm, canSave = false, onSaveNumber }) => {
  const [number, setNumber] = useState('');
  const [text, setText] = useState('');
  const [save, setSave] = useState(false);

  // Reset fields each time the dialog opens for a (possibly new) client.
  useEffect(() => {
    if (!open) return;
    setNumber(client.phone ? normalizeWhatsAppNumber(client.phone) : '');
    setText(message || '');
    setSave(false);
  }, [open, client.phone, message]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const normalized = useMemo(() => normalizeWhatsAppNumber(number), [number]);
  const valid = isValidWhatsAppNumber(normalized);

  const openWhatsApp = useCallback(() => {
    if (!valid) return;
    window.open(buildWhatsAppUrl(text, normalized), '_blank', 'noopener,noreferrer');
    if (canSave && save && onSaveNumber) onSaveNumber(normalized);
    if (onConfirm) onConfirm({ number: normalized });
    onClose && onClose();
  }, [valid, text, normalized, canSave, save, onSaveNumber, onConfirm, onClose]);

  if (!open) return null;

  const who = client.fullName || client.email || 'client';

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4"
         role="dialog" aria-modal="true" aria-labelledby="wa-dialog-title"
         onClick={onClose}
         style={{ background: 'rgba(2,8,20,0.55)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}>
      <div onClick={(e) => e.stopPropagation()}
           className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl border border-genz-border overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-genz-border">
          <span className="w-9 h-9 rounded-xl flex items-center justify-center text-white flex-shrink-0"
                style={{ background: 'linear-gradient(135deg,#22c55e,#16a34a)' }}>
            <MessageCircle size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="wa-dialog-title" className="text-[15px] font-extrabold text-genz-navy leading-tight">Send WhatsApp reminder</h2>
            <p className="text-[12px] text-genz-muted truncate">to {who}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-genz-muted hover:text-genz-navy transition-colors"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Number */}
          <div>
            <label className="block text-[12px] font-bold text-genz-navy mb-1.5">WhatsApp number</label>
            <input
              type="tel" autoFocus value={number}
              onChange={(e) => setNumber(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && valid) openWhatsApp(); }}
              placeholder="+92 300 1234567  ·  0300 1234567  ·  +234…"
              className={`w-full px-3.5 py-2.5 text-sm rounded-xl bg-genz-bg border text-genz-navy placeholder:text-genz-muted focus:outline-none focus:ring-2 transition-all ${
                number && !valid ? 'border-red-300 focus:ring-red-200' : 'border-genz-border focus:border-genz-teal/50 focus:ring-genz-teal/20'
              }`}
            />
            <div className="mt-1.5 min-h-[18px] text-[11.5px] flex items-center gap-1.5">
              {!number ? (
                <span className="text-genz-muted">Enter the client's number. Local numbers (e.g. 0300…) default to Pakistan (+92); for other countries type the full +code.</span>
              ) : valid ? (
                <span className="text-green-600 inline-flex items-center gap-1"><CheckCircle2 size={13} /> Will message <span className="font-bold tabular-nums">+{normalized}</span></span>
              ) : (
                <span className="text-red-600 inline-flex items-center gap-1"><AlertCircle size={13} /> That doesn't look like a valid number.</span>
              )}
            </div>
          </div>

          {/* Message preview (editable) */}
          <div>
            <label className="block text-[12px] font-bold text-genz-navy mb-1.5">Message</label>
            <textarea
              rows={9} value={text} onChange={(e) => setText(e.target.value)}
              className="w-full px-3.5 py-2.5 text-[13px] leading-relaxed rounded-xl bg-genz-bg border border-genz-border text-genz-navy focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all resize-none"
            />
            <p className="text-[11px] text-genz-muted mt-1.5">You'll review it in WhatsApp before sending — nothing is sent automatically.</p>
          </div>

          {/* Optional save — only when a safe client phone field exists */}
          {canSave && (
            <label className="inline-flex items-center gap-2 text-[13px] text-genz-navy cursor-pointer">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} className="w-4 h-4 accent-genz-teal" />
              Save this number to the client's profile
            </label>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2.5 px-5 py-4 border-t border-genz-border bg-genz-bg/40">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-semibold text-genz-muted hover:text-genz-navy transition-colors">Cancel</button>
          <button onClick={openWhatsApp} disabled={!valid}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold text-white disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: 'linear-gradient(135deg,#22c55e,#16a34a)' }}>
            <ExternalLink size={15} /> Open WhatsApp
          </button>
        </div>
      </div>
    </div>
  );
};

export default WhatsAppSendDialog;
