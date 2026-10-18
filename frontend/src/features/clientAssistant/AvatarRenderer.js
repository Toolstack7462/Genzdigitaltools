// Gen Z Guide — AvatarRenderer adapter. Isolates the assistant from the avatar implementation; the
// client-assistant components only ever speak in SEMANTIC states.
//
// Renderer hierarchy:
//   1. Zee — the ORIGINAL Gen Z Digital Store SVG avatar (features/genzAvatar) — default.
//   2. If Zee throws at render → the dependency-free CSS/lucide FALLBACK below.
//   3. An optional imperative `renderer` prop remains for any future approved external runtime.
// Zee is an original clean-room work (see docs/genz-avatar/). No `@bible-strong` package or AGPL
// runtime is used or bundled; that name appears in this repo only as a documented non-use statement.
import React, { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { Bot, Smile, Ear, Loader2, MessageSquare, CheckCircle2, AlertTriangle, Frown } from 'lucide-react';
import { resolveAvatarKeys } from './avatarStates';
import { logEvent } from './assistantEvents';
import GenzAvatar from '../genzAvatar/GenzAvatar';

// Semantic → fallback icon + accent token (existing brand palette only). Used only if Zee fails.
const FALLBACK = {
  idle:      { Icon: Bot,           accent: 'var(--genz-blue, #2563EB)',  label: 'Gen Z Guide, ready' },
  greeting:  { Icon: Smile,         accent: 'var(--genz-cyan, #06B6D4)',  label: 'Gen Z Guide, greeting you' },
  listening: { Icon: Ear,           accent: 'var(--genz-blue, #2563EB)',  label: 'Gen Z Guide, listening' },
  thinking:  { Icon: Loader2,       accent: 'var(--genz-blue, #2563EB)',  label: 'Gen Z Guide, thinking' },
  speaking:  { Icon: MessageSquare, accent: 'var(--genz-cyan, #06B6D4)',  label: 'Gen Z Guide, explaining' },
  success:   { Icon: CheckCircle2,  accent: '#16A34A',                    label: 'Gen Z Guide, all good' },
  warning:   { Icon: AlertTriangle, accent: '#D97706',                    label: 'Gen Z Guide, heads up' },
  error:     { Icon: Frown,         accent: '#DC2626',                    label: 'Gen Z Guide, there is a problem' },
};

// Narrow boundary around Zee: if the original renderer throws, drop to the CSS fallback (never the
// portal's problem). Keeps avatar failure fully contained.
class ZeeBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { try { this.props.onError && this.props.onError(); } catch { /* ignore */ } }
  render() { return this.state.failed ? null : this.props.children; }
}

/**
 * @param {object} props
 * @param {string} props.semantic   semantic state (idle/greeting/.../error)
 * @param {number} [props.size]     px
 * @param {object|null} [props.definition]  reserved for an external runtime (unused by Zee)
 * @param {object|null} [props.renderer]    optional imperative external runtime { mount, setState, destroy }
 */
export default function AvatarRenderer({ semantic = 'idle', size = 48, definition = null, renderer = null }) {
  const prefersReduced = useReducedMotion();
  const [hidden, setHidden] = useState(false);
  const [runtimeFailed, setRuntimeFailed] = useState(false);
  const [zeeFailed, setZeeFailed] = useState(false);
  const hostRef = useRef(null);
  const ctrlRef = useRef(null);

  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState === 'hidden');
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Optional imperative external runtime (only when a `renderer` is supplied). Created once.
  useEffect(() => {
    if (!renderer || !hostRef.current) return undefined;
    try { ctrlRef.current = renderer.mount(hostRef.current, { definition }); }
    catch { setRuntimeFailed(true); logEvent('avatar_fallback_used', {}); return undefined; }
    return () => { try { if (ctrlRef.current && renderer.destroy) renderer.destroy(ctrlRef.current); } catch { /* ignore */ } ctrlRef.current = null; };
  }, [renderer, definition]);

  useEffect(() => {
    if (!renderer || runtimeFailed || !ctrlRef.current) return;
    try {
      const keys = resolveAvatarKeys(semantic, definition);
      if (renderer.setState) renderer.setState({ ...keys, paused: hidden || prefersReduced });
    } catch { setRuntimeFailed(true); logEvent('avatar_fallback_used', {}); }
  }, [renderer, runtimeFailed, semantic, definition, hidden, prefersReduced]);

  const useRuntime = !!renderer && !runtimeFailed;
  const showZee = !useRuntime && !zeeFailed;
  const showCss = !useRuntime && zeeFailed;

  const fb = FALLBACK[semantic] || FALLBACK.idle;
  const { Icon } = fb;
  const animate = !prefersReduced && !hidden;
  const spin = animate && semantic === 'thinking';

  return (
    <span
      className="cga-avatar"
      style={{ width: size, height: size, ['--cga-accent']: fb.accent }}
      {...(showZee ? {} : { role: 'img', 'aria-label': fb.label })}
    >
      {useRuntime && <span ref={hostRef} className="cga-avatar-host" aria-hidden="true" />}
      {showZee && (
        <ZeeBoundary onError={() => { setZeeFailed(true); logEvent('avatar_fallback_used', {}); }}>
          <GenzAvatar semantic={semantic} size={size} />
        </ZeeBoundary>
      )}
      {showCss && (
        <span className={`cga-avatar-fallback${animate ? ' cga-anim' : ''}`} aria-hidden="true">
          <Icon size={Math.round(size * 0.5)} className={spin ? 'cga-spin' : ''} strokeWidth={2.1} />
        </span>
      )}
    </span>
  );
}
