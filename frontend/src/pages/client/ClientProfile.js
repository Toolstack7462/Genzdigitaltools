import { useState, useEffect } from 'react';
import ClientLayoutEnhanced, { CARD_VARIANTS } from '../../components/ClientLayoutEnhanced';
import { User, Mail, Calendar, Shield, Smartphone, Clock, CheckCircle2, AlertCircle, MessageCircle, ArrowRight } from 'lucide-react';

const WHATSAPP_URL = 'https://wa.me/923027467462';
import api from '../../services/api';
import { authService } from '../../services/authService';
import { useToast } from '../../components/Toast';

const ClientProfile = () => {
  const { showError } = useToast();
  const [profile, setProfile] = useState(null);
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  
  const user = authService.getCurrentUser();

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      setLoading(true);
      const [profileRes, deviceRes] = await Promise.all([
        api.get('/client/profile'),
        api.get('/client/device-info').catch(() => ({ data: { device: null } }))
      ]);
      
      setProfile(profileRes.data.user || profileRes.data);
      setDeviceInfo(deviceRes.data.device);
    } catch (error) {
      showError('Failed to load profile');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <ClientLayoutEnhanced>
        <div className="flex items-center justify-center min-h-[80vh]">
          <div className="text-center">
            <div className="animate-spin rounded-full h-16 w-16 border-4 border-genz-teal border-t-transparent mx-auto mb-4"></div>
            <p className="text-genz-muted">Loading profile...</p>
          </div>
        </div>
      </ClientLayoutEnhanced>
    );
  }

  const userData = profile || user;

  return (
    <ClientLayoutEnhanced>
      <div className="max-w-4xl mx-auto space-y-4">
        {/* Header card */}
        <div className="gz-panel-dark relative overflow-hidden p-4 sm:p-5" style={{ borderRadius: '18px' }}>
          <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(40rem 20rem at 100% 0%, rgba(6,182,212,0.22), transparent 60%)' }} />
          <div className="relative flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="w-14 h-14 rounded-xl flex items-center justify-center text-white font-extrabold text-2xl flex-shrink-0"
                 style={{ background: 'var(--gradient-cta)', boxShadow: '0 10px 22px -8px rgba(37,99,235,0.6)' }}>
              {userData?.fullName?.charAt(0) || 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="font-heading text-[20px] sm:text-[23px] font-extrabold text-white leading-tight">{userData?.fullName || 'Member'}</h1>
              <p className="text-white/70 flex items-center gap-2 mt-1 text-[13px]"><Mail size={14} /> {userData?.email || 'No email'}</p>
            </div>
            <span className="ds-badge ds-badge-success"><span className="dot" /> {userData?.status || 'Active'}</span>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { icon: CheckCircle2, color: '#16A34A', label: 'Account Status', val: (userData?.status || 'Active') },
            { icon: Calendar, color: '#2563EB', label: 'Member Since', val: userData?.createdAt ? new Date(userData.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—' },
            { icon: Smartphone, color: '#7C3AED', label: 'Device Policy', val: userData?.devicePolicy?.enabled ? 'Bound' : 'Any' },
            { icon: Shield, color: '#06B6D4', label: 'Access Level', val: 'Secured' },
          ].map(({ icon: Icon, color, label, val }) => (
            <div key={label} className="ds-card ds-stat p-3.5">
              <span className="w-9 h-9 rounded-lg flex items-center justify-center mb-2.5" style={{ background: `${color}14`, color, border: `1px solid ${color}26` }}>
                <Icon size={17} />
              </span>
              <p className="text-genz-navy font-bold text-[14.5px] capitalize leading-none">{val}</p>
              <p className="text-genz-muted text-[12px] mt-1">{label}</p>
            </div>
          ))}
        </div>

        {/* Account Information Card */}
        <div className={`${CARD_VARIANTS.elevated} rounded-2xl overflow-hidden`}>
          <div className="p-4 border-b border-genz-border">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-purple-600 rounded-lg flex items-center justify-center shadow-md">
                <User size={20} className="text-white" />
              </div>
              <div>
                <h2 className="text-[16px] font-semibold text-genz-navy">Account Information</h2>
                <p className="text-genz-muted text-[12.5px]">Your personal details and preferences</p>
              </div>
            </div>
          </div>

          <div className="p-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-genz-muted uppercase tracking-wider font-medium">Full Name</label>
                <div className="flex items-center gap-2.5 p-3 bg-genz-bg border border-genz-border rounded-lg">
                  <User size={16} className="text-genz-muted" />
                  <span className="text-genz-navy font-medium text-sm">{userData?.fullName || '-'}</span>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-genz-muted uppercase tracking-wider font-medium">Email Address</label>
                <div className="flex items-center gap-2.5 p-3 bg-genz-bg border border-genz-border rounded-lg">
                  <Mail size={16} className="text-genz-muted" />
                  <span className="text-genz-navy font-medium text-sm">{userData?.email || '-'}</span>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-genz-muted uppercase tracking-wider font-medium">Account Status</label>
                <div className="flex items-center gap-2.5 p-3 bg-genz-bg border border-genz-border rounded-lg">
                  <Shield size={16} className="text-genz-muted" />
                  <span className={`px-3 py-1 text-xs font-semibold rounded-full ${
                    userData?.status === 'active'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-red-100 text-red-600'
                  }`}>
                    {userData?.status || 'Active'}
                  </span>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-genz-muted uppercase tracking-wider font-medium">Member Since</label>
                <div className="flex items-center gap-2.5 p-3 bg-genz-bg border border-genz-border rounded-lg">
                  <Calendar size={16} className="text-genz-muted" />
                  <span className="text-genz-navy font-medium text-sm">
                    {userData?.createdAt
                      ? new Date(userData.createdAt).toLocaleDateString('en-US', { 
                          year: 'numeric', 
                          month: 'long', 
                          day: 'numeric' 
                        })
                      : '-'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Device Binding Card */}
        <div className={`${CARD_VARIANTS.elevated} rounded-2xl overflow-hidden`}>
          <div className="p-4 border-b border-genz-border">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-cyan-500 rounded-lg flex items-center justify-center shadow-md">
                <Smartphone size={20} className="text-white" />
              </div>
              <div>
                <h2 className="text-[16px] font-semibold text-genz-navy">Device Binding</h2>
                <p className="text-genz-muted text-[12.5px]">Your registered device information</p>
              </div>
            </div>
          </div>

          <div className="p-4">
            {userData?.devicePolicy?.enabled ? (
              <div className="space-y-3.5">
                <div className={`${CARD_VARIANTS.blue} rounded-lg p-3`}>
                  <div className="flex items-start gap-2.5">
                    <Shield size={18} className="text-blue-600 flex-shrink-0 mt-0.5" />
                    <p className="text-blue-700 text-[13px]">
                      Device binding is enabled for your account. Your login is restricted to this device only for enhanced security.
                    </p>
                  </div>
                </div>

                {deviceInfo && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs text-genz-muted uppercase tracking-wider font-medium">Device ID</label>
                      <div className="p-3 bg-genz-bg border border-genz-border rounded-lg">
                        <span className="text-genz-navy font-mono text-[13px]">
                          {deviceInfo.deviceIdHash?.substring(0, 24)}...
                        </span>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs text-genz-muted uppercase tracking-wider font-medium">Last Activity</label>
                      <div className="flex items-center gap-2.5 p-3 bg-genz-bg border border-genz-border rounded-lg">
                        <Clock size={15} className="text-genz-muted" />
                        <span className="text-genz-navy text-sm">
                          {deviceInfo.lastSeenAt
                            ? new Date(deviceInfo.lastSeenAt).toLocaleString()
                            : 'Now'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="pt-3 border-t border-genz-border">
                  <p className="text-genz-muted text-[13px] flex items-start gap-2">
                    <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
                    If you need to access your account from a different device, please contact your administrator to reset your device binding.
                  </p>
                </div>
              </div>
            ) : (
              <div className={`${CARD_VARIANTS.default} rounded-lg p-5 text-center`}>
                <div className="w-12 h-12 mx-auto mb-3 bg-gradient-to-br from-green-500/20 to-cyan-500/20 rounded-full flex items-center justify-center">
                  <CheckCircle2 size={26} className="text-green-600" />
                </div>
                <p className="text-genz-navy font-medium mb-1 text-sm">No Device Restrictions</p>
                <p className="text-genz-muted text-[13px]">
                  Device binding is not enabled for your account. You can log in from any device.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Support Card — WhatsApp */}
        <div className="gz-panel-dark relative overflow-hidden p-4" style={{ borderRadius: '18px' }}>
          <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(36rem 18rem at 100% 0%, rgba(34,197,94,0.18), transparent 60%)' }} />
          <div className="relative flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="w-10 h-10 rounded-lg flex items-center justify-center text-white flex-shrink-0" style={{ background: 'linear-gradient(135deg,#22c55e,#16a34a)' }}>
                <MessageCircle size={18} />
              </span>
              <div>
                <h2 className="text-[15px] font-bold text-white mb-0.5">Need help?</h2>
                <p className="text-white/70 text-[13px] max-w-md leading-snug">
                  Questions about your account, tool access, or a new order? Chat with our team on WhatsApp.
                </p>
              </div>
            </div>
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-shrink-0 inline-flex items-center gap-2 px-4 py-2.5 rounded-[12px] text-[13px] font-bold text-white transition-all hover:-translate-y-0.5"
              style={{ background: 'linear-gradient(135deg,#22c55e,#16a34a)', boxShadow: '0 8px 20px -8px rgba(34,197,94,0.6)' }}
            >
              <MessageCircle size={16} />
              Chat on WhatsApp
              <ArrowRight size={15} />
            </a>
          </div>
        </div>
      </div>
    </ClientLayoutEnhanced>
  );
};

export default ClientProfile;
