import { useState } from 'react';
import { X, Plus } from 'lucide-react';

/**
 * Client CRM tags/labels — organisational only (distinct from the access `status`).
 * Shared chip + editor used on the client form, profile panel, and members list.
 */
export const SUGGESTED_TAGS = [
  'VIP', 'Trial', 'Paid', 'Unpaid', 'Renewal Due', 'Reseller', 'Blocked', 'Priority',
];

const TAG_STYLES = {
  vip:            'bg-amber-100 text-amber-700 border-amber-200',
  trial:          'bg-blue-100 text-blue-700 border-blue-200',
  paid:           'bg-green-100 text-green-700 border-green-200',
  unpaid:         'bg-red-100 text-red-700 border-red-200',
  'renewal due':  'bg-orange-100 text-orange-700 border-orange-200',
  reseller:       'bg-purple-100 text-purple-700 border-purple-200',
  blocked:        'bg-genz-navy/10 text-genz-navy border-genz-border',
  priority:       'bg-pink-100 text-pink-700 border-pink-200',
};

export function tagClass(tag) {
  return TAG_STYLES[String(tag || '').toLowerCase()] || 'bg-genz-bg text-genz-muted border-genz-border';
}

export function TagChip({ tag, onRemove }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${tagClass(tag)}`}>
      {tag}
      {onRemove && (
        <button type="button" onClick={onRemove} className="hover:opacity-70" aria-label={`Remove ${tag}`}>
          <X size={11} />
        </button>
      )}
    </span>
  );
}

/**
 * TagEditor — add (from suggestions or custom) / remove tags. Controlled.
 * value: string[]   onChange: (next: string[]) => void
 */
export function TagEditor({ value = [], onChange, max = 12 }) {
  const [input, setInput] = useState('');
  const has = (t) => value.some(v => v.toLowerCase() === t.toLowerCase());
  const add = (t) => {
    const s = String(t || '').trim().slice(0, 24);
    if (!s || has(s) || value.length >= max) return;
    onChange([...value, s]);
    setInput('');
  };
  const remove = (t) => onChange(value.filter(v => v !== t));
  const remaining = SUGGESTED_TAGS.filter(t => !has(t));

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map(t => <TagChip key={t} tag={t} onRemove={() => remove(t)} />)}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(input); } }}
          placeholder={value.length >= max ? 'Tag limit reached' : 'Add a tag…'}
          maxLength={24}
          disabled={value.length >= max}
          className="flex-1 min-w-0 px-3 py-2 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder:text-genz-muted focus:outline-none focus:border-genz-teal disabled:opacity-60"
          data-testid="tag-input"
        />
        <button type="button" onClick={() => add(input)} disabled={!input.trim() || value.length >= max}
          className="inline-flex items-center gap-1 px-2.5 h-9 rounded-lg border border-genz-border bg-white text-genz-teal hover:bg-genz-teal/10 text-sm font-semibold disabled:opacity-50">
          <Plus size={14} /> Add
        </button>
      </div>
      {remaining.length > 0 && value.length < max && (
        <div className="flex flex-wrap gap-1.5">
          {remaining.map(t => (
            <button key={t} type="button" onClick={() => add(t)}
              className={`px-2 py-0.5 rounded-full text-[11px] font-medium border border-dashed ${tagClass(t)} opacity-80 hover:opacity-100`}>
              + {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
