import { useState, useEffect, useCallback, useRef } from 'react';
import AdminLayoutEnhanced from '../../components/AdminLayoutEnhanced';
import AdminProxyTools from './AdminProxyTools';
import {
  PenTool, Activity, RefreshCw, Loader2, Chrome, CheckCircle2, AlertTriangle,
  Server, Cpu, Clock, Zap, RotateCw, Play, ShieldCheck, Cookie, Wifi, WifiOff,
} from 'lucide-react';
import { writeHumanV2Admin } from '../../services/writeHumanV2Service';
import { useToast } from '../../components/Toast';

// ── small presentational helpers ──────────────────────────────────────────────
const TONE = {
  ok: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  warn: 'bg-amber-50 text-amber-700 border border-amber-200',
  bad: 'bg-red-50 text-red-700 border border-red-200',
  mut: 'bg-slate-100 text-slate-600 border border-slate-200',
};
const Badge = ({ tone = 'mut', children }) => (
  <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-bold ${TONE[tone]}`}>{children}</span>
);
const rel = (iso) => { if (!iso) return 'never'; let s = (Date.now() - new Date(iso).getTime()) / 1000; if (s < 0) s = 0; return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const dur = (sec) => sec == null ? '—' : sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)}m` : `${Math.round(sec / 3600)}h`;

const StatCard = ({ icon: Icon, label, value, color }) => (
  <div className="ds-card rounded-xl p-4 flex items-center gap-3">
    <span className={`w-10 h-10 rounded-lg flex items-center justify-center text-white bg-gradient-to-br ${color}`}><Icon size={18} /></span>
    <div><p className="text-lg font-bold text-slate-800 leading-tight">{value ?? '—'}</p><p className="text-xs text-slate-500 mt-0.5">{label}</p></div>
  </div>
);
const Row = ({ k, children }) => (
  <div className="flex items-center justify-between gap-3 py-1.5 border-b border-slate-100 last:border-0 text-sm">
    <span className="text-slate-500">{k}</span><span className="font-semibold text-slate-700 text-right break-words">{children}</span>
  </div>
);
const Panel = ({ icon: Icon, title, tint = 'text-slate-500', children, right }) => (
  <div className="ds-card rounded-xl p-5">
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2"><Icon size={16} className={tint} /><h2 className="font-semibold text-slate-700 text-sm">{title}</h2></div>
      {right}
    </div>
    {children}
  </div>
);

const AdminWriteHuman = () => {
  const { showSuccess, showError } = useToast();
  const [state, setState] = useState(null);
  const [logs, setLogs] = useState([]);
  const [firstLoad, setFirstLoad] = useState(true);
  const [conn, setConn] = useState('connecting'); // connecting | live | offline | not_configured
  const [busy, setBusy] = useState('');
  const timer = useRef(null);
  const logTick = useRef(0);

  const loadState = useCallback(async () => {
    try {
      const r = await writeHumanV2Admin.getState();
      setState(r.data); setConn('live');
    } catch (e) {
      const code = e.response?.data?.code;
      if (code === 'v2_not_configured') setConn('not_configured');
      else setConn('offline');
    } finally { setFirstLoad(false); }
  }, []);

  const loadLogs = useCallback(async () => {
    try { const r = await writeHumanV2Admin.getLogs(120); if (r.data && Array.isArray(r.data.events)) setLogs(r.data.events); } catch (_) {}
  }, []);

  // Poll: state every 3s (near-real-time), logs every ~9s. Reliable through the double reverse-proxy.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      await loadState();
      if (logTick.current % 3 === 0) await loadLogs();
      logTick.current += 1;
    };
    tick();
    timer.current = setInterval(tick, 3000);
    return () => { alive = false; if (timer.current) clearInterval(timer.current); };
  }, [loadState, loadLogs]);

  const act = async (fn, okMsg) => {
    try { setBusy(okMsg); const r = await fn(); showSuccess(okMsg); loadState(); return r; }
    catch (e) { showError(e.response?.data?.error || e.response?.data?.code || 'Action failed'); }
    finally { setBusy(''); }
  };

  const a = state?.account || {};
  const ag = state?.agent || null;
  const v = a.verification || {};
  // Reconciled health drives EVERY status card so they can't contradict each other.
  const health = state?.health || 'unknown';
  const healthTone = health === 'up' ? 'ok' : health === 'degraded' ? 'warn' : health === 'down' ? 'bad' : 'mut';
  const loggedOut = a.browserAuthCookies === 0;          // agent reports the RDP browser has no auth cookie
  const stTone = healthTone;                             // Session tone follows health, not the lagging raw status
  const agTone = !ag ? 'mut' : a.agentStale ? 'warn' : 'ok';
  const cdpUp = ag && ag.cdp === '200';
  const cdpTone = !ag ? 'mut' : cdpUp ? 'ok' : 'bad';
  const syncTone = loggedOut ? 'bad' : a.agentStale == null ? 'mut' : a.agentStale ? 'warn' : 'ok';
  // One honest session label: logged-out / working / unverified / the raw down-state.
  const sessionLabel = loggedOut ? 'logged out'
    : health === 'up' ? 'working'
    : health === 'down' ? (a.sessionStatus || 'down')
    : a.workingUnverified ? 'working · unverified'
    : (a.sessionStatus || a.status || '—');

  return (
    <AdminLayoutEnhanced>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className="w-11 h-11 rounded-xl flex items-center justify-center text-white bg-gradient-to-br from-cyan-500 to-blue-600"><PenTool size={22} /></span>
          <div>
            <h1 className="font-heading text-xl font-bold text-slate-800 flex items-center gap-2">WriteHuman
              {conn === 'live' && <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600"><Wifi size={13} /> live</span>}
              {conn === 'offline' && <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-500"><WifiOff size={13} /> offline</span>}
              {conn === 'not_configured' && <span className="text-xs font-semibold text-amber-600">not configured</span>}
              {conn === 'live' && state?.health && (
                <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${
                  state.health === 'up' ? 'bg-emerald-100 text-emerald-700'
                  : state.health === 'degraded' ? 'bg-amber-100 text-amber-700'
                  : state.health === 'down' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'}`}>
                  {state.health === 'up' ? 'healthy' : state.health}
                </span>
              )}
            </h1>
            <p className="text-sm text-slate-500">Live session, agent, cookie-sync &amp; diagnostics for the WriteHuman V2 proxy.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadState} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-semibold text-white bg-slate-800 hover:bg-slate-700"><RefreshCw size={15} /> Refresh</button>
        </div>
      </div>

      {conn === 'not_configured' && (
        <div className="ds-card rounded-xl p-4 mb-5 border border-amber-200 bg-amber-50 text-amber-800 text-sm">
          The WriteHuman V2 service isn't wired to this dashboard yet. Set <code className="bg-amber-100 px-1.5 py-0.5 rounded">WRITEHUMAN_V2_ADMIN_KEY</code> (and optionally <code className="bg-amber-100 px-1.5 py-0.5 rounded">WRITEHUMAN_V2_URL</code>) in the backend env and restart.
        </div>
      )}
      {conn === 'offline' && !firstLoad && (
        <div className="ds-card rounded-xl p-4 mb-5 border border-red-200 bg-red-50 text-red-700 text-sm flex items-center gap-2"><AlertTriangle size={16} /> Can't reach the WriteHuman V2 service right now. Retrying…</div>
      )}
      {conn === 'live' && !firstLoad && health !== 'up' && health !== 'unknown' && state?.statusReason && (
        <div className={`ds-card rounded-xl p-4 mb-5 border text-sm flex items-start gap-2 ${health === 'down' ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" /><span><strong>Needs attention:</strong> {state.statusReason}</span>
        </div>
      )}

      {firstLoad ? (
        <div className="flex items-center justify-center py-20 text-slate-400"><Loader2 className="animate-spin mr-2" size={20} /> Loading…</div>
      ) : (
        <>
          {/* Big status stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <StatCard icon={ShieldCheck} label="Session" value={<Badge tone={stTone}>{sessionLabel}</Badge>} color="from-blue-500 to-cyan-500" />
            <StatCard icon={Activity} label="Sync agent" value={<Badge tone={agTone}>{!ag ? 'no report' : a.agentStale ? 'stale' : 'live'}</Badge>} color="from-emerald-500 to-teal-500" />
            <StatCard icon={Chrome} label="Chrome / CDP" value={<Badge tone={cdpTone}>{!ag ? 'unknown' : cdpUp ? 'connected' : 'down'}</Badge>} color="from-violet-500 to-fuchsia-500" />
            <StatCard icon={Cookie} label="Cookie sync" value={<Badge tone={syncTone}>{loggedOut ? 'logged out' : a.agentStale == null ? 'never' : a.agentStale ? 'stale' : 'fresh'}</Badge>} color="from-amber-500 to-orange-500" />
          </div>

          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            <Panel icon={ShieldCheck} title="Session & account" tint="text-blue-500">
              <Row k="Account">{a.label || '—'}</Row>
              <Row k="Health"><Badge tone={healthTone}>{health === 'up' ? 'healthy' : health}</Badge></Row>
              <Row k="Sign-in">{a.browserAuthCookies == null ? <Badge tone="mut">unknown</Badge> : loggedOut ? <Badge tone="bad">logged out</Badge> : <Badge tone="ok">logged in</Badge>}</Row>
              <Row k="Stored status">{a.status || '—'} / {a.sessionStatus || '—'}</Row>
              <Row k="Cookies stored">{a.cookieCount ?? '—'}</Row>
              <Row k="Bundle present">{a.hasBundle ? <Badge tone="ok">yes</Badge> : <Badge tone="warn">no</Badge>}</Row>
              <Row k="Access token valid">{a.accessTokenExpiresInSec == null ? '—' : a.accessTokenExpiresInSec <= 0 ? <Badge tone="warn">expired</Badge> : `~${dur(a.accessTokenExpiresInSec)}`}</Row>
            </Panel>

            <Panel icon={CheckCircle2} title="Verification" tint="text-emerald-500">
              <Row k="Result">{v.result ? <Badge tone={v.result === 'working' ? (a.workingUnverified ? 'warn' : 'ok') : v.result === 'session_expired' ? 'bad' : 'mut'}>{v.result === 'working' && a.workingUnverified ? 'working · unverified' : v.result}</Badge> : '—'}</Row>
              <Row k="Account (masked)">{v.maskedId || '—'}</Row>
              <Row k="HTTP">{v.httpStatus ?? '—'}</Row>
              <Row k="Last verification">{rel(a.lastVerifiedAt)}</Row>
            </Panel>

            <Panel icon={Cookie} title="Cookie sync" tint="text-amber-500">
              <Row k="Last sync">{rel(a.lastSyncedAt)}</Row>
              <Row k="Sync count">{a.syncCount ?? '—'}</Row>
              <Row k="Staleness">{a.staleSec == null ? '—' : dur(a.staleSec)}</Row>
              <Row k="Cookie hash">{a.hasCookieHash ? <Badge tone="ok">present</Badge> : <Badge tone="warn">none</Badge>}</Row>
            </Panel>

            <Panel icon={Cpu} title="Agent diagnostics" tint="text-violet-500">
              {ag ? (<>
                <Row k="Host">{ag.host || '—'}</Row>
                <Row k="Agent version">{ag.version || '—'} {state?.agentOutdated ? <Badge tone="warn">update available → {state.expectedAgentVersion}</Badge> : state?.agentOutdated === false ? <Badge tone="ok">latest</Badge> : null}</Row>
                <Row k="CDP / Chrome">{cdpUp ? <Badge tone="ok">cdp 200</Badge> : <Badge tone="bad">cdp {ag.cdp || '?'}</Badge>} {ag.chrome ? <Badge tone="ok">chrome</Badge> : <Badge tone="warn">no chrome</Badge>}</Row>
                <Row k="Polls · auth cookies">{(ag.pollCount ?? '—') + ' · ' + (ag.authCookies ?? '—')}</Row>
                <Row k="Uptime">{dur(ag.uptimeSec)}</Row>
                <Row k="Last error">{ag.lastError || 'none'}</Row>
                <Row k="Last report">{rel(ag.receivedAt)}</Row>
              </>) : <p className="text-sm text-slate-400 py-3">No agent report yet — the Cookie Sync Agent hasn't checked in.</p>}
            </Panel>

            <Panel icon={Server} title="System / health" tint="text-slate-500">
              <Row k="Mode">{state?.mode || '—'}</Row>
              <Row k="Target">{state?.target || '—'}</Row>
              <Row k="Store">{state?.store || '—'}</Row>
              <Row k="Smart timer">{state?.scheduler?.running ? <Badge tone="ok">running · {state.scheduler.intervalMin}m</Badge> : <Badge tone="warn">off</Badge>}</Row>
              <Row k="Verify exchange">{state?.verifyExchange ? <Badge tone="warn">on</Badge> : <Badge tone="ok">off (read-only)</Badge>}</Row>
            </Panel>

            <Panel icon={Zap} title="Actions" tint="text-cyan-500">
              <p className="text-[12px] text-slate-400 mb-3">Diagnostics &amp; remote control. Account vault and client assignment are managed below.</p>
              <div className="flex flex-wrap gap-2">
                <button disabled={!!busy || conn !== 'live' || !a.id} onClick={() => act(() => writeHumanV2Admin.verify(a.id), 'Verify triggered')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold text-white bg-gradient-to-r from-blue-600 to-cyan-500 disabled:opacity-50"><CheckCircle2 size={15} /> Verify now</button>
                <button disabled={!!busy || conn !== 'live'} onClick={() => act(() => writeHumanV2Admin.command('reverify'), 'Re-sync queued')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50"><RotateCw size={15} /> Re-sync</button>
                <button disabled={!!busy || conn !== 'live'} onClick={() => act(() => writeHumanV2Admin.command('relaunch-chrome'), 'Chrome relaunch queued')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50"><Play size={15} /> Relaunch Chrome</button>
              </div>
              {state?.pendingCommand && <p className="text-[12px] text-amber-600 mt-3 flex items-center gap-1"><Clock size={12} /> pending: {state.pendingCommand} (agent will pick it up next poll)</p>}
            </Panel>
          </div>

          {/* Live logs */}
          <div className="ds-card rounded-xl p-5 mt-4">
            <div className="flex items-center gap-2 mb-3"><Activity size={16} className="text-slate-500" /><h2 className="font-semibold text-slate-700 text-sm">Live logs</h2><span className="text-[11px] text-slate-400">({logs.length} events)</span></div>
            <div className="bg-slate-900 rounded-lg p-3 max-h-80 overflow-auto font-mono text-[12px] leading-relaxed">
              {logs.length === 0 ? <p className="text-slate-500">No events yet.</p> : logs.slice().reverse().map((e) => (
                <div key={e.seq} className="whitespace-pre-wrap">
                  <span className="text-slate-500">{new Date(e.t).toLocaleTimeString()}</span>{' '}
                  <span className={e.level === 'error' ? 'text-red-300' : e.level === 'warn' ? 'text-amber-300' : 'text-cyan-300'}>{e.event}</span>{' '}
                  <span className="text-slate-500">{JSON.stringify(e.fields)}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Full WriteHuman management in its OWN section — account vault + client assignment.
          Reuses the Proxy-Tools management UI locked to WriteHuman (embedded, no extra layout),
          reading/writing the SAME MySQL ProxyAccount vault + ProxyClient assignments as the live
          status above. Single source of truth; no separate store, no duplicate UI. */}
      <div className="mt-8 pt-6 border-t border-slate-200">
        <AdminProxyTools fixedTool="writehuman" embedded />
      </div>
    </AdminLayoutEnhanced>
  );
};

export default AdminWriteHuman;
