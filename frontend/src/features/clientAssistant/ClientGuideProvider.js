// Gen Z Guide — state + orchestration. Lives INSIDE the authenticated client layout only (never
// public/admin). Exposes a small API and subscribes to the decoupled reportIssue() bus so any
// client component can raise an issue without importing the assistant UI. Reuses the existing
// useExtension() bridge, authService cached user, react-router navigation, and lib/support.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { extensionStatusKind, extensionIssueCode, EXT_KIND } from './extensionStatusKind';
import { useNavigate } from 'react-router-dom';
import { useExtension } from '../../hooks/useExtension';
import { authService } from '../../services/authService';
import { buildRenewWhatsAppUrl } from '../../lib/support';
import { flowForIssue, ISSUE } from './diagnosticFlows';
import { flowHintToSemantic } from './avatarStates';
import { INTENTS, matchIntent } from './assistantIntents';
import { buildAssistantSupportUrl } from './supportHandoff';
import { subscribeIssues, shouldAutoOpen, markAutoOpened, logEvent } from './assistantEvents';

const Ctx = createContext(null);
export const useClientGuide = () => useContext(Ctx);

function firstNameOf(user) {
  const n = (user && (user.fullName || user.name)) || '';
  const f = String(n).trim().split(/\s+/)[0];
  return f || 'there';
}

// Extension status is classified by extensionStatusKind.js, which distinguishes UNKNOWN from OK.
// The function that used to live here returned a problem code or `null`, and `null` was read as
// "all good" — so with no bridge answer at all Zee asserted "Your extension is installed and
// connected." It had never checked. `extensionIssueCode` keeps the old shape for call sites that
// only need a flow to start; anything that might REASSURE the client must read the kind.

