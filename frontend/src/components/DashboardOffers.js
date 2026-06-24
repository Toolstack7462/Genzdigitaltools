import { useState, useEffect } from 'react';
import { Gift, Package, Tag, MessageCircle } from 'lucide-react';
import api from '../services/api';
import { SUPPORT_WHATSAPP_NUMBER } from '../lib/support';

/* ─── DashboardOffers ─────────────────────────────────────────────────────────
   Curated promotional offers for the signed-in client. Reuses GET /client/offers
   (backend caps at 2 + filters to active/non-expired/targeted), so this is clean
   by design — no popups, max 2 cards. Fetched independently after the dashboard
   renders and fully fail-safe: renders NOTHING until offers exist (no skeleton, no
   layout shift). "Claim" opens WhatsApp support with a safe pre-filled message. */

const KIND_ACCENT = { combo: '#2563EB', renewal: '#D97706', upgrade: '#7C3AED', recovery: '#DC2626' };

const DashboardOffers = () => {
  const [offers, setOffers] = useState([]);

  useEffect(() => {
    let alive = true;
    api.get('/client/offers')
      .then(r => { if (alive) setOffers(Array.isArray(r.data?.offers) ? r.data.offers.slice(0, 2) : []); })
      .catch(() => { /* fail-safe: never disrupt the dashboard */ });
    return () => { alive = false; };
  }, []);

  if (offers.length === 0) return null;

  const claim = (o) => {
    const text = encodeURIComponent(`Hello, I'm interested in this offer: ${o.title}`);
    window.open(`https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${text}`, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {offers.map((o) => {
        const accent = KIND_ACCENT[o.kind] || '#2563EB';
        return (
          <div key={o._id} className="relative overflow-hidden rounded-2xl px-4 py-3.5"
               style={{ background: 'linear-gradient(120deg, rgba(7,27,51,0.96) 0%, rgba(12,38,66,0.95) 100%)', border: `1px solid ${accent}55`, boxShadow: `0 12px 30px -20px ${accent}99, inset 0 1px 0 rgba(255,255,255,0.05)` }}>
            <div className="absolute inset-y-0 left-0 w-[3px]" style={{ background: `linear-gradient(180deg, ${accent}, transparent)` }} />
            <div className="flex items-start gap-3">
              <span className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 text-white"
                    style={{ background: `${accent}33`, border: `1px solid ${accent}66` }}><Gift size={16} /></span>
              <div className="flex-1 min-w-0">
                <p className="text-[13.5px] font-bold text-white leading-snug">{o.title}</p>
                {o.description && <p className="text-[12px] text-white/70 mt-1 leading-relaxed line-clamp-2 break-words">{o.description}</p>}
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  {o.priceText && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold text-white" style={{ background: `${accent}33`, border: `1px solid ${accent}66` }}>
                      <Tag size={10} /> {o.priceText}
                    </span>
                  )}
                  {(o.toolNames || []).slice(0, 3).map((t, i) => (
                    <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-white/80" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}>
                      <Package size={10} /> {t}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <button onClick={() => claim(o)}
                    className="mt-3 w-full inline-flex items-center justify-center gap-1.5 py-2 rounded-lg text-[12.5px] font-bold text-white transition-all hover:-translate-y-0.5"
                    style={{ background: 'linear-gradient(135deg,#22c55e,#16a34a)' }}>
              <MessageCircle size={14} /> Claim this offer
            </button>
          </div>
        );
      })}
    </div>
  );
};

export default DashboardOffers;
