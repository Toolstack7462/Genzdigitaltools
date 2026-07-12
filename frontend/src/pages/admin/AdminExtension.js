import { useState, useEffect, useCallback, useRef } from 'react';
import AdminLayoutEnhanced from '../../components/AdminLayoutEnhanced';
import { Chrome, Upload, RefreshCw, Download, CheckCircle2, AlertTriangle, Clock, Bell, BellRing, Loader2, Search, X, ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

// Admin Chrome-extension release management. Shows the latest version (read from
// the uploaded ZIP's manifest.json — never hardcoded), lets admin upload/replace
// the ZIP in the EXISTING download folder, set the minimum-required version /
// update_required policy, and browse each client's installed version + last sync
// with SERVER-SIDE pagination, status filtering, name/email search, and sorting.
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const STATUS_TABS = [
  { key: 'all', label: 'All' },
  { key: 'updated', label: 'Updated' },
  { key: 'outdated', label: 'Outdated' },
  { key: 'unknown', label: 'Never synced' },
];

export default function AdminExtension() {
  const { showSuccess, showError } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);       // first page-level load
  const [listLoading, setListLoading] = useState(false); // subsequent list refreshes
  const [listError, setListError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [minVersion, setMinVersion] = useState('');
  const [updateRequired, setUpdateRequired] = useState(false);
  const [notifyBusy, setNotifyBusy] = useState(() => new Set()); // clientIds currently being notified
  const [notifyAllBusy, setNotifyAllBusy] = useState(false);
  const fileRef = useRef(null);

  // ── List controls (server-side) ────────────────────────────────────────────
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [status, setStatus] = useState('all');
  const [sortBy, setSortBy] = useState('lastSync');
  const [sortOrder, setSortOrder] = useState('desc');
  const [searchInput, setSearchInput] = useState(''); // raw field value
  const [search, setSearch] = useState('');           // debounced, sent to the API

  const policyInitRef = useRef(false); // seed policy inputs only on first load (don't clobber edits)
  const reqRef = useRef(0);            // stale-response guard (ignore out-of-order responses)

  // Debounce the search field — never fire an API request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1); // reset to first page when the search term changes
    }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async () => {
    const seq = ++reqRef.current;
    setListLoading(true);
    setListError(false);
    try {
      const { data: d } = await api.get('/admin/extension/release', {
        params: { page, limit: pageSize, status, search, sortBy, sortOrder },
      });
      if (seq !== reqRef.current) return; // a newer request already resolved — drop this one
      setData(d);
      // Seed the policy inputs ONCE so pagination/search refreshes never overwrite in-progress edits.
      if (!policyInitRef.current) {
        setMinVersion(d?.minimumRequiredVersion || '');
        setUpdateRequired(!!d?.updateRequired);
        policyInitRef.current = true;
      }
    } catch (err) {
      if (seq !== reqRef.current) return;
      setListError(true);
      if (!data) showError('Failed to load extension release info');
    } finally {
      if (seq === reqRef.current) { setListLoading(false); setLoading(false); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, status, search, sortBy, sortOrder, showError]);

  useEffect(() => { load(); }, [load]);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) { showError('Please choose a .zip file'); return; }
    try {
      setUploading(true);
      const buf = await file.arrayBuffer();
      const { data: r } = await api.post('/admin/extension/upload', buf, {
        headers: { 'Content-Type': 'application/zip' },
      });
      showSuccess(`Uploaded extension v${r.version}`);
      await load();
    } catch (err) {
      const msg = err?.response?.data?.error || 'Upload failed';
      showError(msg);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const savePolicy = async () => {
    try {
      const { data: r } = await api.put('/admin/extension/policy', {
        minVersion: minVersion.trim() || null,
        updateRequired,
      });
      showSuccess('Update policy saved');
      setMinVersion(r.minVersion || '');
      setUpdateRequired(!!r.updateRequired);
      await load();
    } catch (err) {
      showError(err?.response?.data?.error || 'Failed to save policy');
    }
  };

  // Build a result toast from the notify endpoint's counts.
  const summarize = (r) => {
    const parts = [];
    if (r.notified) parts.push(`${r.notified} notified`);
    if (r.debounced) parts.push(`${r.debounced} recently notified (skipped)`);
    if (r.skippedUpToDate) parts.push(`${r.skippedUpToDate} already up to date`);
    if (r.skippedNoVersion) parts.push(`${r.skippedNoVersion} never synced`);
    return parts.length ? parts.join(' · ') : 'No outdated clients to notify';
  };

  // Notify one (or several) specific outdated clients.
  const notifyClients = async (ids) => {
    const clientIds = (ids || []).filter(Boolean);
    if (clientIds.length === 0) return;
    // Guard against double-click: skip any id already in flight.
    if (clientIds.every(id => notifyBusy.has(id))) return;
    setNotifyBusy(prev => { const s = new Set(prev); clientIds.forEach(id => s.add(id)); return s; });
    try {
      const { data: r } = await api.post('/admin/extension/notify', { clientIds });
      if (r.notified) showSuccess(summarize(r));
      else showError(summarize(r));
      await load();
    } catch (err) {
      showError(err?.response?.data?.error || 'Failed to send notification');
    } finally {
      setNotifyBusy(prev => { const s = new Set(prev); clientIds.forEach(id => s.delete(id)); return s; });
    }
  };

  // Notify EVERY outdated client matching the active search (server filters + debounces) —
  // not just the clients on the current page. The scope is confirmed with the server-
  // calculated outdated count before anything is sent.
  const notifyAll = async () => {
    if (notifyAllBusy) return; // double-submit guard
    const n = data?.counts?.outdated || 0;
    if (n === 0) return;
    const scope = search
      ? `matching “${search}”`
      : 'across all pages';
    const ok = window.confirm(
      `Notify all ${n} outdated client${n > 1 ? 's' : ''} ${scope}?\n\n` +
      `This applies to ALL matching outdated clients, not just the ${data?.clients?.length || 0} shown on this page. ` +
      `Clients already up to date, never synced, or notified in the last 10 minutes are skipped automatically.`
    );
    if (!ok) return;
    setNotifyAllBusy(true);
    try {
      const { data: r } = await api.post('/admin/extension/notify', { all: true, search });
      if (r.notified) showSuccess(summarize(r));
      else showError(summarize(r));
      await load();
    } catch (err) {
      showError(err?.response?.data?.error || 'Failed to notify clients');
    } finally {
      setNotifyAllBusy(false);
    }
  };

  // ── Sort header helper ──────────────────────────────────────────────────────
  const DEFAULT_ORDER = { name: 'asc', installedVersion: 'desc', status: 'asc', lastSync: 'desc' };
  const toggleSort = (field) => {
    if (sortBy === field) setSortOrder(o => (o === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(field); setSortOrder(DEFAULT_ORDER[field] || 'asc'); }
    setPage(1);
  };
  const SortHead = ({ field, children, className = '' }) => (
    <th className={`py-2 pr-3 ${className}`}>
      <button type="button" onClick={() => toggleSort(field)}
        className="inline-flex items-center gap-1 font-semibold text-genz-muted hover:text-genz-blue">
        {children}
        {sortBy === field
          ? (sortOrder === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
          : <ChevronUp size={12} className="opacity-20" />}
      </button>
    </th>
  );

  const latest = data?.latestVersion || null;
  const clients = data?.clients || [];
  const counts = data?.counts || { all: 0, updated: 0, outdated: 0, unknown: 0 };
  const pg = data?.pagination || { currentPage: 1, pageSize, totalRecords: 0, totalPages: 1 };
  const outdatedCount = counts.outdated || 0;

  const rangeStart = pg.totalRecords === 0 ? 0 : (pg.currentPage - 1) * pg.pageSize + 1;
  const rangeEnd = Math.min(pg.currentPage * pg.pageSize, pg.totalRecords);

  // Compact windowed page numbers (max 5 around the current page).
  const pageNumbers = (() => {
    const total = pg.totalPages || 1;
    const cur = pg.currentPage || 1;
    const win = 2;
    let lo = Math.max(1, cur - win);
    let hi = Math.min(total, cur + win);
    while (hi - lo < 4 && (lo > 1 || hi < total)) {
      if (lo > 1) lo--; else if (hi < total) hi++; else break;
    }
    const out = [];
    for (let p = lo; p <= hi; p++) out.push(p);
    return out;
  })();

  return (
    <AdminLayoutEnhanced>
      <div className="max-w-5xl mx-auto space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl flex items-center justify-center text-white" style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}>
              <Chrome size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-genz-navy">Chrome Extension</h1>
              <p className="text-[13px] text-genz-muted">Manage the published extension version and update policy.</p>
            </div>
          </div>
          <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold border border-genz-border text-genz-muted hover:text-genz-blue hover:border-genz-blue/40">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        {loading ? (
          <div className="text-genz-muted text-sm py-10 text-center">Loading…</div>
        ) : (
          <>
            {/* Release summary */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="ds-card p-4">
                <div className="text-[12px] text-genz-muted">Latest version</div>
                <div className="text-2xl font-bold text-genz-navy">{latest ? `v${latest}` : '—'}</div>
                <div className="text-[11px] text-genz-muted mt-1 break-all">{data?.filename || '—'}</div>
              </div>
              <div className="ds-card p-4">
                <div className="text-[12px] text-genz-muted">Minimum required</div>
                <div className="text-2xl font-bold text-genz-navy">{data?.minimumRequiredVersion ? `v${data.minimumRequiredVersion}` : '—'}</div>
                <div className="text-[11px] mt-1 font-semibold" style={{ color: data?.updateRequired ? '#dc2626' : '#16a34a' }}>
                  {data?.updateRequired ? 'Update required: ON' : 'Update required: OFF'}
                </div>
              </div>
              <div className="ds-card p-4">
                <div className="text-[12px] text-genz-muted">Uploaded</div>
                <div className="text-[15px] font-semibold text-genz-navy flex items-center gap-1.5">
                  <Clock size={14} /> {data?.uploadedAt ? new Date(data.uploadedAt).toLocaleString() : '—'}
                </div>
                <a href={`${data?.downloadPath || '/downloads/genz-digital-store-extension.zip'}${latest ? `?v=${latest}` : ''}`}
                   download={data?.filename || 'genz-digital-store-extension.zip'} target="_blank" rel="noopener noreferrer"
                   className="inline-flex items-center gap-1.5 mt-2 text-[12.5px] font-semibold text-genz-blue">
                  <Download size={14} /> Download latest
                </a>
              </div>
            </div>

            {/* Upload + policy */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="ds-card p-4">
                <h3 className="text-[14px] font-bold text-genz-navy mb-2">Upload latest ZIP</h3>
                <p className="text-[12px] text-genz-muted mb-3">The version is read from the ZIP’s <code>manifest.json</code> and the file replaces the existing download.</p>
                <input ref={fileRef} type="file" accept=".zip,application/zip" onChange={handleUpload} disabled={uploading}
                       className="block w-full text-[12.5px] text-genz-muted file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-[12.5px] file:font-semibold file:bg-genz-blue/10 file:text-genz-blue hover:file:bg-genz-blue/20" />
                {uploading && <div className="text-[12px] text-genz-muted mt-2 inline-flex items-center gap-1.5"><Upload size={13} className="animate-pulse" /> Uploading…</div>}
              </div>
              <div className="ds-card p-4">
                <h3 className="text-[14px] font-bold text-genz-navy mb-2">Update policy</h3>
                <label className="block text-[12px] text-genz-muted mb-1">Minimum required version</label>
                <input value={minVersion} onChange={e => setMinVersion(e.target.value)} placeholder="e.g. 3.9.3"
                       className="w-full px-3 py-2 rounded-lg border border-genz-border text-[13px] mb-3" />
                <label className="inline-flex items-center gap-2 text-[13px] text-genz-navy mb-3 cursor-pointer">
                  <input type="checkbox" checked={updateRequired} onChange={e => setUpdateRequired(e.target.checked)} />
                  Require update (block tools below latest)
                </label>
                <button onClick={savePolicy} className="w-full py-2 rounded-lg text-[13px] font-bold text-white" style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}>
                  Save policy
                </button>
              </div>
            </div>

            {/* Per-client installed versions */}
            <div className="ds-card p-4">
              <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                <h3 className="text-[14px] font-bold text-genz-navy inline-flex items-center gap-2">
                  Client installed versions ({counts.all})
                  {listLoading && <Loader2 size={13} className="animate-spin text-genz-muted" />}
                </h3>
                <button
                  onClick={notifyAll}
                  disabled={notifyAllBusy || outdatedCount === 0}
                  title={outdatedCount === 0 ? 'No outdated clients in the current view' : `Notify ${outdatedCount} outdated client${outdatedCount > 1 ? 's' : ''}`}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12.5px] font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}>
                  {notifyAllBusy ? <Loader2 size={14} className="animate-spin" /> : <BellRing size={14} />}
                  Notify all outdated{outdatedCount > 0 ? ` (${outdatedCount})` : ''}
                </button>
              </div>

              {/* Controls: filters + search */}
              <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                <div className="flex items-center gap-1 flex-wrap">
                  {STATUS_TABS.map(t => {
                    const c = t.key === 'all' ? counts.all : (t.key === 'updated' ? counts.updated : (t.key === 'outdated' ? counts.outdated : counts.unknown));
                    const active = status === t.key;
                    return (
                      <button key={t.key} type="button"
                        onClick={() => { setStatus(t.key); setPage(1); }}
                        className={`px-2.5 py-1.5 rounded-lg text-[12px] font-semibold border ${active ? 'bg-genz-blue/10 border-genz-blue/40 text-genz-blue' : 'border-genz-border text-genz-muted hover:border-genz-blue/40'}`}>
                        {t.label} <span className="opacity-70">({c})</span>
                      </button>
                    );
                  })}
                </div>
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-genz-muted" />
                  <input
                    value={searchInput}
                    onChange={e => setSearchInput(e.target.value)}
                    placeholder="Search name or email…"
                    maxLength={100}
                    className="w-56 max-w-full pl-8 pr-7 py-2 rounded-lg border border-genz-border text-[12.5px]" />
                  {searchInput && (
                    <button type="button" onClick={() => setSearchInput('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-genz-muted hover:text-genz-navy" aria-label="Clear search">
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>

              {/* Table / states */}
              {listError ? (
                <div className="text-[13px] text-red-600 py-6 text-center">
                  Could not load clients. <button onClick={load} className="underline font-semibold">Retry</button>
                </div>
              ) : counts.all === 0 && !search ? (
                <div className="text-[13px] text-genz-muted py-6 text-center">No client has synced the extension yet.</div>
              ) : clients.length === 0 ? (
                <div className="text-[13px] text-genz-muted py-6 text-center">No clients match the current filters.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="text-left text-genz-muted border-b border-genz-border">
                        <SortHead field="name">Client</SortHead>
                        <SortHead field="installedVersion">Installed</SortHead>
                        <th className="py-2 pr-3">Latest</th>
                        <SortHead field="status">Status</SortHead>
                        <SortHead field="lastSync">Last sync</SortHead>
                        <th className="py-2 pr-3">Update notice</th>
                      </tr>
                    </thead>
                    <tbody>
                      {clients.map(c => (
                        <tr key={c.clientId} className="border-b border-genz-border/50">
                          <td className="py-2 pr-3">
                            <div className="font-semibold text-genz-navy">{c.name || c.email || c.clientId}</div>
                            {c.email && c.name && <div className="text-[11px] text-genz-muted">{c.email}</div>}
                          </td>
                          <td className="py-2 pr-3">{c.installedVersion ? `v${c.installedVersion}` : '—'}</td>
                          <td className="py-2 pr-3">{latest ? `v${latest}` : '—'}</td>
                          <td className="py-2 pr-3">
                            {c.updateRequired ? (
                              <span className="inline-flex items-center gap-1 text-red-600 font-semibold"><AlertTriangle size={12} /> Update required</span>
                            ) : c.isOutdated ? (
                              <span className="inline-flex items-center gap-1 text-amber-600 font-semibold"><AlertTriangle size={12} /> Outdated</span>
                            ) : c.installedVersion ? (
                              <span className="inline-flex items-center gap-1 text-green-600 font-semibold"><CheckCircle2 size={12} /> Up to date</span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-genz-muted font-semibold"><Clock size={12} /> Unknown</span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-genz-muted">{c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : '—'}</td>
                          <td className="py-2 pr-3">
                            {!c.isOutdated ? (
                              <span className="text-genz-muted">—</span>
                            ) : (
                              <div className="flex flex-col gap-1">
                                <button
                                  onClick={() => notifyClients([c.clientId])}
                                  disabled={notifyBusy.has(c.clientId)}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold border border-genz-blue/40 text-genz-blue hover:bg-genz-blue/10 disabled:opacity-50 disabled:cursor-not-allowed w-fit">
                                  {notifyBusy.has(c.clientId)
                                    ? <Loader2 size={12} className="animate-spin" />
                                    : (c.notified ? <BellRing size={12} /> : <Bell size={12} />)}
                                  {c.notified ? 'Notify again' : 'Notify update'}
                                </button>
                                {c.notified && c.notifiedAt && (
                                  <span className="text-[11px] text-green-600 inline-flex items-center gap-1">
                                    <CheckCircle2 size={11} /> Sent {new Date(c.notifiedAt).toLocaleString()}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Pagination footer */}
              {counts.all > 0 && !listError && (
                <div className="flex items-center justify-between gap-3 mt-3 flex-wrap">
                  <div className="text-[12px] text-genz-muted">
                    {pg.totalRecords === 0
                      ? 'No matching clients'
                      : `Showing ${rangeStart}–${rangeEnd} of ${pg.totalRecords} client${pg.totalRecords > 1 ? 's' : ''}`}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <label className="text-[12px] text-genz-muted inline-flex items-center gap-1.5">
                      Rows
                      <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
                        className="px-2 py-1.5 rounded-lg border border-genz-border text-[12px]">
                        {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </label>
                    <div className="inline-flex items-center gap-1">
                      <button type="button" onClick={() => setPage(p => Math.max(1, p - 1))}
                        disabled={pg.currentPage <= 1 || listLoading}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold border border-genz-border text-genz-muted hover:text-genz-blue hover:border-genz-blue/40 disabled:opacity-40 disabled:cursor-not-allowed">
                        <ChevronLeft size={13} /> Prev
                      </button>
                      {pageNumbers.map(p => (
                        <button key={p} type="button" onClick={() => setPage(p)} disabled={listLoading}
                          className={`min-w-[30px] px-2 py-1.5 rounded-lg text-[12px] font-semibold border ${p === pg.currentPage ? 'bg-genz-blue/10 border-genz-blue/40 text-genz-blue' : 'border-genz-border text-genz-muted hover:border-genz-blue/40'}`}>
                          {p}
                        </button>
                      ))}
                      <button type="button" onClick={() => setPage(p => Math.min(pg.totalPages, p + 1))}
                        disabled={pg.currentPage >= pg.totalPages || listLoading}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold border border-genz-border text-genz-muted hover:text-genz-blue hover:border-genz-blue/40 disabled:opacity-40 disabled:cursor-not-allowed">
                        Next <ChevronRight size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </AdminLayoutEnhanced>
  );
}
