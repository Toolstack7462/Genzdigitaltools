import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { crmApi, messageFromError, setBusinessCsrf } from './api';
import { queueCount, syncQueue } from './offline/queue';
import { registerBusinessCrmWorker } from './offline/register';
const Context = createContext(null);
export function BusinessCrmProvider({ children }) {
  const [bootstrap, setBootstrap] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [currency, setCurrencyState] = useState(localStorage.getItem('genz_business_currency') || 'PKR'); const [online, setOnline] = useState(navigator.onLine); const [queued, setQueued] = useState(0); const [syncing, setSyncing] = useState(false);
  const load = useCallback(async () => { setLoading(true); setError(''); try { const response = await crmApi.bootstrap(); setBusinessCsrf(response.data.csrfToken); setBootstrap(response.data); queueCount(response.data.user?.id).then(setQueued).catch(() => {}); const allowed = response.data.currencies || ['PKR']; if (!allowed.includes(currency)) setCurrencyState(response.data.settings?.default_currency || 'PKR'); } catch (err) { setError(messageFromError(err)); } finally { setLoading(false); } }, [currency]);
  useEffect(() => { load(); registerBusinessCrmWorker(); }, [load]);
  useEffect(() => { const onOnline = () => { setOnline(true); runSync(); }; const onOffline = () => setOnline(false); window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline); return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const setCurrency = (value) => { localStorage.setItem('genz_business_currency', value); setCurrencyState(value); };
  const runSync = useCallback(async () => { if (!navigator.onLine || syncing) return; setSyncing(true); try { const result = await syncQueue(bootstrap?.user?.id); setQueued(result.queued); } catch (_) { /* status remains visible */ } finally { setSyncing(false); } }, [syncing, bootstrap]);
  const value = useMemo(() => ({ bootstrap, loading, error, reloadBootstrap: load, currency, setCurrency, online, queued, setQueued, syncing, runSync, has: (permission) => Boolean(bootstrap?.access?.permissions?.includes(permission)), role: bootstrap?.access?.role || '', user: bootstrap?.user || null, settings: bootstrap?.settings || {} }), [bootstrap, loading, error, load, currency, online, queued, syncing, runSync]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useBusinessCrm() { const value = useContext(Context); if (!value) throw new Error('BusinessCrmProvider is missing'); return value; }
