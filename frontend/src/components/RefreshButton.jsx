import { useLocation } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { useRefreshControl } from '../contexts/RefreshContext';

// Hidden on form / editor / wizard / assign routes so a refresh can never discard
// unsaved input.
const FORM_RE = /(\/new|\/edit|\/wizard|\/assign)(\/|$)/;

export default function RefreshButton({ variant = 'dark', className = '' }) {
  const { trigger, busy } = useRefreshControl();
  const { pathname } = useLocation();
  if (FORM_RE.test(pathname)) return null;

  const tone =
    variant === 'dark'
      ? 'text-white/70 border-white/15 hover:text-white hover:border-genz-cyan/50 hover:bg-white/5'
      : 'text-genz-muted border-genz-border hover:text-genz-teal hover:border-genz-teal/40 hover:bg-genz-teal/5';

  return (
    <button
      type="button"
      onClick={trigger}
      disabled={busy}
      aria-label="Refresh this page"
      title="Refresh"
      className={`flex items-center justify-center h-9 w-9 rounded-xl border transition-all disabled:opacity-60 ${tone} ${className}`}
    >
      <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />
    </button>
  );
}
