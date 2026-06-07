import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import api from '../services/api';

/**
 * AdminRoute — server-verified route guard for admin panel.
 * Calls GET /api/crm/auth/admin/me which reads only the adminAccessToken cookie.
 * A client session in the same browser cannot interfere because it uses a
 * different cookie (clientAccessToken) and a different endpoint.
 */
const ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'SUPPORT']);

const AdminRoute = ({ children }) => {
  const [authState, setAuthState] = useState('checking');

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const response = await api.get('/auth/admin/me');
        if (cancelled) return;
        if (
          response.data?.success &&
          response.data?.user &&
          ADMIN_ROLES.has(response.data.user.role)
        ) {
          localStorage.setItem('genz_admin_user', JSON.stringify(response.data.user));
          setAuthState('authorized');
        } else {
          localStorage.removeItem('genz_admin_user');
          setAuthState('forbidden');
        }
      } catch {
        if (!cancelled) {
          localStorage.removeItem('genz_admin_user');
          setAuthState('unauthenticated');
        }
      }
    };
    check();
    return () => { cancelled = true; };
  }, []);

  if (authState === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--gradient-app)' }}>
        <div className="text-center">
          <div className="w-12 h-12 rounded-full border-2 border-genz-blue border-t-transparent animate-spin mx-auto mb-3" />
          <p className="text-genz-muted text-sm">Verifying admin access…</p>
        </div>
      </div>
    );
  }

  if (authState === 'forbidden') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--gradient-app)' }}>
        <div className="text-center">
          <p className="text-red-500 font-bold mb-2">Access Denied</p>
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
