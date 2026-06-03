import { Link } from 'react-router-dom';
import { Users, Shield, ArrowRight } from 'lucide-react';
import GenZDigitalStoreLogo from '../components/GenZDigitalStoreLogo';

const Login = () => {
  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4 py-20">
      <div className="max-w-lg w-full text-center">
        <GenZDigitalStoreLogo className="h-14 justify-center mb-8" textSize="3xl" />
        <h1 className="text-3xl font-black text-white mb-3">Welcome Back</h1>
        <p className="text-genz-muted mb-10">Choose your login portal to continue</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Client Login */}
          <Link to="/client/login"
                className="p-6 rounded-2xl border text-left transition-all hover:-translate-y-1 hover:shadow-xl group"
                style={{ background: 'rgba(0,175,193,0.05)', borderColor: 'rgba(0,175,193,0.15)' }}>
            <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
                 style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
              <Users size={22} className="text-genz-deep-navy" />
            </div>
            <h3 className="font-bold text-white mb-1">Member Portal</h3>
            <p className="text-genz-muted text-sm mb-3">Access your digital tools dashboard</p>
            <span className="text-genz-teal text-sm font-medium flex items-center gap-1 group-hover:gap-2 transition-all">
              Sign In <ArrowRight size={14} />
            </span>
          </Link>

          {/* Admin Login */}
          <Link to="/admin/login"
                className="p-6 rounded-2xl border text-left transition-all hover:-translate-y-1 hover:shadow-xl group"
                style={{ background: 'rgba(0,175,193,0.03)', borderColor: 'rgba(0,175,193,0.1)' }}>
            <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
                 style={{ background: 'rgba(0,175,193,0.1)' }}>
              <Shield size={22} className="text-genz-teal" />
            </div>
            <h3 className="font-bold text-white mb-1">Admin Panel</h3>
            <p className="text-genz-muted text-sm mb-3">Manage members, tools, and settings</p>
            <span className="text-genz-muted text-sm font-medium flex items-center gap-1 group-hover:text-genz-teal group-hover:gap-2 transition-all">
              Admin Access <ArrowRight size={14} />
            </span>
          </Link>
        </div>

        <p className="mt-8 text-genz-muted text-sm">
          New to Gen Z Digital Store?{' '}
          <Link to="/join" className="text-genz-teal hover:underline font-medium">
            Get Membership
          </Link>
        </p>
      </div>
    </div>
  );
};

export default Login;
