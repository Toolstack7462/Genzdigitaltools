import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import AdminLayout from '../../components/AdminLayout';
import { ArrowLeft, Save, User, Mail, Lock, Shield } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';
import PasswordInput from '../../components/PasswordInput';

const AdminClientForm = () => {
  const navigate = useNavigate();
  const { id } = useParams();
  const isEdit = Boolean(id);
  const { showSuccess, showError } = useToast();
  
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    password: '',
    status: 'active',
    devicePolicyEnabled: true
  });

  useEffect(() => {
    if (isEdit) {
      loadClient();
    }
  }, [id]);

  const loadClient = async () => {
    try {
      const res = await api.get(`/admin/clients/${id}`);
      const client = res.data.client;
      setFormData({
        fullName: client.fullName || '',
        email: client.email || '',
        password: '', // Don't show password
        status: client.status || 'active',
        devicePolicyEnabled: client.devicePolicy?.enabled !== false
      });
    } catch (error) {
      showError('Failed to load client');
      navigate('/admin/clients');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.fullName.trim() || !formData.email.trim()) {
      showError('Name and email are required');
      return;
    }

    if (!isEdit && !formData.password.trim()) {
      showError('Password is required for new clients');
      return;
    }

    try {
      setSaving(true);
      
      const payload = {
        fullName: formData.fullName.trim(),
        email: formData.email.trim(),
        status: formData.status,
        // Always a real boolean true/false (never a string or masked value).
        devicePolicyEnabled: formData.devicePolicyEnabled === true
      };

      // Only include password if the admin actually typed a new one. Never send
      // an empty value or a masked placeholder (•••) — that would overwrite the
      // existing password. Omitting the field leaves it unchanged on the backend.
      const pwd = (formData.password || '').trim();
      const isMaskOnly = pwd.length > 0 && /^[•●∙·*‣◦•·]+$/.test(pwd);
      if (pwd && !isMaskOnly) {
        payload.password = pwd;
      }

      if (isEdit) {
        await api.put(`/admin/clients/${id}`, payload);
        showSuccess('Client updated successfully');
      } else {
        await api.post('/admin/clients', payload);
        showSuccess('Client created successfully');
      }

      navigate('/admin/clients');
    } catch (error) {
      const data = error.response?.data;
      const msg = (Array.isArray(data?.details) && data.details.length
        ? data.details.map(d => d.message).join('; ')
        : data?.message || data?.error) || 'Failed to save client';
      showError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  if (loading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center min-h-[80vh]">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-genz-teal border-t-transparent"></div>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <button
            onClick={() => navigate('/admin/clients')}
            className="flex items-center gap-2 text-genz-muted hover:text-genz-navy transition-colors mb-4"
          >
            <ArrowLeft size={20} />
            Back to Clients
          </button>
          <h1 className="font-heading text-[28px] sm:text-[32px] font-extrabold text-genz-navy">
            {isEdit ? 'Edit Client' : 'Create Client'}
          </h1>
          <p className="text-genz-muted mt-1">{isEdit ? 'Update this client account and access.' : 'Create a new client account and set their access.'}</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="ds-form-card p-6 sm:p-8">
          <div className="space-y-6">
            {/* Full Name */}
            <div>
              <label htmlFor="fullName" className="flex items-center gap-2 text-sm font-medium text-genz-navy mb-2">
                <User size={16} className="text-genz-teal" />
                Full Name *
              </label>
              <input
                type="text"
                id="fullName"
                name="fullName"
                value={formData.fullName}
                onChange={handleChange}
                required
                className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                placeholder="John Doe"
                data-testid="client-name-input"
              />
            </div>

            {/* Email */}
            <div>
              <label htmlFor="email" className="flex items-center gap-2 text-sm font-medium text-genz-navy mb-2">
                <Mail size={16} className="text-genz-teal" />
                Email Address *
              </label>
              <input
                type="email"
                id="email"
                name="email"
                value={formData.email}
                onChange={handleChange}
                required
                className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                placeholder="john@example.com"
                data-testid="client-email-input"
              />
            </div>

            {/* Password */}
            <div>
              <label htmlFor="password" className="flex items-center gap-2 text-sm font-medium text-genz-navy mb-2">
                <Lock size={16} className="text-genz-teal" />
                Password {isEdit ? '(leave empty to keep existing)' : '*'}
              </label>
              <PasswordInput
                id="password"
                name="password"
                value={formData.password}
                onChange={handleChange}
                required={!isEdit}
                autoComplete="new-password"
                className="w-full px-4 py-3 pr-12 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                placeholder={isEdit ? '••••••••' : 'Enter password'}
                data-testid="client-password-input"
              />
            </div>

            {/* Status */}
            <div>
              <label className="text-sm font-medium text-genz-navy mb-2 block">Status</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="status"
                    value="active"
                    checked={formData.status === 'active'}
                    onChange={handleChange}
                    className="w-4 h-4 text-genz-teal"
                  />
                  <span className="text-genz-navy">Active</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="status"
                    value="disabled"
                    checked={formData.status === 'disabled'}
                    onChange={handleChange}
                    className="w-4 h-4 text-genz-teal"
                  />
                  <span className="text-genz-navy">Disabled</span>
                </label>
              </div>
            </div>

            {/* Device Policy */}
            <div className="flex items-center gap-3 p-4 bg-genz-bg rounded-xl">
              <Shield size={20} className="text-genz-teal" />
              <div className="flex-1">
                <label htmlFor="devicePolicyEnabled" className="text-sm font-medium text-genz-navy cursor-pointer">
                  Enable Device Binding
                </label>
                <p className="text-xs text-genz-muted mt-1">
                  Restrict client to login from a single device only
                </p>
              </div>
              <input
                type="checkbox"
                id="devicePolicyEnabled"
                name="devicePolicyEnabled"
                checked={formData.devicePolicyEnabled}
                onChange={handleChange}
                className="w-5 h-5 rounded"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-4 mt-8 pt-6 border-t border-genz-border">
            <button
              type="button"
              onClick={() => navigate('/admin/clients')}
              className="px-6 py-3 text-genz-muted hover:text-genz-navy transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="btn-grad flex items-center gap-2 px-6 py-3 rounded-[14px] text-[15px] font-bold disabled:opacity-50"
              data-testid="save-client-btn"
            >
              <Save size={18} />
              {saving ? 'Saving…' : (isEdit ? 'Update Client' : 'Create Client')}
            </button>
          </div>
        </form>
      </div>
    </AdminLayout>
  );
};

export default AdminClientForm;
