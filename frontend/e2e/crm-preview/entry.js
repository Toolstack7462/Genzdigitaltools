import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SaleForm from 'crm/features/business-crm/pages/SaleForm';
import 'crm/features/business-crm/business-crm.css';
import 'crm/features/business-crm/business-crm-responsive.css';

window.__preview = [];

function Shell() {
  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', background: '#F1F5F9', minHeight: '100vh' }}>
      <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 700, letterSpacing: '.5px', color: '#64748B', textTransform: 'uppercase' }}>
        CRM preview · synthetic data · no network
      </p>
      <div style={{ background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 3px rgba(15,23,42,.08)' }}>
        <MemoryRouter initialEntries={['/admin/business/sales/new']}>
          <Routes>
            <Route path="/admin/business/sales/new" element={<SaleForm />} />
            <Route path="/admin/business/clients/:id" element={<p style={{ padding: 20 }}>Client profile (preview stub)</p>} />
            <Route path="/admin/business/sales/:id" element={<p style={{ padding: 20 }}>Saved sale (preview stub)</p>} />
          </Routes>
        </MemoryRouter>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<Shell />);
