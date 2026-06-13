import { useState } from 'react';
import { Plus, Minus } from 'lucide-react';

const FAQItem = ({ question, answer, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      className="rounded-2xl overflow-hidden transition-all duration-200"
      style={{
        background: open ? 'rgba(6,182,212,0.05)' : '#ffffff',
        border: open ? '1px solid rgba(6,182,212,0.3)' : '1px solid var(--brand-border)',
        boxShadow: open ? '0 12px 30px rgba(7,27,51,0.06)' : 'none',
      }}
    >
      <button
        className="w-full flex items-start justify-between gap-4 p-5 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="text-genz-navy font-semibold text-[15.5px] leading-relaxed pr-2">
          {question}
        </span>
        <span
          className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-all duration-200"
          style={{ background: open ? 'rgba(6,182,212,0.15)' : 'rgba(7,27,51,0.05)' }}
        >
          {open ? (
            <Minus size={14} className="text-genz-blue" />
          ) : (
            <Plus size={14} className="text-genz-muted" />
          )}
        </span>
      </button>
      <div
        className="grid transition-all duration-300 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <p className="px-5 pb-5 text-genz-muted text-[15px] leading-relaxed">{answer}</p>
        </div>
      </div>
    </div>
  );
};

export default FAQItem;
