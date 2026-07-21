import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Save, ChevronDown, ChevronRight, AlertTriangle, Loader2 } from 'lucide-react';
import { proxyToolsAdmin } from '../../services/proxyToolsService';
import { useToast } from '../Toast';

/**
 * Claude usage dashboard (claude-only, admin). Shows every Claude client's ESTIMATED local
 * token usage — five-hour + weekly limit/used/remaining, reset times, Custom/Default, account,
 * limit-reached / account-capacity status — plus editable GLOBAL defaults and per-client history.
 * Read-only w.r.t. everything else: no Personal/Team, session, account-widget or other tool.
 * All figures are "Estimated local token usage", not Anthropic's official counts.
 */
const n = (v) => Number(v || 0).toLocaleString();
// Human countdown to a reset, e.g. "4h 55m" / "12m" / "now" — never the ambiguous "5h: 5h".
const fmtCountdown = (secs) => {
  const s = Math.max(0, Number(secs || 0));
  if (s <= 0) return 'now';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h >= 1) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
};
const fmtAt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const GLOBAL_FIELDS = [
  ['defaultClientLimit', '5-hr default / client'],
  ['defaultWeeklyClientLimit', 'Weekly default / client'],
  ['accountBaseTokens', 'Account 5-hr base (Pro 1×)'],
  ['accountWeeklyBaseTokens', 'Account weekly base (Pro 1×)'],
  ['safetyReservePct', 'Safety reserve %'],
];

const Meter = ({ used, limit, reached }) => {
  const u = Number(used), l = Number(limit);
  const over = l > 0 ? u > l : u > 0;                             // limit 0 is a hard-stop → any usage is "over"
  const pct = l > 0 ? Math.min(100, (u / l) * 100) : (u > 0 ? 100 : 0); // bar capped 100%; full when hard-stopped
  return (
    <div className="min-w-[120px]">
      <div className="flex justify-between text-[11px] mb-0.5">
        <span className={reached || over ? 'text-red-600 font-semibold' : 'text-genz-navy'}>{n(used)} / {n(limit)}</span>
        <span className={over ? 'text-red-600 font-semibold' : 'text-genz-muted'}>{over ? 'Limit exceeded' : `${n(Math.max(0, limit - used))} left`}</span>
      </div>
      <div className="h-1.5 rounded-full bg-genz-soft overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: (reached || over) ? '#ef4444' : 'linear-gradient(135deg,#da7756,#c15f3c)' }} />
      </div>
    </div>
  );
};

