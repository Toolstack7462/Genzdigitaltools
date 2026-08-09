import { useCallback, useEffect, useState } from 'react';
import { crmApi, messageFromError } from './api';
export function useResource(path, dependencies = []) {
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const load = useCallback(async () => { setLoading(true); setError(''); try { const response = await crmApi.get(typeof path === 'function' ? path() : path); setData(response.data); return response.data; } catch (err) { setError(messageFromError(err)); return null; } finally { setLoading(false); } }, dependencies); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return { data, setData, loading, error, reload: load };
}
export function useFormState(initial) { const [form, setForm] = useState(initial); const bind = (key) => ({ value: form[key] ?? '', onChange: (event) => setForm((value) => ({ ...value, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value })) }); return { form, setForm, bind }; }
