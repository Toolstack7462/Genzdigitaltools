// Synthetic CRM API for the preview. No network, no production data.
const CLIENTS = [
  { id: 'cA', name: 'Ali Raza', whatsapp: '0300 1234567', email: 'ali@example.test', company: 'Raza Traders' },
  { id: 'cB', name: 'Bilal Khan', whatsapp: '0321 7654321', email: 'bilal@example.test', company: 'Khan & Co' },
  { id: 'cC', name: 'Ayesha Siddiqui', whatsapp: '0333 2223344', email: 'ayesha@example.test', company: '' },
];
const PRODUCTS = {
  PKR: [{ id: 'p1', name: 'Canva Pro (1 Year)', category: 'Design', account_type: 'shared', duration_label: '1 Year', default_sale_price: '3500.00', default_purchase_cost: '1200.00', currency_code: 'PKR' }],
  INR: [{ id: 'p2', name: 'Canva Pro (1 Year)', category: 'Design', account_type: 'shared', duration_label: '1 Year', default_sale_price: '1100.00', default_purchase_cost: '400.00', currency_code: 'INR' }],
};
const DETAIL = {
  cA: { name: 'Ali Raza', whatsapp: '0300 1234567', email: 'ali@example.test', company: 'Raza Traders',
        totals: [{ currency_code: 'PKR', pending_amount: '7250.00' }, { currency_code: 'INR', pending_amount: '0.00' }] },
  cB: { name: 'Bilal Khan', whatsapp: '0321 7654321', email: 'bilal@example.test', company: 'Khan & Co', totals: [] },
  cC: { name: 'Ayesha Siddiqui', whatsapp: '0333 2223344', totals: 'broken' },   // unusable -> "balance unknown"
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const crmApi = {
  get: async (url) => {
    await wait(220);
    const d = /^\/contacts\/clients\/([a-z]+)$/i.exec(url);
    if (d) { window.__preview.push('GET ' + url); return { data: DETAIL[d[1]] || { totals: [] } }; }
    window.__preview.push('GET ' + url);
    if (url.startsWith('/contacts/clients')) {
      const q = (/[?&]q=([^&]*)/.exec(url) || [,''])[1];
      const text = decodeURIComponent(q).toLowerCase();
      return { data: { rows: CLIENTS.filter((c) => !text || [c.name, c.whatsapp, c.email, c.company].join(' ').toLowerCase().includes(text)) } };
    }
    if (url.startsWith('/products')) {
      const cur = (/currency=([A-Z]{3})/.exec(url) || [,'PKR'])[1];
      return { data: { rows: PRODUCTS[cur] || [] } };
    }
    return { data: { rows: [] } };
  },
  post: async (url, body) => { await wait(260); window.__preview.push('POST ' + url); 
    if (url === '/contacts/clients') return { data: { id: 'cNEW', name: body.name, whatsapp: body.whatsapp, company: body.company } };
    return { data: { id: 'sale-preview-1' } }; },
  put: async () => ({ data: { id: 'sale-preview-1' } }),
};
export function messageFromError(e) { return e?.response?.data?.error || e?.message || 'Request failed'; }
