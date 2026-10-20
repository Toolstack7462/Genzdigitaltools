// WriteHuman Extension Credential Auto-Sync — admin management section.
//
// Lives inside Admin → WriteHuman, below the proxy monitoring. It manages the EXTENSION
// credential auto-sync policy (official-domain flow), which is DISTINCT from the proxy/subdomain
// cookie sync shown above. It reflects the real backend state and never shows a "verified" or
// "synced" status from agent connectivity or a stale verification — only from a server
// canary-confirmed result the backend reports.
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ShieldCheck, RefreshCw, Loader2, CheckCircle2, AlertTriangle, HelpCircle, Play, Pause,
  UserCheck, Lock, Globe, Clock, XCircle, Fingerprint,
} from 'lucide-react';
import { writeHumanV2Admin } from '../../services/writeHumanV2Service';
import { withCsrfRetry } from '../../services/launchService';
import { useToast } from '../../components/Toast';
import { verification, deriveControls } from './writeHumanAutoSyncLogic';
import { createLatestOnly } from '../../lib/latestOnly';

const VER_ICON = { Verified: CheckCircle2, Failed: XCircle, Inconclusive: HelpCircle, Pending: Clock };

const fmtAgo = (t) => {
  if (!t) return '—';
  const ms = Date.now() - new Date(t).getTime();
  if (isNaN(ms)) return '—';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const TONE = {
  emerald: 'bg-emerald-100 text-emerald-700', amber: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-700', slate: 'bg-slate-100 text-slate-600', blue: 'bg-blue-100 text-blue-700',
};
function Pill({ tone = 'slate', icon: Icon, children }) {
  return <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${TONE[tone]}`}>{Icon && <Icon size={12} />}{children}</span>;
}
function Field({ label, children }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">{label}</div>
      <div className="text-[13px] text-slate-700 font-medium truncate">{children}</div>
    </div>
  );
}
function Confirm({ open, title, body, confirmLabel, tone = 'slate', busy, onConfirm, onCancel }) {
  if (!open) return null;
  const btn = tone === 'red' ? 'bg-red-600 hover:bg-red-500' : tone === 'emerald' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-slate-800 hover:bg-slate-700';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
      <div className="ds-card rounded-2xl bg-white p-5 max-w-md w-full shadow-xl">
        <h3 className="font-heading text-base font-bold text-slate-800 mb-1">{title}</h3>
        <div className="text-sm text-slate-600 mb-4">{body}</div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="px-3.5 py-2 rounded-xl text-[13px] font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200">Cancel</button>
          <button onClick={onConfirm} disabled={busy} className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-semibold text-white ${btn} disabled:opacity-60`}>
            {busy && <Loader2 size={15} className="animate-spin" />}{confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function WriteHumanAutoSync() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [data, setData] = useState(null);     // { accountId, policy }
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState(null); // { kind, ... }
  const [pick, setPick] = useState('');         // the Tool chosen in the selector, not yet saved

  // ORDERING GUARD — the SAME `createLatestOnly` gate AdminWriteHuman and AdminProxyTools already
  // use, not a second implementation. A Refresh and an action can be in flight at once, and the
  // slower response used to win simply by arriving last: a delayed status read could overwrite the
  // state a successful Enable/Approve/binding save had just returned, showing the operator the OLD
  // policy and inviting them to "fix" it again. `inFlight` additionally collapses repeated Refresh
  // clicks; `busy` already serialises the actions.
  const gate = useRef(createLatestOnly());
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const ticket = gate.current.issue();
    setLoading(true); setErr('');
    try {
      const { data: resp } = await writeHumanV2Admin.getAutoSync();
      if (!gate.current.accept(ticket)) return;
      setData(resp && resp.success ? resp : null);
      if (!resp || !resp.success) setErr('Auto-sync policy is unavailable.');
    } catch (e) {
      const code = e?.response?.status;
      if (!gate.current.accept(ticket)) return;
      // The existing policy in hand is kept: a failed read must not fabricate empty settings.
      setErr(code === 401 ? 'Your admin session expired — please sign in again.' : code === 400 ? 'WriteHuman is not a live-agent tool on this backend.' : code === 409 ? 'No WriteHuman source account is configured.' : 'Could not reach the auto-sync API.');
    } finally { inFlight.current = false; setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Follow the persisted binding whenever the policy we hold changes (including after a save), so
  // the selector shows what is actually in force rather than a stale local choice.
  const persistedToolId = data?.policy?.approvedToolId || '';
  useEffect(() => { setPick(persistedToolId); }, [persistedToolId]);

  const mutate = useCallback(async (payload, kind, successMsg) => {
    if (busy) return null;                                  // one action at a time
    const ticket = gate.current.issue();
    setBusy(kind);
    try {
      const { data: resp } = await withCsrfRetry((headers) => writeHumanV2Admin.setAutoSync(payload, headers));
      if (resp && resp.success) {
        if (gate.current.accept(ticket)) setData(resp);      // the PERSISTED post-action state
        toast?.success?.(successMsg || 'Updated');
      } else toast?.error?.('The backend rejected the change.');
      return resp;
    } catch (e) {
      const code = e?.response?.status;
      const body = e?.response?.data;
      // A 409 from the Tool picker names what IS selectable; surface that rather than a generic
      // conflict, and refresh so the stale option disappears from the list.
      if (code === 409 && body?.code === 'tool_not_eligible') {
        toast?.error?.('That Tool is no longer an active WriteHuman Tool — the list has been refreshed.');
        load();
      } else {
        toast?.error?.(code === 409 ? (body?.error || 'Conflict — refresh and retry.') : code === 401 ? 'Session expired — sign in again.' : 'Update failed.');
      }
      return null;
    } finally { setBusy(''); setConfirm(null); }
  }, [toast, busy, load]);

  const p = data?.policy || null;
  const s = p?.status || {};
  const ver = verification(s);
  const d = deriveControls(p);
  const { eligibleCount, ambiguous, approved, awaiting, enabled, mode, observedKey } = d;

  return (
    <section className="mt-6">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <div className="flex items-center gap-2.5">
          <span className="w-9 h-9 rounded-xl flex items-center justify-center text-white bg-gradient-to-br from-violet-500 to-fuchsia-600"><ShieldCheck size={18} /></span>
          <div>
            <h2 className="font-heading text-base font-bold text-slate-800">Extension Credential Auto-Sync</h2>
            <p className="text-xs text-slate-500">Official-domain (<span className="font-mono">writehuman.ai</span>) credential record — <span className="font-semibold">separate</span> from the proxy cookie sync above.</p>
          </div>
        </div>
        <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-semibold text-white bg-slate-800 hover:bg-slate-700 disabled:opacity-60">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh Status
        </button>
      </div>

      <div className="ds-card rounded-xl p-4 border border-slate-200 bg-white">
        {loading && !data ? (
          <div className="flex items-center gap-2 text-slate-500 text-sm py-4"><Loader2 size={16} className="animate-spin" /> Loading policy…</div>
        ) : err ? (
          <div className="flex items-center gap-2 text-amber-700 text-sm py-2"><AlertTriangle size={16} /> {err}</div>
        ) : !p ? (
          <div className="text-slate-500 text-sm py-2">No policy configured yet.</div>
        ) : (
          <>
            {/* top badges */}
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <Pill tone={enabled ? 'emerald' : 'slate'} icon={enabled ? Play : Pause}>{enabled ? 'Enabled' : 'Disabled'}</Pill>
              <Pill tone={mode === 'enforce' ? 'blue' : 'slate'}>{mode === 'enforce' ? 'Enforce' : 'Observe'}</Pill>
              <Pill tone={ver.tone} icon={VER_ICON[ver.label]}>{ver.label}</Pill>
              <Pill tone={approved ? 'emerald' : 'amber'} icon={approved ? Lock : UserCheck}>{approved ? 'Approved' : awaiting ? 'Awaiting approval' : 'Approval pending'}</Pill>
              {s.pending && <Pill tone="amber" icon={Clock}>pending recovery</Pill>}
            </div>

            {ambiguous && (
              <div className="rounded-lg p-2.5 mb-3 border border-amber-200 bg-amber-50 text-amber-800 text-[12px] flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  {eligibleCount} eligible <span className="font-mono">writehuman.ai</span> Tools — auto-sync will not guess which one receives credentials.
                  {d.eligibleTools.length > 0 && (
                    <> Candidates: {d.eligibleTools.map((t) => t.name || t.id).join(', ')}.</>
                  )}
                  {' '}Bind one of them explicitly, or leave only one active. A Tool with clients assigned must <span className="font-semibold">not</span> be removed to resolve this.
                </span>
              </div>
            )}
            {!ambiguous && eligibleCount > 1 && d.bindingHonoured && (
              <div className="rounded-lg p-2.5 mb-3 border border-emerald-200 bg-emerald-50 text-emerald-800 text-[12px] flex items-center gap-2">
                <Lock size={14} /> {eligibleCount} Tools are eligible; auto-sync is explicitly bound to one of them. The others are never written to.
              </div>
            )}
            {d.bindingStale && (
              <div className="rounded-lg p-2.5 mb-3 border border-red-200 bg-red-50 text-red-700 text-[12px] flex items-start gap-2">
                <XCircle size={14} className="mt-0.5 shrink-0" />
                <span>
                  The selected Tool is no longer available — it has been deleted, disabled or moved off{' '}
                  <span className="font-mono">{p.officialDomain || 'the official domain'}</span>.
                  Auto-sync has stopped and will <span className="font-semibold">not</span> fall back to any other Tool.
                  Select the intended Tool below to resume.
                </span>
              </div>
            )}

            {/* TOOL SELECTION. Deliberately not gated on activation: ambiguity and a stale binding
                are precisely the states where this control is the only way forward. */}
            {d.canSelectTool && (
              <div className="rounded-lg p-3 mb-3 border border-slate-200 bg-slate-50">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 mb-1.5">
                  <Lock size={14} /> Auto-sync target Tool
                </div>
                <p className="text-[11px] text-slate-500 mb-2">
                  Several Tools serve this official domain. Only the Tool you select here ever receives
                  synced credentials; the others are left entirely untouched, including their own
                  credentials and client assignments.
                </p>
                <div className="flex items-end gap-2 flex-wrap">
                  <label className="min-w-0 flex-1">
                    <span className="block text-[11px] uppercase tracking-wide text-slate-400 font-semibold mb-1">Selected Tool</span>
                    <select
                      value={pick}
                      disabled={!!busy}
                      onChange={(e) => setPick(e.target.value)}
                      className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-[13px] text-slate-700 disabled:opacity-60"
                    >
                      <option value="">— none selected —</option>
                      {d.eligibleTools.map((t) => (
                        <option key={t.id} value={t.id}>
                          {(t.name || 'Unnamed Tool')}{t.domain ? ` · ${t.domain}` : ''} · id …{String(t.id).slice(-6)}
                        </option>
                      ))}
                      {d.bindingStale && d.boundToolId && (
                        <option value={d.boundToolId} disabled>
                          (previously selected, no longer available) · id …{String(d.boundToolId).slice(-6)}
                        </option>
                      )}
                    </select>
                  </label>
                  <button
                    disabled={!!busy || !pick || String(pick) === String(d.boundToolId || '')}
                    onClick={() => setConfirm({ kind: 'bindTool', toolId: pick })}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-semibold text-white bg-slate-800 hover:bg-slate-700 disabled:opacity-60"
                  >
                    {busy === 'bindTool' ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />} Save target
                  </button>
                  {d.boundToolId && (
                    <button
                      disabled={!!busy}
                      onClick={() => setConfirm({ kind: 'clearTool' })}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-60"
                    >
                      {busy === 'clearTool' ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />} Clear selection
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-slate-400 mt-2">
                  Saving a target changes only the target. It does not enable or disable auto-sync,
                  does not change Observe/Enforce, and does not alter the approved account.
                </p>
              </div>
            )}
            {eligibleCount === 0 && (
              <div className="rounded-lg p-2.5 mb-3 border border-slate-200 bg-slate-50 text-slate-600 text-[12px] flex items-center gap-2">
                <Globe size={14} /> No active <span className="font-mono">writehuman.ai</span> Tool found — idle. The panel will bind automatically once one exists (after Refresh).
              </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-3 gap-y-3 gap-x-4 mb-3">
              <Field label="Verification">{ver.label}<span className="text-slate-400 font-normal"> · {ver.detail}</span></Field>
              <Field label="Eligible Tool">{
                eligibleCount === 1
                  ? <span className="font-mono text-[12px]">{p.eligibleToolIds[0]}</span>
                  : d.bindingHonoured
                    ? <span className="inline-flex items-center gap-1">
                        <Lock size={12} className="text-emerald-600" />
                        <span>{(d.eligibleTools.find((t) => String(t.id) === String(d.boundToolId)) || {}).name || 'bound'}</span>
                        <span className="text-slate-400 font-normal">(bound, {eligibleCount} eligible)</span>
                      </span>
                    : `${eligibleCount} tools`
              }</Field>
              <Field label="Official domain">{p.officialDomain || '—'}</Field>
              <Field label="Approved account">{approved ? <span className="inline-flex items-center gap-1"><Fingerprint size={12} className="text-emerald-600" /><span className="font-mono text-[12px]">{p.approvedAccountKey}</span></span> : <span className="text-amber-600">not approved</span>}</Field>
              <Field label="Authenticated identity">{s.lastIdentity || '—'}{observedKey && !approved ? <span className="text-slate-400 font-normal"> (id {String(observedKey).slice(0, 8)}…)</span> : null}</Field>
              <Field label="Source device">{s.lastSourceDeviceId ? <span className="font-mono text-[11px]">{String(s.lastSourceDeviceId).slice(0, 18)}…</span> : '—'}</Field>
              <Field label="Last detection">{fmtAgo(s.lastDetectedAt)}</Field>
              <Field label="Last verification">{fmtAgo(s.lastVerifiedAt)}</Field>
              <Field label="Last committed sync">{fmtAgo(s.lastSyncAt)}</Field>
            </div>

            {s.lastError && ver.label === 'Failed' && (
              <div className="rounded-lg p-2.5 mb-3 border border-red-200 bg-red-50 text-red-700 text-[12px] flex items-center gap-2"><XCircle size={14} /> Last error: <span className="font-mono">{s.lastError}</span></div>
            )}
            {awaiting && observedKey && (
              <div className="rounded-lg p-3 mb-3 border border-violet-200 bg-violet-50 text-violet-800 text-[12px]">
                <div className="flex items-center gap-1.5 font-semibold mb-1"><UserCheck size={14} /> Provider-authenticated account awaiting your approval</div>
                A live session was confirmed for identity <span className="font-mono">{s.lastIdentity || '(masked)'}</span> (account id <span className="font-mono">{observedKey}</span>).
                Confirm independently that this is your intended WriteHuman account, then approve it. Nothing is committed until you do.
              </div>
            )}

            {/* controls */}
            <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-slate-100 mt-1">
              {!enabled && (
                <button disabled={!!busy || ambiguous} onClick={() => mutate({ enabled: true, mode: 'observe' }, 'enable', 'Auto-sync enabled in Observe mode')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60">
                  {busy === 'enable' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Enable (Observe)
                </button>
              )}
              {enabled && (
                <button disabled={!!busy} onClick={() => setConfirm({ kind: 'disable' })}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-60">
                  <Pause size={14} /> Pause / Disable
                </button>
              )}
              {enabled && awaiting && observedKey && !approved && (
                <button disabled={!!busy} onClick={() => setConfirm({ kind: 'approve' })}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-semibold text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-60">
                  <UserCheck size={14} /> Approve this account
                </button>
              )}
              {enabled && approved && mode !== 'enforce' && (
                <button disabled={!!busy || ver.label !== 'Verified'} title={ver.label !== 'Verified' ? 'Wait for a Verified status first' : 'Switch to Enforce'}
                  onClick={() => setConfirm({ kind: 'enforce' })}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-60">
                  <Lock size={14} /> Switch to Enforce
                </button>
              )}
              {enabled && mode === 'enforce' && (
                <button disabled={!!busy} onClick={() => mutate({ enabled: true, mode: 'observe' }, 'observe', 'Switched back to Observe')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-60">
                  <Pause size={14} /> Back to Observe
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <Confirm open={confirm?.kind === 'disable'} title="Disable auto-sync?" tone="red" confirmLabel="Disable" busy={busy === 'disable'}
        body="Auto-sync will stop updating the extension credential record. Existing credentials are left untouched; the proxy flow is unaffected."
        onCancel={() => setConfirm(null)} onConfirm={() => mutate({ enabled: false }, 'disable', 'Auto-sync disabled')} />
      {/* Binding-only payloads. The backend preserves omitted enabled/mode, so saving a target
          cannot disable the policy or drop Enforce as a side effect. */}
      <Confirm open={confirm?.kind === 'bindTool'} title="Set the auto-sync target Tool?" tone="slate" confirmLabel="Save target" busy={busy === 'bindTool'}
        body={<>
          Synced credentials will be written <span className="font-semibold">only</span> to{' '}
          <span className="font-semibold">{(d.eligibleTools.find((t) => String(t.id) === String(confirm?.toolId)) || {}).name || 'the selected Tool'}</span>
          {' '}(id <span className="font-mono">…{String(confirm?.toolId || '').slice(-6)}</span>).
          {d.boundToolId && String(d.boundToolId) !== String(confirm?.toolId || '') && <> This replaces the current target.</>}
          {' '}Every other Tool on this domain keeps its own credentials and client assignments, untouched.
          Auto-sync stays {enabled ? 'enabled' : 'disabled'} and in {mode === 'enforce' ? 'Enforce' : 'Observe'} mode.
        </>}
        onCancel={() => setConfirm(null)}
        onConfirm={() => mutate({ approvedToolId: confirm?.toolId }, 'bindTool', 'Auto-sync target saved')} />
      <Confirm open={confirm?.kind === 'clearTool'} title="Clear the auto-sync target?" tone="red" confirmLabel="Clear selection" busy={busy === 'clearTool'}
        body={<>
          Auto-sync will have no selected Tool. With more than one eligible Tool it will stop and wait
          for a choice rather than guess, so credentials will not be updated until you select a target
          again. Nothing is written to any Tool in the meantime, and the approved account is kept.
        </>}
        onCancel={() => setConfirm(null)}
        onConfirm={() => mutate({ clearToolBinding: true }, 'clearTool', 'Auto-sync target cleared')} />
      <Confirm open={confirm?.kind === 'approve'} title="Approve this WriteHuman account?" tone="emerald" confirmLabel="Approve account" busy={busy === 'approve'}
        body={<>You are approving account <span className="font-mono">{s.lastIdentity || '(masked)'}</span> (id <span className="font-mono">{observedKey}</span>) as the authorized source. Only credentials for this exact account will ever be synced. Confirm you have independently verified this is correct.</>}
        onCancel={() => setConfirm(null)} onConfirm={() => mutate({ enabled: true, mode, approveObserved: true }, 'approve', 'Account approved')} />
      <Confirm open={confirm?.kind === 'enforce'} title="Switch to Enforce mode?" tone="blue" confirmLabel="Enable Enforce" busy={busy === 'enforce'}
        body="Enforce mode lets a verified rotation update the live extension credential record (the next client launch picks it up). This does not touch active customer sessions. Proceed only if verification and account approval are correct."
        onCancel={() => setConfirm(null)} onConfirm={() => mutate({ enabled: true, mode: 'enforce' }, 'enforce', 'Enforce mode enabled')} />
    </section>
  );
}
