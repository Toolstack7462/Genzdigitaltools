import { Navigate, Route, Routes } from 'react-router-dom';
import { BusinessCrmProvider, useBusinessCrm } from './BusinessCrmContext';
import BusinessCrmLayout from './BusinessCrmLayout';
import Dashboard from './pages/Dashboard';
import Sales from './pages/Sales';
import SaleForm from './pages/SaleForm';
import SaleDetail from './pages/SaleDetail';
import Contacts from './pages/Contacts';
import ContactDetail from './pages/ContactDetail';
import Products from './pages/Products';
import Payments from './pages/Payments';
import Expiries from './pages/Expiries';
import LinkedAccess from './pages/LinkedAccess';
import Expenses from './pages/Expenses';
import Reports from './pages/Reports';
import Cashbook from './pages/Cashbook';
import Tasks from './pages/Tasks';
import SearchPage from './pages/SearchPage';
import SettingsPage from './pages/SettingsPage';
import AccessPage from './pages/AccessPage';
import AuditPage from './pages/AuditPage';
import ImportsPage from './pages/ImportsPage';
import OfflineQueue from './pages/OfflineQueue';
import Forbidden from './pages/Forbidden';
import './business-crm.css';

function Gate({ permission, children }) {
  const crm = useBusinessCrm();
  return crm.has(permission) ? children : <Navigate to="/admin/business/forbidden" replace />;
}
const protectedPage = (permission, element) => <Gate permission={permission}>{element}</Gate>;

export default function BusinessCrmApp() {
  return <BusinessCrmProvider><Routes><Route element={<BusinessCrmLayout />}>
    <Route index element={protectedPage('dashboard.view', <Dashboard />)} />
    <Route path="sales" element={protectedPage('sales.view', <Sales />)} />
    <Route path="sales/new" element={protectedPage('sales.create', <SaleForm />)} />
    <Route path="sales/:id/edit" element={protectedPage('sales.edit', <SaleForm />)} />
    <Route path="sales/:id" element={protectedPage('sales.view', <SaleDetail />)} />
    <Route path="clients" element={protectedPage('clients.view', <Contacts kind="clients" />)} />
    <Route path="clients/:id" element={protectedPage('clients.view', <ContactDetail kind="clients" />)} />
    <Route path="vendors" element={protectedPage('vendors.view', <Contacts kind="vendors" />)} />
    <Route path="vendors/:id" element={protectedPage('vendors.view', <ContactDetail kind="vendors" />)} />
    <Route path="products" element={protectedPage('products.view', <Products />)} />
    <Route path="client-pending" element={protectedPage('clients.view', <Payments type="client" />)} />
    <Route path="vendor-dues" element={protectedPage('vendors.view', <Payments type="vendor" />)} />
    <Route path="website-access" element={protectedPage('website-access.view', <LinkedAccess />)} />
    <Route path="expiries" element={protectedPage('expiries.view', <Expiries />)} />
    <Route path="expenses" element={protectedPage('expenses.view', <Expenses />)} />
    <Route path="reports" element={protectedPage('reports.view', <Reports />)} />
    <Route path="cashbook" element={protectedPage('cashbook.view', <Cashbook />)} />
    <Route path="tasks" element={protectedPage('tasks.view', <Tasks />)} />
    <Route path="search" element={protectedPage('dashboard.view', <SearchPage />)} />
    <Route path="offline-queue" element={protectedPage('offline.sync', <OfflineQueue />)} />
    <Route path="settings" element={protectedPage('settings.manage', <SettingsPage />)} />
    <Route path="access" element={protectedPage('access.manage', <AccessPage />)} />
    <Route path="audit" element={protectedPage('audit.view', <AuditPage />)} />
    <Route path="imports" element={protectedPage('imports.manage', <ImportsPage />)} />
    <Route path="forbidden" element={<Forbidden />} />
    <Route path="*" element={<Navigate to="." replace />} />
  </Route></Routes></BusinessCrmProvider>;
}
