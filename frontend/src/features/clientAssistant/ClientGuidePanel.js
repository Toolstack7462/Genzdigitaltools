// Gen Z Guide — the assistant panel (lazy-loaded). Accessible dialog: role/aria-modal, focus
// management, Escape to close, aria-live message region, keyboard-operable buttons, reduced-motion
// aware. Presentational — all logic comes from ClientGuideProvider. No dangerouslySetInnerHTML.
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { X, RotateCcw, Send, LifeBuoy } from 'lucide-react';
import AvatarRenderer from './AvatarRenderer';
import { useClientGuide } from './ClientGuideProvider';
import { INTENTS, MAX_INPUT_LENGTH } from './assistantIntents';

const QUICK_ACTIONS = [
  { label: 'My tool is not opening', intent: INTENTS.TOOL_NOT_OPENING },
  { label: 'I cannot find my assigned tool', intent: INTENTS.TOOL_MISSING },
  { label: 'Install or update the extension', intent: INTENTS.EXTENSION },
  { label: 'My subscription or access has expired', intent: INTENTS.EXPIRED },
  { label: 'I need help using a tool', intent: INTENTS.USING_A_TOOL },
  { label: 'Contact human support', intent: INTENTS.CONTACT_SUPPORT },
];

const ACTION_LABEL = {
  'navigate:/client/tools': 'Open My Tools',
  'navigate:/client/extension-guide': 'Open Extension Guide',
  renew: 'Renew now',
  support: 'Contact support',
  'recheck-extension': 'Check again',
  retry: 'Try again',
};
const actionLabel = (a) => ACTION_LABEL[a] || (a && a.startsWith('navigate:') ? 'Open page' : 'Continue');

export default function ClientGuidePanel() {
  const g = useClientGuide();
  const reduce = useReducedMotion();
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const [text, setText] = useState('');
  const open = !!(g && g.open);
  const closeAssistant = g && g.closeAssistant;

  // Focus management: focus the close button on open; Escape closes. (All hooks run before any
  // early return — rules-of-hooks.)
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => { try { closeRef.current && closeRef.current.focus(); } catch {} }, 0);
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (closeAssistant) closeAssistant(); } };
    document.addEventListener('keydown', onKey, true);
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey, true); };
  }, [open, closeAssistant]);

  if (!g) return null;
  const { flow, history, avatarState, client, performAction, startIntent, handleFreeText, resetConversation } = g;

  const submit = (e) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    handleFreeText(v);
    setText('');
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="cga-panel"
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label="Gen Z Guide support assistant"
          initial={reduce ? false : { opacity: 0, y: 16, scale: 0.98 }}
          animate={reduce ? {} : { opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? {} : { opacity: 0, y: 16, scale: 0.98 }}
          transition={{ duration: 0.18 }}
        >
          <header className="cga-head">
            <AvatarRenderer semantic={avatarState || 'greeting'} size={40} />
            <div className="cga-head-text">
              <p className="cga-title">Gen Z Guide</p>
              <p className="cga-status">Here to help with your tools &amp; account</p>
            </div>
            <button type="button" ref={closeRef} className="cga-icon-btn" aria-label="Close assistant" onClick={closeAssistant}>
              <X size={18} />
            </button>
          </header>

          <div className="cga-body">
            <p className="cga-welcome">
              Hi {client.firstName}, I’m Gen Z Guide. I can help you access your tools, fix extension
              problems, understand your plan, or contact support.
            </p>

            {/* Conversation / guidance history — announced to screen readers */}
            <div className="cga-history" aria-live="polite" aria-atomic="false">
              {history.map((m, i) => (
                <p key={i} className={m.role === 'client' ? 'cga-msg cga-msg-client' : 'cga-msg cga-msg-guide'}>{m.text}</p>
              ))}
            </div>

            {/* Active flow steps */}
            {flow && (
              <section className="cga-flow" aria-label={`Steps: ${flow.title}`}>
                <ol className="cga-steps">
                  {flow.steps.map((s, i) => (
                    <li key={i} className="cga-step">
                      <span className="cga-step-text">{s.text}</span>
                      {s.action && (
                        <button type="button" className="cga-step-btn" onClick={() => performAction(s.action, flow.ctx)}>
                          {actionLabel(s.action)}
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
                <div className="cga-flow-actions">
                  {flow.retryable && (
                    <button type="button" className="cga-btn cga-btn-primary" onClick={() => performAction('retry', flow.ctx)}>
                      <RotateCcw size={14} /> Try again
                    </button>
                  )}
                  {flow.support && (
                    <button type="button" className="cga-btn cga-btn-ghost" onClick={() => performAction('support', flow.ctx)}>
                      <LifeBuoy size={14} /> Contact support
                    </button>
                  )}
                </div>
              </section>
            )}

            {/* Quick actions */}
            <div className="cga-quick" role="group" aria-label="Quick help options">
              {QUICK_ACTIONS.map((q) => (
                <button
                  key={q.intent}
                  type="button"
                  className="cga-quick-btn"
                  onClick={() => (q.intent === INTENTS.CONTACT_SUPPORT ? performAction('support') : startIntent(q.intent))}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>

          <footer className="cga-foot">
            <form className="cga-input-row" onSubmit={submit}>
              <label className="cga-sr-only" htmlFor="cga-input">Describe your problem</label>
              <input
                id="cga-input"
                className="cga-input"
                type="text"
                value={text}
                maxLength={MAX_INPUT_LENGTH}
                placeholder="Describe your problem…"
                onChange={(e) => setText(e.target.value)}
                autoComplete="off"
              />
              <button type="submit" className="cga-icon-btn" aria-label="Send message" disabled={!text.trim()}>
                <Send size={16} />
              </button>
            </form>
            <button type="button" className="cga-reset" onClick={resetConversation}>Start over</button>
          </footer>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
