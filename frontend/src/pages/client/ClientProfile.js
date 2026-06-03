import { useState, useEffect } from 'react';
import ClientLayoutEnhanced, { CARD_VARIANTS } from '../../components/ClientLayoutEnhanced';
import { User, Mail, Calendar, Shield, Smartphone, Clock, CheckCircle2, AlertCircle } from 'lucide-react';
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
            <p className="text-white/60">Loading profile...</p>
          </div>
        </div>
      </ClientLayoutEnhanced>
    );
  }

  const userData = profile || user;

  return (
    <ClientLayoutEnhanced>
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
          <div className="w-24 h-24 bg-gradient-to-br from-genz-teal to-genz-dark-teal rounded-2xl flex items-center justify-center shadow-2xl shadow-genz-teal/30">
            <span className="text-4xl font-bold text-white">
              {userData?.fullName?.charAt(0) || 'U'}
            </span>
          </div>
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">
              {userData?.fullName || 'User'}
            </h1>
            <p className="text-white/60 flex items-center gap-2">
              <Mail size={16} />
              {userData?.email || 'No email'}
            </p>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className={`${CARD_VARIANTS.green} rounded-2xl p-4 text-center`}>
            <CheckCircle2 size={24} className="text-green-400 mx-auto mb-2" />
            <p className="text-white font-semibold capitalize">{userData?.status || 'Active'}</p>
            <p className="text-white/50 text-xs">Account Status</p>
          </div>
          <div className={`${CARD_VARIANTS.blue} rounded-2xl p-4 text-center`}>
            <Calendar size={24} className="text-blue-400 mx-auto mb-2" />
            <p className="text-white font-semibold">
              {userData?.createdAt ? new Date(userData.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '-'}
            </p>
            <p className="text-white/50 text-xs">Member Since</p>
          </div>
          <div className={`${CARD_VARIANTS.purple} rounded-2xl p-4 text-center`}>
            <Smartphone size={24} className="text-purple-400 mx-auto mb-2" />
            <p className="text-white font-semibold">{userData?.devicePolicy?.enabled ? 'Bound' : 'Any'}</p>
            <p className="text-white/50 text-xs">Device Policy</p>
          </div>
          <div className={`${CARD_VARIANTS.orange} rounded-2xl p-4 text-center`}>
            <Shield size={24} className="text-genz-teal mx-auto mb-2" />
            <p className="text-white font-semibold">Secured</p>
            <p className="text-white/50 text-xs">Access Level</p>
          </div>
        </div>

        {/* Account Information Card */}
        <div className={`${CARD_VARIANTS.elevated} rounded-2xl overflow-hidden`}>
          <div className="p-6 border-b border-white/10">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 bg-gradient-to-br from-purple-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg">
                <User size={28} className="text-white" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-white">Account Information</h2>
                <p className="text-white/50 text-sm">Your personal details and preferences</p>
              </div>
            </div>
          </div>

          <div className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-xs text-white/40 uppercase tracking-wider font-medium">Full Name</label>
                <div className="flex items-center gap-3 p-4 bg-white/5 border border-white/10 rounded-xl">
                  <User size={18} className="text-white/40" />
                  <span className="text-white font-medium">{userData?.fullName || '-'}</span>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs text-white/40 uppercase tracking-wider font-medium">Email Address</label>
                <div className="flex items-center gap-3 p-4 bg-white/5 border border-white/10 rounded-xl">
                  <Mail size={18} className="text-white/40" />
                  <span className="text-white font-medium">{userData?.email || '-'}</span>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs text-white/40 uppercase tracking-wider font-medium">Account Status</label>
                <div className="flex items-center gap-3 p-4 bg-white/5 border border-white/10 rounded-xl">
                  <Shield size={18} className="text-white/40" />
                  <span className={`px-3 py-1 text-xs font-medium rounded-full ${
                    userData?.status === 'active' 
                      ? 'bg-green-500/20 text-green-400' 
                      : 'bg-red-500/20 text-red-400'
                  }`}>
                    {userData?.status || 'Active'}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs text-white/40 uppercase tracking-wider font-medium">Member Since</label>
                <div className="flex items-center gap-3 p-4 bg-white/5 border border-white/10 rounded-xl">
                  <Calendar size={18} className="text-white/40" />
                  <span className="text-white font-medium">
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
          <div className="p-6 border-b border-white/10">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 bg-gradient-to-br from-blue-500 to-cyan-500 rounded-xl flex items-center justify-center shadow-lg">
                <Smartphone size={28} className="text-white" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-white">Device Binding</h2>
                <p className="text-white/50 text-sm">Your registered device information</p>
              </div>
            </div>
          </div>

          <div className="p-6">
            {userData?.devicePolicy?.enabled ? (
              <div className="space-y-6">
                <div className={`${CARD_VARIANTS.blue} rounded-xl p-4`}>
                  <div className="flex items-start gap-3">
                    <Shield size={20} className="text-blue-400 flex-shrink-0 mt-0.5" />
                    <p className="text-blue-300 text-sm">
                      Device binding is enabled for your account. Your login is restricted to this device only for enhanced security.
                    </p>
                  </div>
                </div>

                {deviceInfo && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-xs text-white/40 uppercase tracking-wider font-medium">Device ID</label>
                      <div className="p-4 bg-white/5 border border-white/10 rounded-xl">
                        <span className="text-white font-mono text-sm">
                          {deviceInfo.deviceIdHash?.substring(0, 24)}...
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs text-white/40 uppercase tracking-wider font-medium">Last Activity</label>
                      <div className="flex items-center gap-3 p-4 bg-white/5 border border-white/10 rounded-xl">
                        <Clock size={16} className="text-white/40" />
                        <span className="text-white">
                          {deviceInfo.lastSeenAt 
                            ? new Date(deviceInfo.lastSeenAt).toLocaleString()
                            : 'Now'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="pt-4 border-t border-white/10">
                  <p className="text-white/50 text-sm flex items-start gap-2">
                    <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                    If you need to access your account from a different device, please contact your administrator to reset your device binding.
                  </p>
                </div>
              </div>
            ) : (
              <div className={`${CARD_VARIANTS.default} rounded-xl p-6 text-center`}>
                <div className="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-green-500/20 to-cyan-500/20 rounded-full flex items-center justify-center">
                  <CheckCircle2 size={32} className="text-green-400" />
                </div>
                <p className="text-white font-medium mb-2">No Device Restrictions</p>
                <p className="text-white/50 text-sm">
                  Device binding is not enabled for your account. You can log in from any device.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Support Card */}
        <div className={`${CARD_VARIANTS.orange} rounded-2xl p-6`}>
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-white mb-2">Need Help?</h2>
              <p className="text-white/60 text-sm">
                If you have any questions about your account, tool access, or need assistance, 
                please contact your administrator.
              </p>
            </div>
            <a
              href="mailto:support@toolstack.com"
              className="flex-shrink-0 inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-genz-teal to-genz-dark-teal text-white rounded-xl font-medium hover:shadow-lg hover:shadow-genz-teal/25 transition-all hover:scale-105"
            >
              <Mail size={18} />
              Contact Support
            </a>
          </div>
        </div>
      </div>
    </ClientLayoutEnhanced>
  );
};

export default ClientProfile;
