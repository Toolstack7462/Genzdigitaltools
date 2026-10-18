// Zee — the assistant panel (lazy-loaded). Accessible dialog: role/aria-modal, focus management,
// Escape to close, aria-live message region, keyboard-operable buttons, reduced-motion aware.
// Presentational — all logic comes from ClientGuideProvider. No dangerouslySetInnerHTML.
//
// WHAT CHANGED, AND WHY. The previous layout was a 370px panel with a 40px avatar in the header and
// all six quick actions stacked permanently below the conversation at min-height 44px each — about
// 290px of buttons that never reflected the client's situation — with any active flow rendering its
// whole <ol> of steps at once. It read as a form, not a companion.
//
//   * TWO STATES, ONE PANEL. In WELCOME, Zee is 96px with a soft halo and has real presence. The
//     moment a conversation starts the same panel switches to CHAT and Zee compacts into a 32px
//     header thumbnail, which is where the room for the thread comes from. No text was shrunk.
//   * THREE CHIPS, NOT SIX BUTTONS. Ranked from real state (quickActionRanking.js); everything else
//     sits under More help, so no supported topic became unreachable.
//   * ONE STEP AT A TIME. A flow shows step n of N with Back/Next, so a four-step recovery reads as
//     a conversation rather than a wall.
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { X, RotateCcw, Send, LifeBuoy, ChevronLeft, ChevronRight, ChevronDown, Wrench, Puzzle, AlertCircle } from 'lucide-react';
import AvatarRenderer from './AvatarRenderer';
import { useClientGuide } from './ClientGuideProvider';
import { INTENTS, MAX_INPUT_LENGTH } from './assistantIntents';
import { rankQuickActions, groupRest } from './quickActionRanking';

const ACTION_LABEL = {
  'navigate:/client/tools': 'Open My Tools',
  'navigate:/client/extension-guide': 'Open Extension Guide',
  renew: 'Renew now',
  support: 'Contact support',
  'recheck-extension': 'Check again',
  retry: 'Try again',
};
const actionLabel = (a) => ACTION_LABEL[a] || (a && a.startsWith('navigate:') ? 'Open page' : 'Continue');

const CHIP_ICON = { tool: Wrench, puzzle: Puzzle, alert: AlertCircle };

// The header's second line in CHAT. Mirrors the avatar's semantic state in words, so the state is
// never conveyed by motion alone.
function statusLine(semantic) {
  switch (semantic) {
    case 'thinking': return 'checking…';
    case 'listening': return 'listening';
    case 'speaking': return 'typing…';
    case 'success': return 'sorted';
    case 'warning': return 'needs a look';
    case 'error': return 'something went wrong';
    default: return 'Gen Z Guide';
  }
}

