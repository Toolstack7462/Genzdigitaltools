import { useState, useEffect } from 'react';
import { stealthClient } from '../services/stealthService';

/**
 * Loads the client's StealthWriter plan summary (status, expiry, limits) so it can
 * be shown as a normal assigned-tool card on the Dashboard and My Tools pages.
 *
 * Isolated from the regular tools/cookie flow: it only reads /client/stealth.
 * Returns { stealth, loading } where stealth = { hasPlan, plan, resetLabel } | null.
 * Errors degrade gracefully to "no plan" so the rest of the page never breaks.
 */
export function useStealthSummary() {
  const [stealth, setStealth] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    stealthClient.getDashboard()
      .then((res) => { if (alive) setStealth(res.data || null); })
      .catch(() => { if (alive) setStealth(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  return { stealth, loading };
}

export default useStealthSummary;
