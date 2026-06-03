import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import api from '../services/api';

/**
 * AdminRoute — server-verified route guard for admin panel.
 * Calls GET /api/crm/auth/me and verifies role is ADMIN or SUPER_ADMIN.
 * localStorage is used only as a display cache — never as the security boundary.
 */
const ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

const AdminRoute = ({ children }) => {
  const [authState, setAuthState] = useState('checking');

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const response = await api.get('/auth/me');
        if (cancelled) return;
        if (
          response.data?.success &&
          response.data?.user &&
          ADMIN_ROLES.has(response.data.user.role)
        ) {
          // Keep localStorage cache in sync for display purposes
          localStorage.setItem('adminUser', JSON.stringify(response.data.user));
          setAuthState('authorized');
        } else {
          // Authenticated but not admin — clear stale cache
          localStorage.removeItem('adminUser');
          setAuthState('forbidden');
        }
      } catch {
        if (!cancelled) {
          localStorage.removeItem('adminUser');
          setAuthState('unauthenticated');
        }
      }
    };
    check();
    return () => { cancelled = true; };
  }, []);

  if (authState === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center"
           style={{ background: '#000820' }}>
        <div className="text-center">
          <div className="w-12 h-12 rounded-full border-2 border-genz-teal border-t-transparent animate-spin mx-auto mb-3" />
          <p className="text-genz-muted text-sm">Verifying admin access...</p>
        </div>
      </div>
    );
  }

  if (authState === 'forbidden') {
    return (
      <div className="min-h-screen flex items-center justify-center"
           style={{ background: '#000820' }}>
        <div className="text-center">
          <p className="text-red-400 font-bold mb-2">Access Denied</p>
          <p className="text-genz-muted text-sm">Your account does not have admin privileges.</p>
        </div>
      </div>
    );
  }

  if (authState === 'unauthenticated') {
    return <Navigate to="/admin/login" replace />;
  }

  return children;
};

export default AdminRoute;
