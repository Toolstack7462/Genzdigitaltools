import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/**
 * Global "refresh this page" mechanism.
 *
 * A single shared button lives in the admin + client topbars (so every page has it).
 * Each page may opt into SMART refresh by calling useRegisterRefresh(loadFn) — the
 * button then re-fetches just that page's data, with no full reload (scroll/state
 * preserved). Pages that don't register a handler fall back to a safe full reload.
 */
const RefreshContext = createContext(null);

export function RefreshProvider({ children }) {
  const handlerRef = useRef(null);
  const [hasHandler, setHasHandler] = useState(false);
  const [busy, setBusy] = useState(false);

  const register = useCallback((fn) => {
    handlerRef.current = fn;
    setHasHandler(true);
    return () => {
      if (handlerRef.current === fn) {
        handlerRef.current = null;
        setHasHandler(false);
      }
    };
  }, []);

  const trigger = useCallback(async () => {
    const fn = handlerRef.current;
    if (typeof fn !== 'function') {
      window.location.reload(); // no page-specific refresh registered → safe full reload
      return;
    }
    try {
      setBusy(true);
      await fn();
    } catch (_) {
      /* the page's own loader already surfaces its errors via toast */
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <RefreshContext.Provider value={{ register, trigger, busy, hasHandler }}>
      {children}
    </RefreshContext.Provider>
  );
}

// Safe default keeps the button working (full reload) even outside a provider.
export function useRefreshControl() {
  return (
    useContext(RefreshContext) || {
      register: () => () => {},
      trigger: () => window.location.reload(),
      busy: false,
      hasHandler: false,
    }
  );
}

// Pages call this with their data-loading function to enable smart (no-reload) refresh.
// The latest function is always invoked even though it is only registered once on mount.
export function useRegisterRefresh(loadFn) {
  const { register } = useRefreshControl();
  const fnRef = useRef(loadFn);
  fnRef.current = loadFn;
  useEffect(() => {
    const stable = () => (fnRef.current ? fnRef.current() : undefined);
    return register(stable);
  }, [register]);
}
