// Gen Z Guide — state + orchestration. Lives INSIDE the authenticated client layout only (never
// public/admin). Exposes a small API and subscribes to the decoupled reportIssue() bus so any
// client component can raise an issue without importing the assistant UI. Reuses the existing
// useExtension() bridge, authService cached user, react-router navigation, and lib/support.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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

// Pick an issue code from the client's live extension status (used by the generic quick actions
// and free-text — it inspects REAL state, never guesses).
function extensionIssue(status) {
  if (!status) return null;
  if (status.installed === false) return ISSUE.EXTENSION_MISSING;
  if (status.installed && (status.isOutdated || status.updateAvailable)) return ISSUE.EXTENSION_OUTDATED;
  if (status.installed && status.connected === false) return ISSUE.EXTENSION_DISCONNECTED;
  return null;
}

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
  const lastIssueRef = useRef(null);

  const openAssistant = useCallback(() => { setOpen(true); setAvatarState('greeting'); logEvent('assistant_opened'); }, []);
  const closeAssistant = useCallback(() => { setOpen(false); logEvent('assistant_closed'); }, []);
  const dismissPrompt = useCallback(() => setPrompt(null), []);

  const resetConversation = useCallback(() => {
    setFlow(null); setHistory([]); setAvatarState('idle'); lastIssueRef.current = null;
  }, []);

  const pushGuide = useCallback((text) => setHistory((h) => [...h, { role: 'guide', text }]), []);
  const pushClient = useCallback((text) => setHistory((h) => [...h, { role: 'client', text }]), []);

  // Start a specific diagnostic flow by (normalised or raw) issue code + optional context.
  const startIssueByCode = useCallback((code, ctx = {}) => {
    const f = flowForIssue(code);
    lastIssueRef.current = { code: f.code, ...ctx };
    setFlow({ ...f, ctx });
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
        const ei = extensionIssue(status);
        return startIssueByCode(ei || ISSUE.TOOL_LAUNCH_FAILED, ctx);
      }
      case INTENTS.TOOL_MISSING: return startIssueByCode(ISSUE.TOOL_NOT_ASSIGNED, ctx);
      case INTENTS.EXTENSION: {
        const ei = extensionIssue(status);
        if (ei) return startIssueByCode(ei, ctx);
        // Installed + connected + current → reassure, point to the guide.
        const f = { code: 'EXTENSION_OK', title: 'Your extension looks good', avatar: 'happy',
          steps: [{ text: 'Your extension is installed and connected. You’re all set to open tools.' },
                  { text: 'Need the setup guide anyway?', action: 'navigate:/client/extension-guide' }],
          support: true, retryable: false };
        setFlow({ ...f, ctx }); setAvatarState('success'); pushGuide(f.title); setOpen(true); setPrompt(null);
        return undefined;
      }
      case INTENTS.EXPIRED: return startIssueByCode(ISSUE.ASSIGNMENT_EXPIRED, ctx);
      case INTENTS.USING_A_TOOL: {
        const f = { code: 'USING_A_TOOL', title: 'Using your tools', avatar: 'neutral',
          steps: [{ text: 'Open “My Tools” and tap a tool’s Access button — it opens in a new tab, signed in.', action: 'navigate:/client/tools' },
                  { text: 'If a tool needs the browser extension, the Extension Setup Guide walks you through it.', action: 'navigate:/client/extension-guide' },
                  { text: 'Still stuck? Contact support.', action: 'support' }],
          support: true, retryable: false };
        setFlow({ ...f, ctx }); setAvatarState('thinking'); pushGuide(f.title); setOpen(true); setPrompt(null);
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
        const ei = extensionIssue(ext && ext.status);
        if ((res && res.success) || (!ei && ext && ext.status && ext.status.connected)) {
          setAvatarState('success'); pushGuide('Your extension is connected now. Try opening your tool again.');
          logEvent('guidance_completed', { code: 'EXTENSION' });
        } else if (ei) { startIssueByCode(ei, c); }
        else { setAvatarState('warning'); pushGuide('Still not detected. Open the Extension Setup Guide and follow the install steps.'); }
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
    } else {
      setPrompt({ code: f.code, title: f.title, toolName: issue.toolName, toolId: issue.toolId, retry: issue.retry });
    }
  }), [startIssueByCode]);

  const value = useMemo(() => ({
    open, flow, avatarState, history, prompt,
    client: { firstName: firstNameOf(user), fullName: user && user.fullName, email: user && user.email },
    extensionStatus: status,
    openAssistant, closeAssistant, dismissPrompt, resetConversation,
    startIntent, startIssueByCode, handleFreeText, performAction, setAvatarState,
  }), [open, flow, avatarState, history, prompt, user, status, openAssistant, closeAssistant, dismissPrompt, resetConversation, startIntent, startIssueByCode, handleFreeText, performAction]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export default ClientGuideProvider;