export default function ClientGuidePanel() {
  const g = useClientGuide();
  const reduce = useReducedMotion();
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const [showMore, setShowMore] = useState(false);
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

  // More help is a transient view, not conversation state: closing Zee collapses it again.
  useEffect(() => { if (!open) setShowMore(false); }, [open]);

  if (!g) return null;
  const {
    flow, history, avatarState, client, performAction, startIntent, startIssueByCode,
    resetConversation, extensionKind, lastIssueCode, stepIndex, stepCount, nextStep, prevStep,
    draft, setDraft, handleFreeText,
  } = g;

  // WELCOME vs CHAT. Anything the client has actually done — a message, a flow — moves Zee out of
  // the way and gives the room to the conversation.
  const conversing = !!(flow || (history && history.length));
  const { top, rest } = rankQuickActions({ extensionKind, lastIssueCode });
  const groups = groupRest(rest);

  const run = (a) => {
    setShowMore(false);
    if (a.intent === INTENTS.CONTACT_SUPPORT) return performAction('support');
    if (a.intent) return startIntent(a.intent);
    if (a.issue) return startIssueByCode(a.issue);
    return undefined;
  };

  const submit = (e) => {
    e.preventDefault();
    const v = (draft || '').trim();
    if (!v) return;
    handleFreeText(v);
    setDraft('');
  };

  const step = (flow && Array.isArray(flow.steps) && flow.steps[stepIndex]) || null;
  const pct = stepCount > 1 ? Math.round(((stepIndex + 1) / stepCount) * 100) : 100;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={`cga-panel ${conversing ? 'cga-panel-chat' : 'cga-panel-welcome'}`}
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label="Zee, the Gen Z Guide"
          initial={reduce ? false : { opacity: 0, y: 16, scale: 0.98 }}
          animate={reduce ? {} : { opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? {} : { opacity: 0, y: 16, scale: 0.98 }}
          transition={{ duration: 0.18 }}
        >
          <header className="cga-head">
            {conversing
              ? <AvatarRenderer semantic={avatarState || 'idle'} size={32} />
              : <span className="cga-dot" aria-hidden="true" />}
            <div className="cga-head-text">
              <p className="cga-title">Zee</p>
              <p className="cga-status">{conversing ? statusLine(avatarState) : 'Gen Z Guide'}</p>
            </div>
            {showMore && (
              <button type="button" className="cga-icon-btn" aria-label="Back to Zee" onClick={() => setShowMore(false)}>
                <ChevronLeft size={17} />
              </button>
            )}
            <button type="button" ref={closeRef} className="cga-icon-btn" aria-label="Close Zee" onClick={closeAssistant}>
              <X size={17} />
            </button>
          </header>

          {!conversing && !showMore && (
            <div className="cga-hero">
              <span className="cga-halo" aria-hidden="true" />
              <AvatarRenderer semantic={avatarState || 'greeting'} size={96} />
              <p className="cga-hello">Hi {client.firstName} — I&rsquo;m Zee</p>
              <p className="cga-sub">Tell me what&rsquo;s stuck and I&rsquo;ll check it with you, one step at a time.</p>
            </div>
          )}

          <div className="cga-body">
            {showMore ? (
              <div className="cga-more" role="group" aria-label="All help topics">
                {groups.map((gr) => (
                  <div key={gr.group} className="cga-more-group">
                    <p className="cga-more-head">{gr.group}</p>
                    {gr.items.map((a) => (
                      <button key={a.id} type="button" className="cga-more-btn" onClick={() => run(a)}>{a.label}</button>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <>
                {conversing && (
                  <div className="cga-history" aria-live="polite" aria-atomic="false">
                    {history.map((m, i) => (
                      <p key={i} className={m.role === 'client' ? 'cga-msg cga-msg-client' : 'cga-msg cga-msg-guide'}>{m.text}</p>
                    ))}
                  </div>
                )}

                {flow && step && (
                  <section className="cga-stepcard" aria-label={`Step ${stepIndex + 1} of ${stepCount}: ${flow.title}`}>
                    <div className="cga-stepmeta">
                      <span className="cga-stepcount">Step {stepIndex + 1} of {stepCount}</span>
                      <span className="cga-steptitle">{flow.title}</span>
                    </div>
                    <div className="cga-progress" role="presentation">
                      <span className="cga-progress-fill" style={{ width: pct + '%' }} />
                    </div>
                    <p className="cga-step-text">{step.text}</p>
                    <div className="cga-steprow">
                      <button
                        type="button"
                        className="cga-stepnav"
                        aria-label="Previous step"
                        onClick={prevStep}
                        disabled={stepIndex === 0}
                      >
                        <ChevronLeft size={16} />
                      </button>
                      {step.action && (
                        <button type="button" className="cga-btn cga-btn-primary" onClick={() => performAction(step.action, flow.ctx)}>
                          {actionLabel(step.action)}
                        </button>
                      )}
                      {stepIndex + 1 < stepCount ? (
                        <button type="button" className="cga-btn cga-btn-ghost" onClick={nextStep}>
                          Next <ChevronRight size={15} />
                        </button>
                      ) : (flow.retryable && (
                        <button type="button" className="cga-btn cga-btn-ghost" onClick={() => performAction('retry', flow.ctx)}>
                          <RotateCcw size={14} /> Try again
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {!conversing && (
                  <div className="cga-chips" role="group" aria-label="Quick help options">
                    {top.map((a) => {
                      const Icon = CHIP_ICON[a.icon];
                      return (
                        <button key={a.id} type="button" className="cga-chip" onClick={() => run(a)}>
                          {Icon ? <Icon size={16} aria-hidden="true" /> : null}
                          <span>{a.label}</span>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className="cga-morelink"
                      aria-expanded={showMore}
                      onClick={() => setShowMore(true)}
                    >
                      <span>More help &middot; {rest.length} more topics</span>
                      <ChevronDown size={15} aria-hidden="true" />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          <footer className="cga-foot">
            <form className="cga-input-row" onSubmit={submit}>
              <label className="cga-sr-only" htmlFor="cga-input">Describe your problem</label>
              <input
                id="cga-input"
                className="cga-input"
                type="text"
                value={draft || ''}
                maxLength={MAX_INPUT_LENGTH}
                placeholder="Type it in English or Roman Urdu…"
                onChange={(e) => setDraft(e.target.value)}
                autoComplete="off"
              />
              <button type="submit" className="cga-send" aria-label="Send message" disabled={!(draft || '').trim()}>
                <Send size={16} />
              </button>
            </form>
            <div className="cga-footrow">
              <button type="button" className="cga-support" onClick={() => performAction('support', flow && flow.ctx)}>
                <LifeBuoy size={14} /> Talk to a human
              </button>
              {conversing && (
                <button type="button" className="cga-reset" onClick={resetConversation}>Start over</button>
              )}
            </div>
          </footer>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