export function ClientGuideProvider({ children }) {
  const navigate = useNavigate();
  const ext = useExtension();                       // reuse the existing bridge hook (status/reconnect)
  const status = ext && ext.status;
  const [user] = useState(() => { try { return authService.getClientUser(); } catch { return null; } });

  const [open, setOpen] = useState(false);
  const [flow, setFlow] = useState(null);           // current diagnostic flow (from diagnosticFlows)
  const [avatarState, setAvatarState] = useState('idle');
  const [history, setHistory] = useState([]);       // [{ role:'guide'|'client', text }]
  const [prompt, setPrompt] = useState(null);       // small non-blocking hint { code, title, toolName }
  // WHICH STEP THE CLIENT IS ON. The panel used to render a flow's whole <ol> at once, which is how
  // a four-step recovery became a wall of text. One step shows at a time; this is the cursor.
  const [stepIndex, setStepIndex] = useState(0);
  // The unsent message, kept HERE rather than in the panel: the panel unmounts on close, so a draft
  // held in its own state was lost every time the client closed Zee to go and look at something.
  const [draft, setDraft] = useState('');
  // Hint dismissals, remembered per issue code for the rest of the session so a declined offer is
  // not re-offered. Deliberately NOT persisted to storage — a new session may legitimately re-ask.
  const [dismissedCodes, setDismissedCodes] = useState(() => new Set());
  const lastIssueRef = useRef(null);
  const [lastIssueCode, setLastIssueCode] = useState(null);
  // Bumped on every close so the launcher can tell a RETURN from the dialog apart from a first
  // paint, and take focus back. The launcher unmounts while the panel is open, so the element that
  // opened the assistant cannot simply be re-focused by reference — it no longer exists.
  const [returnFocusToken, setReturnFocusToken] = useState(0);

  const openAssistant = useCallback(() => { setOpen(true); setAvatarState('greeting'); logEvent('assistant_opened'); }, []);
  const closeAssistant = useCallback(() => {
    setOpen(false);
    setReturnFocusToken((n) => n + 1);   // hand focus back to the launcher (WCAG 2.4.3)
    logEvent('assistant_closed');
  }, []);
  const dismissPrompt = useCallback(() => {
    setPrompt((p) => {
      if (p && p.code) setDismissedCodes((prev) => new Set(prev).add(p.code));
      return null;
    });
  }, []);

  // DELIBERATE reset only — never on close. Clears the cursor and the draft too, so "Start over"
  // really does start over.
  const resetConversation = useCallback(() => {
    setFlow(null); setHistory([]); setAvatarState('idle'); setStepIndex(0); setDraft('');
    lastIssueRef.current = null; setLastIssueCode(null);
  }, []);

  const pushGuide = useCallback((text) => setHistory((h) => [...h, { role: 'guide', text }]), []);
  const pushClient = useCallback((text) => setHistory((h) => [...h, { role: 'client', text }]), []);

  // Start a specific diagnostic flow by (normalised or raw) issue code + optional context.
  const startIssueByCode = useCallback((code, ctx = {}) => {
    const f = flowForIssue(code);
    lastIssueRef.current = { code: f.code, ...ctx };
    setLastIssueCode(f.code);
    setFlow({ ...f, ctx });
    setStepIndex(0);                 // a new flow always starts at its first step
    setAvatarState(flowHintToSemantic(f.avatar));
    pushGuide(f.title);
    setOpen(true);
    setPrompt(null);
    logEvent('flow_selected', { code: f.code, toolId: ctx.toolId });
  }, [pushGuide]);

  // Quick-action / intent → flow, inspecting live extension status where relevant.
  const startIntent = useCallback((intent, ctx = {}) => {
    switch (intent) {
      case INTENTS.TOOL_NOT_OPENING: {
        const ei = extensionIssueCode(status);
        return startIssueByCode(ei || ISSUE.TOOL_LAUNCH_FAILED, ctx);
      }
      case INTENTS.TOOL_MISSING: return startIssueByCode(ISSUE.TOOL_NOT_ASSIGNED, ctx);
      case INTENTS.EXTENSION: {
        const kind = extensionStatusKind(status);
        const ei = extensionIssueCode(status);
        if (ei) return startIssueByCode(ei, ctx);
        if (kind === EXT_KIND.OK) {
          // A POSITIVE reading on both fields. Only here may Zee say it looks good.
          const f = { code: 'EXTENSION_OK', title: 'Your extension looks good', avatar: 'happy',
            steps: [{ text: 'Your extension is installed and connected. You’re all set to open tools.' },
                    { text: 'Need the setup guide anyway?', action: 'navigate:/client/extension-guide' }],
            support: true, retryable: false };
          setFlow({ ...f, ctx }); setStepIndex(0); setAvatarState('success'); pushGuide(f.title);
          setOpen(true); setPrompt(null);
          return undefined;
        }
        // UNKNOWN: the bridge has not told us. Say so and offer a real check — never claim health.
        const f = { code: 'EXTENSION_UNKNOWN', title: 'I can’t confirm your extension yet', avatar: 'concerned',
          steps: [{ text: 'I can’t read your extension status from here, so I won’t guess. Let me check it properly.', action: 'recheck-extension' },
                  { text: 'If it still can’t be detected, the setup guide has the install steps.', action: 'navigate:/client/extension-guide' }],
          support: true, retryable: false };
        setFlow({ ...f, ctx }); setStepIndex(0); setAvatarState('warning'); pushGuide(f.title);
        setOpen(true); setPrompt(null);
        return undefined;
      }
      case INTENTS.EXPIRED: return startIssueByCode(ISSUE.ASSIGNMENT_EXPIRED, ctx);
      case INTENTS.USING_A_TOOL: {
        const f = { code: 'USING_A_TOOL', title: 'Using your tools', avatar: 'neutral',
          steps: [{ text: 'Open “My Tools” and tap a tool’s Access button — it opens in a new tab, signed in.', action: 'navigate:/client/tools' },
                  { text: 'If a tool needs the browser extension, the Extension Setup Guide walks you through it.', action: 'navigate:/client/extension-guide' },
                  { text: 'Still stuck? Contact support.', action: 'support' }],
          support: true, retryable: false };
        setFlow({ ...f, ctx }); setStepIndex(0); setAvatarState('thinking'); pushGuide(f.title);
        setOpen(true); setPrompt(null);
        return undefined;
      }
      case INTENTS.CONTACT_SUPPORT:
      default:
        return startIssueByCode(ISSUE.UNKNOWN_CLIENT_ISSUE, ctx);
    }
  }, [status, startIssueByCode, pushGuide]);

  const handleFreeText = useCallback((text) => {
    pushClient(text);
    const intent = matchIntent(text);
    if (!intent) {
      pushGuide('I’m not sure I caught that. Pick one of the options below, or contact support and a human will help.');
      setAvatarState('thinking');
      return null;
    }
    startIntent(intent);
    return intent;
  }, [pushClient, pushGuide, startIntent]);

  // Resolve a flow step's semantic action to a REAL existing action. Never invents routes.
  const performAction = useCallback(async (action, ctx = {}) => {
    if (!action) return;
    const c = { ...(flow && flow.ctx), ...ctx };
    if (action.startsWith('navigate:')) { navigate(action.slice('navigate:'.length)); setOpen(false); return; }
    switch (action) {
      case 'renew': {
        logEvent('support_handoff_clicked', { code: 'ASSIGNMENT_EXPIRED' });
        const url = buildRenewWhatsAppUrl({ clientName: user && user.fullName, clientEmail: user && user.email, toolName: c.toolName, status: 'expired' });
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }
      case 'support': {
        logEvent('support_handoff_clicked', { code: flow && flow.code });
        const url = buildAssistantSupportUrl({ issueTitle: flow && flow.title, toolName: c.toolName, clientName: user && user.fullName, clientEmail: user && user.email });
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }
      case 'recheck-extension': {
        setAvatarState('thinking'); pushGuide('Checking your extension…');
        logEvent('retry_attempted', { code: 'EXTENSION' });
        let res = { success: false };
        try { if (ext && ext.reconnect) res = await ext.reconnect(); } catch { res = { success: false }; }
        const kind = extensionStatusKind(ext && ext.status);
        const ei = extensionIssueCode(ext && ext.status);
        // Success needs a POSITIVE confirmation: either the reconnect call itself succeeded, or the
        // status now reads installed AND connected. 'unknown' is not success.
        if ((res && res.success) || kind === EXT_KIND.OK) {
          setAvatarState('success'); pushGuide('Your extension is connected now. Try opening your tool again.');
          logEvent('guidance_completed', { code: 'EXTENSION' });
        } else if (ei) { startIssueByCode(ei, c); }
        else {
          setAvatarState('warning');
          pushGuide('I still can’t confirm your extension from here. Open the Extension Setup Guide and follow the install steps, then check again.');
        }
        return;
      }
      case 'retry': {
        setAvatarState('thinking'); logEvent('retry_attempted', { code: flow && flow.code, toolId: c.toolId });
        let res;
        try {
          if (typeof c.retry === 'function') res = await c.retry();
          else if (c.toolId && ext && ext.openTool) res = await ext.openTool(c.toolId);
          else { navigate('/client/tools'); setOpen(false); return; }
        } catch { res = { success: false }; }
        if (res && res.success) { setAvatarState('success'); pushGuide('Done — your tool should be open now.'); logEvent('guidance_completed', { code: flow && flow.code }); }
        else { setAvatarState('warning'); pushGuide('That didn’t work this time. You can try once more, or contact support.'); if (res && res.error) startIssueByCode(res.error, c); }
        return;
      }
      default: return;
    }
  }, [flow, navigate, user, ext, pushGuide, startIssueByCode]);

  // Subscribe to the decoupled issue bus — any client component can raise an issue.
  useEffect(() => subscribeIssues((issue) => {
    if (!issue || !issue.code) return;
    logEvent('issue_reported', { code: issue.code, source: issue.source, toolId: issue.toolId });
    const f = flowForIssue(issue.code);
    // Only client-INITIATED, actionable issues may auto-open — at most once per issue per session.
    if (issue.recoverable !== false && shouldAutoOpen(issue) && issue.source !== 'background') {
      markAutoOpened(issue);
      startIssueByCode(issue.code, { toolId: issue.toolId, toolName: issue.toolName, retry: issue.retry });
    } else if (!dismissedCodes.has(f.code)) {
      // Respect a dismissal: once the client has waved this topic away, do not offer it again
      // this session.
      setPrompt({ code: f.code, title: f.title, toolName: issue.toolName, toolId: issue.toolId, retry: issue.retry });
    }
  }), [startIssueByCode, dismissedCodes]);

  const stepCount = (flow && Array.isArray(flow.steps)) ? flow.steps.length : 0;
  const nextStep = useCallback(() => setStepIndex((i) => Math.min(i + 1, Math.max(0, stepCount - 1))), [stepCount]);
  const prevStep = useCallback(() => setStepIndex((i) => Math.max(0, i - 1)), []);

  // LOG OUT OR SWITCH ACCOUNT -> drop everything client-specific. The provider outlives a route
  // change, so without this the next person to use the browser would inherit the previous
  // client's conversation, draft and dismissals.
  const identity = (user && (user.id || user._id || user.email)) || null;
  const identityRef = useRef(identity);
  useEffect(() => {
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    setOpen(false); setFlow(null); setHistory([]); setPrompt(null);
    setStepIndex(0); setDraft(''); setDismissedCodes(new Set());
    setAvatarState('idle'); lastIssueRef.current = null; setLastIssueCode(null);
  }, [identity]);

  const value = useMemo(() => ({
    open, flow, avatarState, history, prompt, returnFocusToken,
    client: { firstName: firstNameOf(user), fullName: user && user.fullName, email: user && user.email },
    extensionStatus: status,
    extensionKind: extensionStatusKind(status),
    lastIssueCode,
    stepIndex, stepCount, nextStep, prevStep,
    draft, setDraft,
    openAssistant, closeAssistant, dismissPrompt, resetConversation,
    startIntent, startIssueByCode, handleFreeText, performAction, setAvatarState,
  }), [open, flow, avatarState, history, prompt, returnFocusToken, user, status, lastIssueCode,
    stepIndex, stepCount, nextStep, prevStep, draft,
    openAssistant, closeAssistant, dismissPrompt, resetConversation, startIntent, startIssueByCode,
    handleFreeText, performAction]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export default ClientGuideProvider;
