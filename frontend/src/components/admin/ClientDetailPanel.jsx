import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Clock, LogIn, ShieldAlert, ShieldOff, Smartphone, Package, Trash2, Edit2,
  CheckCircle2, AlertCircle, FileText, Activity as ActivityIcon, Loader2, Pencil
} from 'lucide-react';
import api from '../../services/api';

/**
 * ClientDetailPanel — read-only profile + activity timeline for ONE client.
 *
 * Surfaces data the backend already returns from GET /admin/clients/:id
 * (client, assignments, deviceBinding, activityLogs) — previously never shown in
 * the UI. Pure presentation; performs NO mutations (notes are edited via the
 * existing client edit form). Never renders secrets.
 */
const fmt = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

// Map an activity action to an icon + friendly label. Defensive: unknown actions
// fall back to a humanised version of the action string.
function describe(a) {
  const action = String(a.action || '').toUpperCase();
  const meta = a.meta || {};
  if (action.includes('LOGIN') && action.includes('FAIL')) return { Icon: ShieldAlert, tone: 'text-red-500', text: 'Login failed' + (meta.reason ? ` — ${meta.reason}` : '') };
  if (action.includes('LOGIN') && action.includes('BLOCK')) return { Icon: ShieldOff, tone: 'text-amber-500', text: 'Login blocked (device)' };
  if (action.includes('LOGIN')) return { Icon: LogIn, tone: 'text-green-500', text: 'Signed in' };
  if (action.includes('DEVICE_RESET')) return { Icon: Smartphone, tone: 'text-cyan-500', text: 'Device reset' };
  if (action.includes('TOOL_OPEN') || action.includes('TOOL_ACCESS')) return { Icon: Package, tone: 'text-purple-500', text: `Opened ${meta.toolName || meta.tool || 'a tool'}` };
  if (action.includes('LEASE')) return { Icon: Package, tone: 'text-purple-500', text: `Opened ${meta.toolName || meta.tool || 'a proxy tool'}` };
  if (action.includes('ASSIGN')) return { Icon: CheckCircle2, tone: 'text-green-500', text: `Tool assigned${meta.toolName ? `: ${meta.toolName}` : ''}` };
  if (action.includes('REVOKE')) return { Icon: AlertCircle, tone: 'text-amber-500', text: 'Access revoked' };
  if (action.includes('DELETE')) return { Icon: Trash2, tone: 'text-red-500', text: 'Deleted' };
  if (action.includes('UPDATE') || action.includes('EDIT')) return { Icon: Edit2, tone: 'text-yellow-500', text: 'Account updated' };
  return { Icon: ActivityIcon, tone: 'text-genz-muted', text: action.replace(/_/g, ' ').toLowerCase() };
}

const Stat = ({ label, value }) => (
  <div className="bg-genz-bg border border-genz-border rounded-xl px-3 py-2">
    <p className="text-[11px] uppercase tracking-wide text-genz-muted">{label}</p>
    <p className="text-sm font-semibold text-genz-navy truncate">{value}</p>
  </div>
);

export default function ClientDetailPanel({ clientId, onEdit }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!clientId) return;
    try {
      setLoading(true);
      setError(false);
      const res = await api.get(`/admin/clients/${clientId}`);
      setData(res.data);
    } catch (_) {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading client detail">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-14 rounded-xl bg-genz-navy/10 animate-pulse" />)}
        </div>
        <div className="h-20 rounded-xl bg-genz-navy/10 animate-pulse" />
        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-10 rounded-lg bg-genz-navy/10 animate-pulse" />)}
      </div>
    );
  }

  if (error || !data?.client) {
    return (
      <div className="text-center py-10">
        <AlertCircle size={26} className="mx-auto mb-2 text-genz-muted" />
        <p className="text-sm font-semibold text-genz-navy">Couldn't load client detail</p>
        <button onClick={load} className="text-xs text-genz-teal hover:underline mt-1">Try again</button>
      </div>
    );
  }

  const c = data.client;
  const logs = Array.isArray(data.activityLogs) ? data.activityLogs : [];
  const assignments = Array.isArray(data.assignments) ? data.assignments : [];
  const activeCount = assignments.filter(a => a.status === 'active').length;

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Status" value={c.status === 'active' ? 'Active' : 'Disabled'} />
        <Stat label="Last login" value={c.lastLoginAt ? fmt(c.lastLoginAt) : 'Never'} />
        <Stat label="Tools" value={`${activeCount} active / ${assignments.length}`} />
        <Stat label="Device" value={data.deviceBinding ? 'Bound' : 'None'} />
      </div>

      {/* Notes */}
      <div className="border border-genz-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-genz-navy">
            <FileText size={15} className="text-genz-teal" />
            <span className="text-sm font-semibold">Internal notes</span>
            <span className="text-[11px] text-genz-muted">(payment / renewal)</span>
          </div>
          <button
            type="button"
            onClick={() => (onEdit ? onEdit(c) : navigate(`/admin/clients/${c._id}/edit`))}
            className="inline-flex items-center gap-1 text-xs font-medium text-genz-teal hover:underline"
          >
            <Pencil size={12} /> Edit
          </button>
        </div>
        {c.notes && String(c.notes).trim() ? (
          <p className="text-sm text-genz-navy whitespace-pre-wrap break-words">{c.notes}</p>
        ) : (
          <p className="text-sm text-genz-muted italic">No notes yet — add payment or renewal details in the client edit form.</p>
        )}
      </div>

      {/* Timeline */}
      <div>
        <div className="flex items-center gap-2 text-genz-navy mb-2">
          <Clock size={15} className="text-genz-teal" />
          <span className="text-sm font-semibold">Recent activity</span>
          <span className="text-[11px] text-genz-muted">(last {logs.length})</span>
        </div>
        {logs.length === 0 ? (
          <p className="text-sm text-genz-muted py-4 text-center border border-genz-border rounded-xl">No recent activity recorded.</p>
        ) : (
          <ol className="relative border-l border-genz-border ml-2">
            {logs.map((l) => {
              const { Icon, tone, text } = describe(l);
              return (
                <li key={l._id} className="ml-4 pb-4 last:pb-0">
                  <span className="absolute -left-[9px] w-[18px] h-[18px] rounded-full bg-white border border-genz-border flex items-center justify-center">
                    <Icon size={11} className={tone} />
                  </span>
                  <p className="text-sm text-genz-navy">{text}</p>
                  <p className="text-[11px] text-genz-muted">{fmt(l.createdAt)}</p>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
