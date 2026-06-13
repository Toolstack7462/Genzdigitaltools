/**
 * AdminLayout.js — uses AdminLayoutEnhanced under the hood
 * This wrapper ensures backward compatibility for admin pages
 * that import AdminLayout instead of AdminLayoutEnhanced.
 */
import AdminLayoutEnhanced from './AdminLayoutEnhanced';

const AdminLayout = ({ children }) => <AdminLayoutEnhanced>{children}</AdminLayoutEnhanced>;

export default AdminLayout;
