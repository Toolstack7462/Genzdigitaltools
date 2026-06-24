import { Search, X } from 'lucide-react';

/**
 * ListFilterBar — lightweight, reusable search + single-select filter chips +
 * "Clear filters" for admin list views (StealthWriter / Proxy Tools accounts &
 * clients). Pure UI: the parent owns the state and does the (fast, client-side)
 * filtering. No dropdowns/portals → no z-index or cut-off issues; chips wrap.
 *
 * Props:
 *   search       : string
 *   onSearch     : (value) => void
 *   placeholder  : string
 *   options      : [{ key, label }]   filter chips (include an 'all' option)
 *   value        : string             active filter key
 *   onChange     : (key) => void
 *   resultText   : string (optional)  e.g. "Showing 4 of 12"
 */
export default function ListFilterBar({ search, onSearch, placeholder, options = [], value = 'all', onChange, resultText }) {
  const dirty = (search && search.trim().length > 0) || (value && value !== 'all');
  const clear = () => { onSearch(''); onChange('all'); };
  return (
    <div className="space-y-2">
      <div className="flex flex-col lg:flex-row lg:items-center gap-2.5">
        <div className="relative flex-1 min-w-0">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" />
          <input
            type="text" value={search} onChange={(e) => onSearch(e.target.value)}
            placeholder={placeholder} aria-label={placeholder}
            className="w-full pl-9 pr-9 py-2 text-sm rounded-xl bg-white border border-genz-border text-genz-navy placeholder:text-genz-muted focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all"
          />
          {search && (
            <button type="button" onClick={() => onSearch('')} aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-genz-muted hover:text-genz-navy"><X size={15} /></button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <button key={o.key} type="button" onClick={() => onChange(o.key)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                value === o.key ? 'bg-genz-teal/10 text-genz-teal border-genz-teal/30' : 'bg-white text-genz-muted border-genz-border hover:text-genz-navy hover:border-genz-teal/40'
              }`}>
              {o.label}
            </button>
          ))}
          {dirty && (
            <button type="button" onClick={clear}
              className="px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-genz-border bg-genz-bg text-genz-navy hover:border-genz-teal/40">
              Clear filters
            </button>
          )}
        </div>
      </div>
      {dirty && resultText && <p className="text-[11px] text-genz-muted px-0.5">{resultText}</p>}
    </div>
  );
}
