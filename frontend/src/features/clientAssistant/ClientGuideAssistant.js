// Gen Z Guide — single mount point for the authenticated client layout. Composes the provider,
// the lightweight launcher, and the LAZILY-loaded panel (its own chunk, fetched only after the
// assistant is first opened). Wrapped in a narrow error boundary that renders nothing on failure,
// so the assistant can NEVER prevent the client portal from loading.
import React, { Suspense, lazy } from 'react';
import ClientGuideProvider, { useClientGuide } from './ClientGuideProvider';
import ClientGuideLauncher from './ClientGuideLauncher';
import './clientAssistant.css';

const ClientGuidePanel = lazy(() => import('./ClientGuidePanel'));

class AssistantErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) {
    // Non-sensitive breadcrumb only; never the portal's problem.
    try { if (console && console.debug) console.debug('[genz-guide] assistant disabled after error', { name: err && err.name }); } catch {}
  }
  render() { return this.state.failed ? null : this.props.children; }
}

// Mounts the panel chunk only after the assistant has been opened at least once.
function PanelGate() {
  const g = useClientGuide();
  const open = !!(g && g.open);
  const [everOpened, setEverOpened] = React.useState(false);
  React.useEffect(() => { if (open) setEverOpened(true); }, [open]);
  if (!everOpened) return null;
  return <Suspense fallback={null}><ClientGuidePanel /></Suspense>;
}

export default function ClientGuideAssistant() {
  return (
    <AssistantErrorBoundary>
      <ClientGuideProvider>
        <ClientGuideLauncher />
        <PanelGate />
      </ClientGuideProvider>
    </AssistantErrorBoundary>
  );
}