const Tag = ({ ok, children }) => (
  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${ok ? 'bg-slate-100 text-slate-500' : 'bg-red-100 text-red-700'}`}>{children}</span>
);

const ClaudeUsageDashboard = () => {
  const { showSuccess, showError } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [globals, setGlobals] = useState(null);
  const [gForm, setGForm] = useState({});
  const [savingG, setSavingG] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [history, setHistory] = useState({});
  const [genAt, setGenAt] = useState(null);
  // Admin model switch: "Allow Fable 5". Saved independently of the quota numbers so toggling
  // it can never disturb the limits, and vice versa. Defaults to false (blocked) until loaded.
  const [allowFable5, setAllowFable5] = useState(false);
  const [savingF, setSavingF] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [d, g] = await Promise.all([
        proxyToolsAdmin.usageDashboard('claude'),
        proxyToolsAdmin.getGlobalConfig('claude'),
      ]);
      setRows(d.data?.rows || []);
      setGenAt(d.data?.generatedAt || null);
      const eff = g.data?.global?.effective || {};
      const ov = g.data?.global?.overrides || {};
      setGlobals({ effective: eff, overrides: ov });
      setAllowFable5(g.data?.global?.flags?.allowFable5 === true);
      // Pre-fill the editor with the current OVERRIDE values only (blank = inherit).
      setGForm(Object.fromEntries(GLOBAL_FIELDS.map(([k]) => [k, ov[k] != null ? String(ov[k]) : ''])));
    } catch (e) {
      showError(e.response?.data?.error || 'Failed to load usage dashboard');
    } finally { setLoading(false); }
  }, [showError]);

  useEffect(() => { load(); }, [load]);

  const saveGlobals = async () => {
    try {
      setSavingG(true);
      // Blank → null (clears the override → inherit env/hardcoded default).
      const body = Object.fromEntries(GLOBAL_FIELDS.map(([k]) => [k, gForm[k] === '' ? null : Math.max(0, parseInt(gForm[k], 10) || 0)]));
      await proxyToolsAdmin.setGlobalConfig('claude', body);
      showSuccess('Global limits saved'); load();
    } catch (e) { showError(e.response?.data?.error || 'Failed to save global limits'); }
    finally { setSavingG(false); }
  };

  // Sends ONLY allowFable5, so a model-switch change never rewrites the quota overrides.
  const saveFable5 = async (next) => {
    try {
      setSavingF(true);
      await proxyToolsAdmin.setGlobalConfig('claude', { allowFable5: next });
      setAllowFable5(next);
      showSuccess(next ? 'Fable 5 enabled for Claude clients' : 'Fable 5 disabled for Claude clients');
      load();
    } catch (e) {
      showError(e.response?.data?.error || 'Failed to change the Fable 5 setting');
      load();  // re-sync from the server so the switch never shows a state that was not saved
    } finally { setSavingF(false); }
  };

  const toggleHistory = async (id) => {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (!history[id]) {
      try {
        const r = await proxyToolsAdmin.usageHistory('claude', id, 25);
        setHistory(h => ({ ...h, [id]: r.data?.history || [] }));
      } catch (_) { setHistory(h => ({ ...h, [id]: [] })); }
    }
  };

  return (
    <div className="space-y-4">
      {/* Global limits editor */}
      <div className="ds-card rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-genz-navy">Global Claude limits <span className="text-genz-muted font-normal">— Estimated local token usage</span></h3>
          <button onClick={load} className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-genz-border bg-genz-bg text-[12.5px] font-medium text-genz-navy hover:border-genz-teal/50">
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {GLOBAL_FIELDS.map(([k, label]) => (
            <div key={k}>
              <label className="block text-[11px] font-medium text-genz-navy mb-1">{label}</label>
              <input type="number" min={0} className="w-full px-2.5 py-1.5 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:border-genz-teal"
                value={gForm[k] ?? ''} onChange={e => setGForm(f => ({ ...f, [k]: e.target.value }))}
                placeholder={globals?.effective?.[k] != null ? String(globals.effective[k]) : ''} />
              <p className="text-[10px] text-genz-muted mt-0.5">{globals?.overrides?.[k] != null ? 'Custom' : `Default ${n(globals?.effective?.[k])}`}</p>
            </div>
          ))}
        </div>
        <div className="flex justify-end mt-3">
          <button onClick={saveGlobals} disabled={savingG} className="btn-grad inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-60">
            {savingG ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save global limits
          </button>
        </div>
        <p className="text-[11px] text-genz-muted mt-2">Priority: client override → Claude-account default → <b>global default</b> → system fallback. Blank = inherit. Applies immediately to future requests.</p>

        {/* Model availability — separate from the quota numbers above and saved on its own, so
            toggling a model can never rewrite the limits (and saving limits can never flip a
            model back on). Enforced server-side in the Claude gateway, not just hidden in the UI. */}
        <div className="mt-4 pt-4 border-t border-genz-border">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <p className="text-[12.5px] font-semibold text-genz-navy">Allow Fable 5</p>
              <p className="text-[11px] text-genz-muted mt-0.5 max-w-xl">
                {allowFable5
                  ? 'Clients can select Fable 5.'
                  : 'Fable 5 is hidden from the client model picker, and any request for it — including a modified or replayed one — is switched to Opus 4.8 (effort Medium, thinking Off). Existing Fable 5 conversations move over on their next message.'}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={allowFable5}
              aria-label="Allow Fable 5"
              disabled={savingF}
              onClick={() => saveFable5(!allowFable5)}
              className={`relative inline-flex h-6 w-11 flex-none items-center rounded-full transition-colors disabled:opacity-60 ${allowFable5 ? 'bg-genz-teal' : 'bg-genz-border'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${allowFable5 ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          <p className={`text-[11px] mt-2 font-medium ${allowFable5 ? 'text-amber-600' : 'text-genz-muted'}`}>
            {savingF ? 'Saving…' : allowFable5 ? 'On — Fable 5 is available to clients.' : 'Off — Fable 5 is disabled by your administrator.'}
          </p>
        </div>
      </div>

      {/* Per-client usage table */}
      {loading ? (
        <div className="ds-card rounded-xl p-10 text-center text-genz-muted"><Loader2 size={22} className="mx-auto mb-2 animate-spin" />Loading usage…</div>
      ) : rows.length === 0 ? (
        <div className="ds-card rounded-xl p-10 text-center text-genz-muted">No Claude clients yet.</div>
      ) : (
        <div className="ds-card rounded-xl overflow-x-auto">
          <table className="ds-table min-w-[880px]">
            <thead><tr>
              <th>Client</th><th>Account</th><th>5-hr (used / limit)</th><th>Weekly (used / limit)</th>
              <th>Resets</th><th>Status</th><th></th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <FragmentRow key={r.id} r={r} expanded={expanded === r.id} onToggle={() => toggleHistory(r.id)} history={history[r.id]} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-genz-muted">Estimated local token usage — a proxy-side estimate, not Anthropic's official token counts.{genAt ? ` Updated ${fmtAt(genAt)}.` : ''}</p>
    </div>
  );
};

const FragmentRow = ({ r, expanded, onToggle, history }) => {
  const f = r.fiveHour || {}, w = r.weekly || {};
  return (
    <>
      <tr>
        <td>
          <p className="font-semibold text-genz-navy text-sm">{r.client?.fullName || '—'}</p>
          <p className="text-xs text-genz-muted">{r.client?.email}</p>
          <span className={`ds-badge ${r.expired ? 'ds-badge-danger' : (r.active ? 'ds-badge-success' : 'ds-badge-neutral')}`}><span className="dot" /> {r.expired ? 'expired' : r.clientStatus}</span>
        </td>
        <td className="text-xs">
          {r.accountLabel || <span className="text-genz-muted italic">unassigned</span>}
          {r.planLabel && <div className="text-[10px] text-genz-muted">{r.planLabel}</div>}
        </td>
        <td>{r.synced ? <><Meter used={f.used} limit={f.limit} reached={f.reached} /><div className="mt-0.5 text-[10px]"><span className={`px-1.5 py-0.5 rounded-full font-semibold ${f.isCustom ? 'bg-genz-teal/10 text-genz-teal' : 'bg-slate-100 text-slate-500'}`}>{f.isCustom ? 'Custom' : 'Default'}</span></div></> : <span className="text-genz-muted italic text-xs">Not synced</span>}</td>
        {/* Weekly USAGE shows whenever the ledger read succeeded (r.synced) — exactly like the
            five-hour cell and the compact widget. A missing weeklyResetAt only makes the RESET
            column "Not synced" (below); it must NOT hide the counted weekly usage. */}
        <td>{r.synced ? <><Meter used={w.used} limit={w.limit} reached={w.reached} /><div className="mt-0.5 text-[10px]"><span className={`px-1.5 py-0.5 rounded-full font-semibold ${w.isCustom ? 'bg-genz-teal/10 text-genz-teal' : 'bg-slate-100 text-slate-500'}`}>{w.isCustom ? 'Custom' : 'Default'}</span></div></> : <span className="text-genz-muted italic text-xs">Not synced</span>}</td>
        <td className="text-[11px] text-genz-muted">
          <div>5-hr: {f.resetOfficial
            ? <span title={fmtAt(f.resetAt)}>in {fmtCountdown(f.resetInSeconds)}</span>
            : <span className="italic">Not synced</span>}</div>
          <div>Weekly: {w.synced
            ? <span title={`in ${fmtCountdown(w.resetInSeconds)}`}>{fmtAt(w.resetAt)}</span>
            : <span className="italic">Not synced</span>}</div>
        </td>
        <td className="space-y-0.5">
          {f.reached && <Tag>5h limit reached</Tag>}
          {w.reached && <Tag>weekly limit reached</Tag>}
          {f.accountAtCapacity && <Tag>account 5h full</Tag>}
          {w.accountAtCapacity && <Tag>account wk full</Tag>}
          {!f.reached && !w.reached && !f.accountAtCapacity && !w.accountAtCapacity && <Tag ok>ok</Tag>}
        </td>
        <td>
          <button onClick={onToggle} className="inline-flex items-center gap-1 h-7 px-2 rounded-lg border border-genz-border bg-genz-bg text-[11.5px] text-genz-navy hover:border-genz-teal/50">
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />} History
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="bg-genz-bg/40">
            {!history ? (
              <div className="p-3 text-xs text-genz-muted"><Loader2 size={13} className="inline animate-spin mr-1" /> Loading…</div>
            ) : history.length === 0 ? (
              <div className="p-3 text-xs text-genz-muted">No recent usage recorded.</div>
            ) : (
              <div className="p-3">
                <table className="w-full text-[11px]">
                  <thead><tr className="text-genz-muted text-left"><th className="py-1">When</th><th>Input</th><th>Context</th><th>Output</th><th>Total</th></tr></thead>
                  <tbody>
                    {history.map((h, i) => (
                      <tr key={i} className="border-t border-genz-border/50">
                        <td className="py-1">{fmtAt(h.at)}</td>
                        <td>{n(h.inputTokens)}</td><td>{n(h.contextTokens)}</td><td>{n(h.outputTokens)}</td>
                        <td className="font-semibold text-genz-navy">{n(h.totalTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[10px] text-genz-muted mt-1 flex items-center gap-1"><AlertTriangle size={10} /> Estimated local token usage, not Anthropic's official counts.</p>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
};

export default ClaudeUsageDashboard;
