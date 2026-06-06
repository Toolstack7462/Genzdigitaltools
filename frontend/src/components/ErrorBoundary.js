import { Component } from 'react';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, errorId: null, errorMessage: null };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      errorMessage: error?.message || 'Unknown error',
    };
  }

  componentDidCatch(error, info) {
    const errorId = Math.random().toString(36).substring(2, 8).toUpperCase();
    this.setState({ errorId });
    // Always log to console so devtools shows the real error
    console.error('[ErrorBoundary] Caught error:', error);
    console.error('[ErrorBoundary] Component stack:', info?.componentStack);
    console.error('[ErrorBoundary] Error ID:', errorId);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const isAdmin = typeof window !== 'undefined' &&
      window.location.pathname.startsWith('/admin');

    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', minHeight: '60vh', padding: '2rem',
        textAlign: 'center', background: '#000820', color: '#fff'
      }}>
        {/* Icon */}
        <div style={{
          width: 64, height: 64, borderRadius: 16, marginBottom: 20,
          background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 28
        }}>
          ⚠
        </div>

        <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: 8, color: '#fff' }}>
          Something went wrong
        </h2>
        <p style={{ color: 'rgba(255,255,255,0.5)', marginBottom: 6, fontSize: '0.9rem' }}>
          An unexpected error occurred. Refresh the page to try again.
        </p>
        {this.state.errorId && (
          <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', marginBottom: 24 }}>
            Error ID: {this.state.errorId}
          </p>
        )}

        {/* Recovery buttons */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '0.55rem 1.4rem', borderRadius: 10, border: 'none',
              background: 'linear-gradient(135deg, #00AFC1, #008EA3)',
              color: '#000820', fontWeight: 700, cursor: 'pointer', fontSize: '0.875rem'
            }}
          >
            Refresh Page
          </button>
          <button
            onClick={() => { window.location.href = isAdmin ? '/admin/login' : '/client/login'; }}
            style={{
              padding: '0.55rem 1.4rem', borderRadius: 10,
              border: '1px solid rgba(0,175,193,0.3)', background: 'transparent',
              color: '#00AFC1', fontWeight: 600, cursor: 'pointer', fontSize: '0.875rem'
            }}
          >
            Go to Login
          </button>
          <button
            onClick={() => { window.location.href = '/'; }}
            style={{
              padding: '0.55rem 1.4rem', borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.1)', background: 'transparent',
              color: 'rgba(255,255,255,0.5)', fontWeight: 600, cursor: 'pointer', fontSize: '0.875rem'
            }}
          >
            Go to Home
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
