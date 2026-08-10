import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, LoaderCircle, MessageCircle, Plus, RefreshCw, Search, X } from 'lucide-react';
import { formatMoney } from '../constants';
export function PageHeader({ title, description, actions }) { return <div className="bcrm-page-head"><div><p className="bcrm-eyebrow">Gen Z Business Console</p><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="bcrm-actions">{actions}</div>}</div>; }
export function Button({ children, variant = 'primary', icon: Icon, ...props }) { return <button className={`bcrm-btn bcrm-btn-${variant}`} {...props}>{Icon && <Icon size={16} />}{children}</button>; }
export function AddButton({ children = 'Add new', ...props }) { return <Button icon={Plus} {...props}>{children}</Button>; }
export function Card({ title, subtitle, actions, children, className = '' }) { return <section className={`bcrm-card ${className}`}><header className="bcrm-card-head"><div>{title && <h2>{title}</h2>}{subtitle && <p>{subtitle}</p>}</div>{actions}</header><div className="bcrm-card-body">{children}</div></section>; }
export function Metric({ label, value, hint, tone = 'blue', currency }) { return <article className={`bcrm-metric bcrm-tone-${tone}`}><span className="bcrm-metric-mark"/><p>{label}</p><strong>{currency ? formatMoney(value, currency) : value}</strong>{hint && <small>{hint}</small>}</article>; }
export function Loading({ label = 'Loading business data…' }) { return <div className="bcrm-state"><LoaderCircle className="bcrm-spin" size={30}/><strong>{label}</strong></div>; }
export function ErrorState({ message, onRetry }) { return <div className="bcrm-state bcrm-state-error"><AlertTriangle size={30}/><strong>Could not load this workspace</strong><p>{message}</p>{onRetry && <Button variant="secondary" icon={RefreshCw} onClick={onRetry}>Try again</Button>}</div>; }
export function Empty({ title = 'No records yet', description = 'Create the first record to begin.' }) { return <div className="bcrm-empty"><strong>{title}</strong><p>{description}</p></div>; }
export function Table({ columns, rows, rowKey = 'id', empty, onRow, className = '' }) { if (!rows?.length) return <Empty {...empty}/>; return <div className={`bcrm-table-wrap ${className}`.trim()}><table className="bcrm-table"><thead><tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={row[rowKey] || index} onClick={onRow ? () => onRow(row) : undefined} className={onRow ? 'is-clickable' : ''}>{columns.map((column) => <td key={column.key} data-label={column.label}>{column.render ? column.render(row) : row[column.key] ?? '—'}</td>)}</tr>)}</tbody></table></div>; }
export function Field({ label, hint, className = '', children }) { return <label className={`bcrm-field ${className}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function Input(props) { return <input className="bcrm-input" {...props}/>; }
export function Select(props) { return <select className="bcrm-input" {...props}/>; }
// className MERGES rather than replaces: spreading props over a hardcoded className would drop the
// base .bcrm-input styling the moment a caller passed one of its own.
export function Textarea({ className = '', ...props }) { return <textarea className={`bcrm-input bcrm-textarea ${className}`.trim()} {...props}/>; }
export function Status({ children, tone = 'neutral', className = '' }) { return <span className={`bcrm-status bcrm-status-${tone} ${className}`.trim()}>{children}</span>; }

/**
 * Read-only preview of a prepared customer message, with copy and an explicit send action.
 *
 * WHY A PREVIEW AT ALL: the reminder flows previously called window.open() AFTER awaiting the prepare
 * request. A popup opened outside a user gesture is blocked by default in Chrome and Safari, so the
 * WhatsApp tab silently never appeared while the reminder was already recorded as prepared. Opening
 * from a button inside this dialog is a real gesture, so it is not blocked — and the operator gets to
 * read what is about to be sent to a customer before it goes.
 */
export function MessagePreview({ open, title = 'Message preview', message, recipient, url, onClose, onSend }) {
  const [copied, setCopied] = useState('');
  useEffect(() => { if (open) setCopied(''); }, [open, message]);
  if (!open) return null;
  const copy = async () => {
    try {
      // navigator.clipboard needs a secure context; the textarea fallback keeps copy working on
      // plain HTTP and in older browsers rather than failing silently.
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(message || '');
      else {
        const scratch = document.createElement('textarea');
        scratch.value = message || '';
        scratch.setAttribute('readonly', 'readonly');
        scratch.style.position = 'fixed';
        scratch.style.opacity = '0';
        document.body.appendChild(scratch);
        scratch.select();
        document.execCommand('copy');
        document.body.removeChild(scratch);
      }
      setCopied('Message copied to your clipboard.');
    } catch { setCopied('Copy is unavailable in this browser — select the text above instead.'); }
  };
  return <Modal
    open={open}
    title={title}
    onClose={onClose}
    footer={<>
      <Button variant="secondary" onClick={copy}>Copy message</Button>
      {url && <Button icon={MessageCircle} onClick={() => onSend?.(url)}>Open in WhatsApp</Button>}
    </>}
  >
    <div className="bcrm-form">
      {recipient && <p className="bcrm-modal-note">Sending to {recipient}. Review the wording before it goes out.</p>}
      {/* Read-only textarea rather than a <pre>: it keeps line breaks, wraps on mobile, and lets the
          operator select the text manually if the clipboard API is blocked. */}
      <Textarea className="bcrm-message-preview" readOnly rows={9} value={message || ''} aria-label="Prepared message text" />
      {copied && <p className="bcrm-modal-note">{copied}</p>}
    </div>
  </Modal>;
}
/**
 * Toolbar search field. `busy` shows a quiet inline spinner while a request for the current text is
 * still in flight — pages must NOT unmount this component to show a full-page loader, because that
 * takes the focus out of the input and the operator loses the rest of what they were typing.
 */
export function SearchBox({ value, onChange, placeholder = 'Search…', busy = false, autoFocus = false, label }) {
  return <label className="bcrm-search">
    <Search size={16} aria-hidden="true"/>
    <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label || placeholder} autoFocus={autoFocus} type="search"/>
    {busy && <LoaderCircle className="bcrm-spin bcrm-search-busy" size={14} aria-hidden="true"/>}
    {value && <button type="button" onClick={() => onChange('')} aria-label="Clear search"><X size={14}/></button>}
  </label>;
}

/**
 * Async single-select combobox.
 *
 * Replaces the "load 500 rows into a <select>" pattern: it asks the caller's `search(term)` for at
 * most a page of matches once two characters are typed, and the caller decides whether that runs
 * against the API or an offline cache. Every request takes a ticket so a slow earlier response can
 * never overwrite a newer one.
 *
 * `search` resolves to [{ id, label, hint, raw }]. `onSelect` receives the whole option, so callers
 * that need the underlying record (product auto-fill) get it without a second lookup.
 */
export function Combobox({
  value, valueLabel = '', search, onSelect, onClear, placeholder = 'Type to search…',
  required = false, disabled = false, minChars = 2, debounceMs = 250, emptyHint = 'No matches', footer, name,
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [options, setOptions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1);
  const [failed, setFailed] = useState('');
  const ticket = useRef(0);
  const wrap = useRef(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const text = term.trim();
    if (text.length < minChars) { setOptions([]); setBusy(false); setFailed(''); return undefined; }
    setBusy(true);
    const timer = setTimeout(async () => {
      const mine = ticket.current + 1; ticket.current = mine;
      try {
        const found = await search(text);
        if (mine !== ticket.current) return;
        setOptions(found || []); setActive((found || []).length ? 0 : -1); setFailed('');
      } catch (error) {
        if (mine !== ticket.current) return;
        setOptions([]); setActive(-1); setFailed('Could not search right now');
      } finally { if (mine === ticket.current) setBusy(false); }
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [term, open, minChars, debounceMs, search]);

  // Close when focus or a click leaves the widget entirely.
  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (event) => { if (wrap.current && !wrap.current.contains(event.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  const choose = (option) => { onSelect(option); setOpen(false); setTerm(''); setOptions([]); setActive(-1); };
  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      if (!options.length) return;
      setActive((current) => {
        const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
        return (next + options.length) % options.length;
      });
      return;
    }
    if (event.key === 'Enter') {
      // Only swallow Enter when a suggestion is highlighted, so Enter still submits the form
      // when the operator is not picking from the list.
      if (open && active >= 0 && options[active]) { event.preventDefault(); choose(options[active]); }
      return;
    }
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
  };

  const selected = Boolean(value) && Boolean(valueLabel);
  return <div className={`bcrm-combo ${disabled ? 'is-disabled' : ''}`.trim()} ref={wrap}>
    {selected && !open
      ? <div className="bcrm-combo-selected">
        <button type="button" className="bcrm-combo-value" disabled={disabled} onClick={() => { if (!disabled) { setOpen(true); setTerm(''); } }} aria-label={`${valueLabel} — change selection`}>
          <span>{valueLabel}</span><ChevronDown size={15} aria-hidden="true"/>
        </button>
        {onClear && !disabled && <button type="button" className="bcrm-combo-clear" onClick={() => { onClear(); setTerm(''); setOpen(false); }} aria-label="Clear selection"><X size={14}/></button>}
      </div>
      : <div className="bcrm-combo-input">
        <Search size={15} aria-hidden="true"/>
        <input
          className="bcrm-input" type="text" role="combobox" autoComplete="off"
          aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-haspopup="listbox"
          aria-activedescendant={open && active >= 0 && options[active] ? `${listId}-${active}` : undefined}
          value={term} disabled={disabled} placeholder={placeholder}
          onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
          onChange={(event) => { setTerm(event.target.value); setOpen(true); }}
        />
        {busy && <LoaderCircle className="bcrm-spin" size={14} aria-hidden="true"/>}
      </div>}
    {/* A hidden mirror carries `required` so the browser's own form validation still applies. */}
    {required && <input type="text" name={name} value={value || ''} required tabIndex={-1} aria-hidden="true" className="bcrm-combo-mirror" onChange={() => {}}/>}
    {open && <div className="bcrm-combo-pop">
      <ul className="bcrm-combo-list" role="listbox" id={listId}>
        {options.map((option, index) => <li key={option.id} id={`${listId}-${index}`} role="option" aria-selected={index === active}>
          <button type="button" className={index === active ? 'is-active' : undefined} onMouseEnter={() => setActive(index)} onClick={() => choose(option)}>
            <strong>{option.label}</strong>{option.hint && <small>{option.hint}</small>}
          </button>
        </li>)}
      </ul>
      {!busy && term.trim().length >= minChars && !options.length && <p className="bcrm-combo-note">{failed || emptyHint}</p>}
      {term.trim().length < minChars && <p className="bcrm-combo-note">Type at least {minChars} characters</p>}
      {footer && <div className="bcrm-combo-foot">{footer}</div>}
    </div>}
  </div>;
}
export function Modal({ open, title, children, onClose, footer }) { if (!open) return null; return <div className="bcrm-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section className="bcrm-modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button onClick={onClose} aria-label="Close"><X size={19}/></button></header><div className="bcrm-modal-body">{children}</div>{footer && <footer>{footer}</footer>}</section></div>; }
