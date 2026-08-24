import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import AdminLayoutEnhanced from '../../components/AdminLayoutEnhanced';
import { ShieldCheck, Loader2, CheckCircle2, AlertTriangle, Monitor } from 'lucide-react';
import { writeHumanV2Admin } from '../../services/writeHumanV2Service';
import { withCsrfRetry } from '../../services/launchService';

/**
 * The browser half of agent enrolment.
 *
 * A new agent has no credential, so it cannot authenticate itself — but the person installing it
 * can. They land here already signed in as admin, see which machine is asking, and approve it once.
 *
 * Nothing secret is displayed or returned. The credential is minted server-side and collected by
 * the agent over its own polling channel, so it never passes through this page, the URL, or the
 * operator's screen. All this page can do is flip one pending request to authorized.
 */
const AdminWriteHumanAuthorize = () => {
  const [params] = useSearchParams();
  const enrollId = params.get('e') || '';
  const [rec, setRec] = useState(null);
  const [state, setState] = useState('loading');   // loading | ready | done | error
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!enrollId) { setState('error'); setErr('This link is missing its request id.'); return; }
    try {
      const r = await writeHumanV2Admin.getEnrollment(enrollId);
      setRec(r.data.enrollment);
      setState(r.data.enrollment?.status === 'consumed' ? 'done' : 'ready');
    } catch (e) {
      setState('error');
      setErr(e.response?.status === 404
        ? 'That request no longer exists. It may have expired — start the agent again to create a new one.'
        : (e.response?.data?.error || 'Could not load this request.'));
    }
  }, [enrollId]);
  useEffect(() => { load(); }, [load]);

  const authorize = async () => {
    try {
      setBusy(true);
      // withCsrfRetry fetches the double-submit token, and refetches once if the server says it
      // went stale. Without it this POST is rejected with csrf_invalid and the click does nothing.
      const r = await withCsrfRetry((headers) => writeHumanV2Admin.authorizeEnrollment(enrollId, headers));
      setRec(r.data.enrollment);
      setState('done');
    } catch (e) {
      const code = e.response?.data?.code;
      setErr(code === 'ENROLLMENT_EXPIRED'
        ? 'This request expired before it was approved. Start the agent again for a fresh one.'
        : code === 'csrf_invalid'
          ? 'Security token was rejected. Reload this page and try again.'
          : (code || e.response?.data?.error || 'Could not authorize this device.'));
    } finally { setBusy(false); }
  };

  const expired = rec && (rec.expired || rec.status === 'consumed');

  return (
    <AdminLayoutEnhanced>
      <div className="max-w-xl mx-auto py-8">
        <div className="ds-card rounded-2xl p-7">
          <div className="flex items-center gap-3 mb-5">
            <span className="w-11 h-11 rounded-xl flex items-center justify-center text-white bg-gradient-to-br from-cyan-500 to-blue-600">
              <ShieldCheck size={22} />
            </span>
            <div>
              <h1 className="font-heading text-lg font-bold text-slate-800">Authorize WriteHuman agent</h1>
              <p className="text-sm text-slate-500">Approve this machine to sync WriteHuman cookies.</p>
            </div>
          </div>

          {state === 'loading' && (
            <div className="flex items-center gap-2 text-slate-400 py-8"><Loader2 className="animate-spin" size={18} /> Loading request…</div>
          )}

          {state === 'error' && (
            <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 p-4 text-sm flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" /><span>{err}</span>
            </div>
          )}

          {(state === 'ready' || state === 'done') && rec && (
            <>
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 mb-4">
                <div className="flex items-center gap-2 mb-2 text-slate-700 font-semibold">
                  <Monitor size={16} /> {rec.name}
                </div>
                <dl className="text-sm space-y-1">
                  <div className="flex justify-between"><dt className="text-slate-500">Machine</dt><dd className="font-medium text-slate-700">{rec.hostname || '—'}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Agent version</dt><dd className="font-medium text-slate-700">{rec.agentVersion || '—'}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Agent id</dt><dd className="font-mono text-xs text-slate-600">{rec.agentIdShort}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Requested</dt><dd className="font-medium text-slate-700">{new Date(rec.createdAt).toLocaleTimeString()}</dd></div>
                </dl>
              </div>

              {state === 'done' ? (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-800 p-4 text-sm flex items-start gap-2">
                  <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />
                  <span>
                    <strong>Authorized.</strong> The agent picks up its credential within a few seconds — there is
                    nothing to copy. Open the configured Chrome profile and sign in to WriteHuman (or paste the
                    cookies in) and it will sync on its own.
                  </span>
                </div>
              ) : expired ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-800 p-4 text-sm">
                  This request has expired. Start the agent again to create a new one.
                </div>
              ) : (
                <>
                  <p className="text-[13px] text-slate-500 mb-4">
                    Approve only if you started this agent yourself. Approving lets this machine upload WriteHuman
                    cookies; it never grants access to anything else, and you can revoke it at any time.
                  </p>
                  <button onClick={authorize} disabled={busy}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-white bg-gradient-to-r from-cyan-500 to-blue-600 disabled:opacity-50">
                    {busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                    Authorize this device
                  </button>
                  {err && <p className="text-[13px] text-red-600 mt-3">{err}</p>}
                </>
              )}
            </>
          )}

          <div className="mt-6 pt-4 border-t border-slate-100 text-[13px]">
            <Link to="/admin/writehuman" className="text-blue-600 hover:underline">Back to WriteHuman</Link>
          </div>
        </div>
      </div>
    </AdminLayoutEnhanced>
  );
};

export default AdminWriteHumanAuthorize;
