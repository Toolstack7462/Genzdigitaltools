// Zee — pause motion when the document is hidden (perf + battery). Returns true when hidden.
import { useEffect, useState } from 'react';

export function useVisibilityPause() {
  const [hidden, setHidden] = useState(
    () => (typeof document !== 'undefined' ? document.visibilityState === 'hidden' : false),
  );
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onVis = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVis);
    onVis();
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  return hidden;
}
