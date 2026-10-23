import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import AdminLayoutEnhanced from '../../components/AdminLayoutEnhanced';
import { ShieldCheck, Loader2, CheckCircle2, AlertTriangle, Monitor, RefreshCw, Clock } from 'lucide-react';
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
 *
 * WHY THIS PAGE NO LONGER NEEDS A LINK.
 *
 * It used to require `?e=<enrollId>` and dead-ended without it ("This link is missing its request
 * id."). An enrolment is valid for ten minutes, so an operator who lost the link, or who spent the
 * window signing in, had no way back: the id only exists in the agent's console output and log, and
 * there was no screen that would simply show the pending request. That is how a revoked machine
 * became impossible to re-authorize in practice.
 *
 * So the id is now an optional shortcut, not a requirement. With no id — or with one the server no
 * longer has — this lists the live requests and lets the admin approve one. The list refreshes on
 * its own, because the agent mints a NEW request every polling round: the operator can leave this
 * page open and the next request appears by itself instead of racing a countdown.
 */
const POLL_MS = 5000;

const AdminWriteHumanAuthorize = () => {
  const [params] = useSearchParams();
  const enrollId = params.get('e') || '';
  const [rec, setRec] = useState(null);
  // loading | ready | done | error  -> the single-request flow (an explicit ?e=)
  // list                            -> choose from the live requests
  const [state, setState] = useState('loading');
  const [rows, setRows] = useState([]);
  const [ttlMinutes, setTtlMinutes] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');          // the enrollId currently being authorized
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const loadList = useCallback(async (note) => {
    try {
      const r = await writeHumanV2Admin.listEnrollments();
      if (!mounted.current) return;
      setRows(Array.isArray(r.data?.enrollments) ? r.data.enrollments : []);
      if (r.data?.ttlMinutes) setTtlMinutes(r.data.ttlMinutes);
      setState('list');
      setErr(note || '');
    } catch (e) {
      if (!mounted.current) return;
      setState('error');
      setErr(e.response?.data?.error || 'Could not load enrolment requests.');
    }
  }, []);

  const load = useCallback(async () => {
    // No id: go straight to the list rather than refusing to be useful.
    if (!enrollId) return loadList();
    try {
      const r = await writeHumanV2Admin.getEnrollment(enrollId);
      if (!mounted.current) return;
      setRec(r.data.enrollment);
      setState(r.data.enrollment?.status === 'consumed' ? 'done' : 'ready');
    } catch (e) {
      if (!mounted.current) return;
      // A stale link is the common case, not an error worth stranding anyone on: fall back to the
      // list and say why, so the next request can be approved from here.
      if (e.response?.status === 404) {
        return loadList('That request no longer exists — it expired or was already used. Live requests are listed below.');
      }
      setState('error');
      setErr(e.response?.data?.error || 'Could not load this request.');
    }
  }, [enrollId, loadList]);
  useEffect(() => { load(); }, [load]);

  // Keep the list current and the countdowns honest. Only while listing, and never after a
  // successful approval, so an approved screen does not keep polling behind the operator.
  useEffect(() => {
    if (state !== 'list') return undefined;
    const tick = setInterval(() => {
      setNow(Date.now());
      loadList();
    }, POLL_MS);
    return () => clearInterval(tick);
  }, [state, loadList]);

  const authorize = async (id) => {
    try {
      setBusy(id);
      setErr('');
      // withCsrfRetry fetches the double-submit token, and refetches once if the server says it
      // went stale. Without it this POST is rejected with csrf_invalid and the click does nothing.
      const r = await withCsrfRetry((headers) => writeHumanV2Admin.authorizeEnrollment(id, headers));
      if (!mounted.current) return;
      setRec(r.data.enrollment);
      setState('done');
    } catch (e) {
      if (!mounted.current) return;
      const code = e.response?.data?.code;
      setErr(code === 'ENROLLMENT_EXPIRED'
        ? 'That request expired before it was approved. The agent mints a new one every few seconds — leave this page open and approve the next one.'
        : code === 'csrf_invalid'
          ? 'Security token was rejected. Reload this page and try again.'
          : (code || e.response?.data?.error || 'Could not authorize this device.'));
      if (code === 'ENROLLMENT_EXPIRED') loadList('That request expired before it was approved. Live requests are listed below.');
    } finally { if (mounted.current) setBusy(''); }
  };

  const expired = rec && (rec.expired || rec.status === 'consumed');
  const live = rows.filter((r) => !r.expired && r.status !== 'consumed');
  const secondsLeft = (r) => Math.max(0, Math.round((new Date(r.expiresAt).getTime() - now) / 1000));

  const Details = ({ r }) => (
    <dl className="text-sm space-y-1">
      <div className="flex justify-between"><dt className="text-slate-500">Machine</dt><dd className="font-medium text-slate-700">{r.hostname || '—'}</dd></div>
      <div className="flex justify-between"><dt className="text-slate-500">Agent version</dt><dd className="font-medium text-slate-700">{r.agentVersion || '—'}</dd></div>
      <div className="flex justify-between"><dt className="text-slate-500">Agent id</dt><dd className="font-mono text-xs text-slate-600">{r.agentIdShort}</dd></div>
      <div className="flex justify-between"><dt className="text-slate-500">Requested</dt><dd className="font-medium text-slate-700">{new Date(r.createdAt).toLocaleTimeString()}</dd></div>
    </dl>
  );

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

          {state === 'list' && (
            <>
              {err && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-800 p-4 text-sm mb-4 flex items-start gap-2">
                  <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" /><span>{err}</span>
                </div>
              )}
              <div className="flex items-center justify-between mb-3">
                <p className="text-[13px] text-slate-500">
                  {live.length === 0
                    ? 'No machine is waiting for approval right now.'
                    : `${live.length} machine${live.length === 1 ? '' : 's'} waiting for approval.`}
                </p>
                <button onClick={() => loadList()} className="inline-flex items-center gap-1.5 text-[13px] text-blue-600 hover:underline">
                  <RefreshCw size={13} /> Refresh
                </button>
              </div>

              {live.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-600">
                  Start the agent on the machine you want to authorize. It creates a request that appears here
                  within a few seconds — this page refreshes on its own, so you can leave it open.
                  {ttlMinutes ? <> Each request is valid for about {ttlMinutes} minutes, and the agent keeps making new ones while it waits.</> : null}
                </div>
              ) : (
                <ul className="space-y-3">
                  {live.map((r) => (
                    <li key={r.enrollId} className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                      <div className="flex items-center gap-2 mb-2 text-slate-700 font-semibold">
                        <Monitor size={16} /> {r.name}
                      </div>
                      <Details r={r} />
                      <div className="flex items-center gap-1.5 text-[12px] text-slate-500 mt-2">
                        <Clock size={12} /> expires in {secondsLeft(r)}s
                      </div>
                      <button onClick={() => authorize(r.enrollId)} disabled={busy === r.enrollId}
                        className="mt-3 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-white bg-gradient-to-r from-cyan-500 to-blue-600 disabled:opacity-50">
                        {busy === r.enrollId ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                        Authorize this device
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[13px] text-slate-500 mt-4">
                Approve only a machine you started yourself. Approving lets it upload WriteHuman cookies; it never
                grants access to anything else, and you can revoke it at any time.
              </p>
            </>
          )}

          {(state === 'ready' || state === 'done') && rec && (
            <>
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 mb-4">
                <div className="flex items-center gap-2 mb-2 text-slate-700 font-semibold">
                  <Monitor size={16} /> {rec.name}
                </div>
                <Details r={rec} />
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
                  This request has expired.{' '}
                  <button onClick={() => loadList()} className="text-blue-700 underline">See the live requests</button>{' '}
                  — the agent makes a new one every few seconds while it waits.
                </div>
              ) : (
                <>
                  <p className="text-[13px] text-slate-500 mb-4">
                    Approve only if you started this agent yourself. Approving lets this machine upload WriteHuman
                    cookies; it never grants access to anything else, and you can revoke it at any time.
                  </p>
                  <button onClick={() => authorize(enrollId)} disabled={busy === enrollId}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-white bg-gradient-to-r from-cyan-500 to-blue-600 disabled:opacity-50">
                    {busy === enrollId ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
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
