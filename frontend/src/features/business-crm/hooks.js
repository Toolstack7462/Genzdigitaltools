import { useCallback, useEffect, useRef, useState } from 'react';
import { crmApi, messageFromError } from './api';

export function useResource(path, dependencies = []) {
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  // Every load takes a ticket. A response is only applied if its ticket is still the newest one.
  // Without this an earlier, slower request can land after a later one and overwrite the results
  // with the answer to a query the operator has already moved on from.
  const ticket = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const load = useCallback(async () => {
    const mine = ticket.current + 1; ticket.current = mine;
    setLoading(true); setError('');
    try {
      const response = await crmApi.get(typeof path === 'function' ? path() : path);
      if (mine !== ticket.current || !mounted.current) return null;
      setData(response.data); return response.data;
    } catch (err) {
      if (mine !== ticket.current || !mounted.current) return null;
      setError(messageFromError(err)); return null;
    } finally {
      if (mine === ticket.current && mounted.current) setLoading(false);
    }
  }, dependencies); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  // `loading` is true for every fetch, so a page that returns early on it unmounts its own search
  // box on each keystroke and the input loses focus. Pages gate the full-page spinner on
  // `initialLoading` (nothing rendered yet) and show `loading` as a quiet inline indicator instead.
  return { data, setData, loading, initialLoading: loading && data === null, error, reload: load };
}

/**
 * Debounces a fast-changing value (a search box) so it only reaches the request path once typing
 * settles. Returns the value immediately when it is cleared, so pressing the clear button restores
 * the unfiltered list without a wait.
 */
export function useDebouncedValue(value, delay = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (!value) { setSettled(value); return undefined; }
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export function useFormState(initial) { const [form, setForm] = useState(initial); const bind = (key) => ({ value: form[key] ?? '', onChange: (event) => setForm((value) => ({ ...value, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value })) }); return { form, setForm, bind }; }
