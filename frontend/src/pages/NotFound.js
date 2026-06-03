import { Link } from 'react-router-dom';
import { Home, Search, ArrowLeft } from 'lucide-react';
import GenZDigitalStoreLogo from '../components/GenZDigitalStoreLogo';

const NotFound = () => (
  <div className="min-h-screen flex items-center justify-center px-4"
       style={{ background: 'linear-gradient(180deg, #000820 0%, #001030 100%)' }}>
    <div className="text-center max-w-md">
      <div className="text-8xl font-black text-genz-teal mb-4 opacity-30">404</div>
      <GenZDigitalStoreLogo className="h-10 justify-center mb-6" textSize="xl" />
      <h1 className="text-2xl font-black text-white mb-3">Page Not Found</h1>
      <p className="text-genz-muted mb-8 text-sm leading-relaxed">
        The page you're looking for doesn't exist or has been moved.
        Let's get you back on track.
      </p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <Link to="/"
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl font-semibold text-genz-deep-navy"
              style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
          <Home size={16} /> Go Home
        </Link>
        <Link to="/tools"
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium border border-genz-teal/40 text-genz-teal hover:bg-genz-teal/10 transition-all">
          <Search size={16} /> Browse Tools
        </Link>
      </div>
    </div>
  </div>
);

export default NotFound;
