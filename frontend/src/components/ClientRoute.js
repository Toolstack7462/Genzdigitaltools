import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { authService } from '../services/authService';

/**
 * ClientRoute — server-verified route guard for client portal.
 * Uses authService.verifySession() which calls GET /api/crm/auth/me.
 * Falls back to cached user for display while checking, but only renders
 * children after the server confirms the session is valid.
 */
const ClientRoute = ({ children }) => {
  const [authState, setAuthState] = useState('checking');

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        // verifyClientSession() calls GET /auth/client/me — validates clientAccessToken cookie only
        const user = await authService.verifyClientSession();
        if (cancelled) return;
        if (user) {
          setAuthState('authenticated');
        } else {
          setAuthState('unauthenticated');
        }
      } catch {
        if (!cancelled) setAuthState('unauthenticated');
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
          <p className="text-genz-muted text-sm">Verifying access...</p>
        </div>
      </div>
    );
  }

  if (authState === 'unauthenticated') {
    return <Navigate to="/client/login" replace />;
  }

  return children;
};

export default ClientRoute;
