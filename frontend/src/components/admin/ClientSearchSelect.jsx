import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Search, ChevronDown, X, Loader2, Check } from 'lucide-react';

/**
 * ClientSearchSelect — accessible searchable combobox for picking ONE CRM client.
 *
 * Search by name OR email; options render as "Name — Email".
 * Keyboard: ↑/↓ move, Enter selects, Esc closes, Home/End jump. Clearable (✕).
 * Loading + empty states are built in. Pure presentation — selection is the
 * client `_id` string, identical to the native <select> it replaces, so callers
 * keep their existing value/onChange contract.
 *
 * Props:
 *  - clients      array of { _id, fullName, email }
 *  - value        selected client _id (string) | ''
 *  - onChange     (id: string) => void   ('' when cleared)
 *  - loading      bool — show a loading row in the list
 *  - disabled     bool
 *  - placeholder  string
 *  - id           string — used for ARIA wiring
 *  - ariaLabel    string
 *  - className    surface classes for the trigger (bg/border/focus). When omitted
 *                 a white + slate default is used.
 */
const norm = (s) => String(s || '').toLowerCase();

export default function ClientSearchSelect({
  clients = [],
  value = '',
  onChange,
  loading = false,
  disabled = false,
  placeholder = 'Select a client…',
  id,
  ariaLabel = 'Search and select a client',
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const listboxId = `${id || 'client'}-listbox`;

  const selected = useMemo(
    () => clients.find((c) => String(c._id) === String(value)) || null,
    [clients, value]
  );

  const filtered = useMemo(() => {
    const q = norm(query).trim();
    if (!q) return clients;
    return clients.filter((c) => norm(c.fullName).includes(q) || norm(c.email).includes(q));
  }, [clients, query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  // On open: focus the search box and reset the highlight. On close: clear query.
  useEffect(() => {
    if (open) {
      setActive(0);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    setQuery('');
    return undefined;
  }, [open]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${active}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = useCallback((c) => {
    if (!c) return;
    onChange?.(String(c._id));
    setOpen(false);
  }, [onChange]);

  const clear = useCallback((e) => {
    e.stopPropagation();
    onChange?.('');
    setQuery('');
  }, [onChange]);

  const onTriggerKeyDown = (e) => {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onSearchKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[active]) choose(filtered[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(filtered.length - 1);
    }
  };

  const triggerLayout =
    'w-full flex items-center gap-2 text-left rounded-lg px-3 py-2 text-sm border transition-colors ' +
    'focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed';
  const triggerSurface = className || 'bg-white border-slate-200 text-slate-800 focus:border-genz-teal';

  return (
    <div className="relative" ref={rootRef}>
      <div
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        className={`${triggerLayout} ${triggerSurface} ${disabled ? '' : 'cursor-pointer'}`}
      >
        <Search size={15} className="shrink-0 text-slate-400" />
        <span className={`flex-1 min-w-0 truncate ${selected ? '' : 'text-slate-400'}`}>
          {selected ? (
            <>
              {selected.fullName || 'Unnamed'}
              {selected.email ? <span className="text-slate-400"> — {selected.email}</span> : null}
            </>
          ) : placeholder}
        </span>
        {selected && !disabled ? (
          <span
            role="button"
            tabIndex={-1}
            aria-label="Clear selection"
            title="Clear selection"
            onClick={clear}
            className="shrink-0 text-slate-400 hover:text-slate-600 p-0.5 rounded"
          >
            <X size={15} />
          </span>
        ) : (
          <ChevronDown size={15} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        )}
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-xl overflow-hidden">
          <div className="flex items-center gap-2 px-2.5 py-2 border-b border-slate-100">
            <Search size={15} className="shrink-0 text-slate-400" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={onSearchKeyDown}
              placeholder="Search name or email…"
              aria-label="Search clients by name or email"
              aria-controls={listboxId}
              aria-autocomplete="list"
              className="w-full bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none"
            />
          </div>

          <ul ref={listRef} role="listbox" id={listboxId} className="max-h-56 overflow-y-auto py-1">
            {loading ? (
              <li className="flex items-center gap-2 px-3 py-3 text-sm text-slate-400">
                <Loader2 size={15} className="animate-spin" /> Loading clients…
              </li>
            ) : filtered.length === 0 ? (
              <li className="px-3 py-3 text-sm text-slate-400">
                {clients.length === 0 ? 'No clients available' : 'No clients match your search'}
              </li>
            ) : (
              filtered.map((c, idx) => {
                const isSel = String(c._id) === String(value);
                const isActive = idx === active;
                return (
                  <li
                    key={c._id}
                    data-idx={idx}
                    role="option"
                    aria-selected={isSel}
                    onMouseEnter={() => setActive(idx)}
                    onMouseDown={(e) => { e.preventDefault(); choose(c); }}
                    className={`flex items-center gap-2 px-3 py-2 cursor-pointer text-sm ${isActive ? 'bg-genz-teal/10' : ''}`}
                  >
                    <span className="flex-1 min-w-0 truncate">
                      <span className="font-medium text-slate-800">{c.fullName || 'Unnamed'}</span>
                      {c.email ? <span className="text-slate-400"> — {c.email}</span> : null}
                    </span>
                    {isSel && <Check size={15} className="shrink-0 text-genz-teal" />}
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
