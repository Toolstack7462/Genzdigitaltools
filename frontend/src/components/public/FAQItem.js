import { useState } from 'react';
import { Plus, Minus } from 'lucide-react';

const FAQItem = ({ question, answer, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      className="rounded-2xl overflow-hidden transition-all duration-200"
      style={{
        background: open ? 'rgba(0,175,193,0.07)' : 'rgba(255,255,255,0.03)',
        border: open ? '1px solid rgba(0,175,193,0.25)' : '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <button
        className="w-full flex items-start justify-between gap-4 p-5 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="text-white font-medium text-sm leading-relaxed pr-2">
          {question}
        </span>
        <span
          className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-all duration-200"
          style={{
            background: open ? 'rgba(0,175,193,0.2)' : 'rgba(255,255,255,0.06)',
          }}
        >
          {open ? (
            <Minus size={13} className="text-genz-teal" />
          ) : (
            <Plus size={13} className="text-white/50" />
          )}
        </span>
      </button>
      {open && (
        <div className="px-5 pb-5">
          <p className="text-white/55 text-sm leading-relaxed">{answer}</p>
        </div>
      )}
    </div>
  );
};

export default FAQItem;
