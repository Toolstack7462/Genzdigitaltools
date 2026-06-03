import { Component } from 'react';

/**
 * ErrorBoundary — catches runtime errors in child tree.
 * Wrap admin and client layouts to prevent blank-page crashes.
 * Never exposes stack traces in production.
 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, errorId: null };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    // Generate a short ID so users can report it
    const errorId = Math.random().toString(36).substring(2, 8).toUpperCase();
    this.setState({ errorId });

    if (process.env.NODE_ENV !== 'production') {
      console.error('[ErrorBoundary]', error, info);
    } else {
      // In production, log only the message (never the stack)
      console.error('[ErrorBoundary]', error.message, errorId);
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', minHeight: '60vh', padding: '2rem', textAlign: 'center'
        }}>
          <h2 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Something went wrong</h2>
          <p style={{ color: '#666', marginBottom: '1rem' }}>
            An unexpected error occurred. Please refresh the page.
          </p>
          {this.state.errorId && (
            <p style={{ fontSize: '0.8rem', color: '#999' }}>
              Error ID: {this.state.errorId}
            </p>
          )}
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '1rem', padding: '0.5rem 1.5rem',
              background: '#1E3A5F', color: '#fff', border: 'none',
              borderRadius: '6px', cursor: 'pointer'
            }}
          >
            Refresh Page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
