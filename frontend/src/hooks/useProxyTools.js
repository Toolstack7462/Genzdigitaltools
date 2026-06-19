import { useState, useEffect } from 'react';
import { proxyToolsClient } from '../services/proxyToolsService';

/**
 * Loads the proxy tools (HIX AI / BypassGPT) assigned to this client so they can be
 * shown as normal assigned-tool cards on the Dashboard and My Tools pages.
 *
 * Isolated from the regular tools/cookie flow and from StealthWriter: it only reads
 * /client/proxy-tools. Errors degrade gracefully to "no tools".
 * Returns { proxyTools: [...], loading }.
 */
export function useProxyTools() {
  const [proxyTools, setProxyTools] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    proxyToolsClient.list()
      .then((res) => { if (alive) setProxyTools(res.data?.tools || []); })
      .catch(() => { if (alive) setProxyTools([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  return { proxyTools, loading };
}

export default useProxyTools;
