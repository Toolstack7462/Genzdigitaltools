import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import AdminLayout from '../../components/AdminLayout';
import { ArrowLeft, Save, Package, Users, Calendar, CheckCircle2, Search, X } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const AdminBulkAssign = () => {
  const navigate = useNavigate();
  const { clientId } = useParams(); // If editing a specific client's assignments
  const { showSuccess, showError } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tools, setTools] = useState([]);
  const [clients, setClients] = useState([]);
  const [selectedTool, setSelectedTool] = useState(null);
  const [selectedClients, setSelectedClients] = useState([]);
  const [toolSearch, setToolSearch] = useState('');
  const [clientSearch, setClientSearch] = useState('');
  const [duration, setDuration] = useState({
    startDate: new Date().toISOString().split('T')[0],
    endDate: '',
    preset: '30'
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [toolsRes, clientsRes] = await Promise.all([
        api.get('/admin/tools'),
        api.get('/admin/clients')
      ]);
      setTools(toolsRes.data.tools?.filter(t => t.status === 'active') || []);
      setClients(clientsRes.data.clients?.filter(c => c.status === 'active') || []);

      // If clientId is provided, pre-select that client
      if (clientId) {
        const client = clientsRes.data.clients?.find(c => c._id === clientId);
        if (client) {
          setSelectedClients([client]);
        }
      }
    } catch (error) {
      showError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handlePresetChange = (days) => {
    setDuration(prev => {
      const start = new Date(prev.startDate);
      const end = new Date(start);
      end.setDate(end.getDate() + parseInt(days));
      return {
        ...prev,
        preset: days,
        endDate: end.toISOString().split('T')[0]
      };
    });
  };

  const toggleClient = (client) => {
    setSelectedClients(prev => {
      const isSelected = prev.some(c => c._id === client._id);
      if (isSelected) {
        return prev.filter(c => c._id !== client._id);
      }
      return [...prev, client];
    });
  };

  const selectAllClients = () => {
    const filtered = filteredClients;
    const allSelected = filtered.every(c => selectedClients.some(s => s._id === c._id));
    if (allSelected) {
      setSelectedClients(prev => prev.filter(c => !filtered.some(f => f._id === c._id)));
    } else {
      setSelectedClients(prev => {
        const newClients = filtered.filter(c => !prev.some(p => p._id === c._id));
        return [...prev, ...newClients];
      });
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!selectedTool) {
      showError('Please select a tool');
      return;
    }

    if (selectedClients.length === 0) {
      showError('Please select at least one client');
      return;
    }

    if (!duration.startDate || !duration.endDate) {
      showError('Please set access duration');
      return;
    }

    try {
      setSaving(true);

      await api.post('/admin/assignments/bulk', {
        toolId: selectedTool._id,
        clientIds: selectedClients.map(c => c._id),
        startDate: duration.startDate,
        endDate: duration.endDate
      });

      showSuccess(`Tool assigned to ${selectedClients.length} client(s) successfully`);
      navigate('/admin/clients');
    } catch (error) {
      showError(error.response?.data?.error || 'Failed to assign tool');
    } finally {
      setSaving(false);
    }
  };

  const filteredTools = tools.filter(t =>
    t.name.toLowerCase().includes(toolSearch.toLowerCase())
  );

  const filteredClients = clients.filter(c =>
    c.fullName?.toLowerCase().includes(clientSearch.toLowerCase()) ||
    c.email?.toLowerCase().includes(clientSearch.toLowerCase())
  );

  // Compact step header
  const StepHead = ({ n, title, children }) => (
    <div className="flex items-center gap-2.5 mb-3">
      <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white font-bold text-sm flex-shrink-0"
           style={{ background: 'var(--gradient-cta)' }}>{n}</div>
      <h2 className="text-base font-bold text-genz-navy">{title}</h2>
      {children}
    </div>
  );

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
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Header */}
        <div className="mb-5">
          <button
            onClick={() => navigate('/admin/clients')}
            className="flex items-center gap-1.5 text-sm text-genz-muted hover:text-genz-navy transition-colors mb-3"
          >
            <ArrowLeft size={16} />
            Back to Clients
          </button>
          <h1 className="text-2xl font-extrabold text-genz-navy">Bulk Assign Tool</h1>
          <p className="text-sm text-genz-muted mt-1">Assign one tool to multiple clients at once</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Step 1: Select Tool */}
          <div className="ds-card p-4">
            <StepHead n={1} title="Select Tool">
              {selectedTool && (
                <span className="ds-badge ds-badge-teal ml-auto"><CheckCircle2 size={12} /> {selectedTool.name}</span>
              )}
            </StepHead>

            <div className="relative mb-3">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-genz-muted" size={16} />
              <input
                type="text"
                placeholder="Search tools..."
                value={toolSearch}
                onChange={(e) => setToolSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 text-sm bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 max-h-56 overflow-y-auto pr-1">
              {filteredTools.map(tool => {
                const isSelected = selectedTool?._id === tool._id;
                return (
                  <button
                    key={tool._id}
                    type="button"
                    onClick={() => setSelectedTool(tool)}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-left transition-all ${
                      isSelected
                        ? 'border-genz-teal bg-genz-teal/10'
                        : 'border-genz-border bg-genz-bg hover:border-genz-teal/50'
                    }`}
                    data-testid={`select-tool-${tool._id}`}
                  >
                    <Package size={16} className={`flex-shrink-0 ${isSelected ? 'text-genz-teal' : 'text-genz-muted'}`} />
                    <span className="text-sm font-medium text-genz-navy truncate flex-1">{tool.name}</span>
                    {isSelected && <CheckCircle2 size={14} className="text-genz-teal flex-shrink-0" />}
                  </button>
                );
              })}
            </div>

            {filteredTools.length === 0 && (
              <p className="text-center text-sm text-genz-muted py-3">No active tools found</p>
            )}
          </div>

          {/* Step 2: Select Clients */}
          <div className="ds-card p-4">
            <StepHead n={2} title="Select Clients">
              <span className="ds-badge ds-badge-teal">{selectedClients.length} selected</span>
              <button
                type="button"
                onClick={selectAllClients}
                className="ml-auto text-sm font-medium text-genz-teal hover:underline"
              >
                {filteredClients.length > 0 && filteredClients.every(c => selectedClients.some(s => s._id === c._id)) ? 'Deselect All' : 'Select All'}
              </button>
            </StepHead>

            <div className="relative mb-3">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-genz-muted" size={16} />
              <input
                type="text"
                placeholder="Search clients..."
                value={clientSearch}
                onChange={(e) => setClientSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 text-sm bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
              />
            </div>

            {/* Selected Clients Tags */}
            {selectedClients.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3 p-2.5 bg-genz-bg rounded-xl">
                {selectedClients.map(client => (
                  <span
                    key={client._id}
                    className="inline-flex items-center gap-1 px-2.5 py-1 bg-genz-teal/20 text-genz-teal text-xs font-medium rounded-full"
                  >
                    {client.fullName}
                    <button type="button" onClick={() => toggleClient(client)} className="hover:text-genz-navy" aria-label={`Remove ${client.fullName}`}>
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-56 overflow-y-auto pr-1">
              {filteredClients.map(client => {
                const isSelected = selectedClients.some(c => c._id === client._id);
                return (
                  <button
                    key={client._id}
                    type="button"
                    onClick={() => toggleClient(client)}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-all ${
                      isSelected
                        ? 'border-genz-teal bg-genz-teal/10'
                        : 'border-genz-border bg-genz-bg hover:border-genz-teal/50'
                    }`}
                    data-testid={`select-client-${client._id}`}
                  >
                    <span className={`w-7 h-7 rounded-md flex items-center justify-center text-white text-xs font-bold flex-shrink-0 ${isSelected ? '' : 'opacity-80'}`}
                          style={{ background: 'var(--gradient-cta)' }}>
                      {client.fullName?.charAt(0) || '?'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-genz-navy truncate">{client.fullName}</p>
                      <p className="text-xs text-genz-muted truncate">{client.email}</p>
                    </div>
                    {isSelected && <CheckCircle2 size={16} className="text-genz-teal flex-shrink-0" />}
                  </button>
                );
              })}
            </div>

            {filteredClients.length === 0 && (
              <p className="text-center text-sm text-genz-muted py-3">No active clients found</p>
            )}
          </div>

          {/* Step 3: Set Duration */}
          <div className="ds-card p-4">
            <StepHead n={3} title="Set Access Duration" />

            <div className="flex flex-wrap gap-2 mb-3">
              {['7', '30', '90', '365'].map(days => (
                <button
                  key={days}
                  type="button"
                  onClick={() => handlePresetChange(days)}
                  className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-all ${
                    duration.preset === days
                      ? 'btn-grad'
                      : 'bg-genz-bg text-genz-muted border border-genz-border hover:border-genz-teal/50'
                  }`}
                >
                  {days === '7' && '1 Week'}
                  {days === '30' && '1 Month'}
                  {days === '90' && '3 Months'}
                  {days === '365' && '1 Year'}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="flex items-center gap-1.5 text-sm font-medium text-genz-navy mb-1.5">
                  <Calendar size={14} className="text-genz-teal" />
                  Start Date
                </label>
                <input
                  type="date"
                  value={duration.startDate}
                  onChange={(e) => setDuration(prev => ({ ...prev, startDate: e.target.value }))}
                  className="w-full px-3.5 py-2.5 text-sm bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal transition-colors"
                  data-testid="start-date-input"
                />
              </div>
              <div>
                <label className="flex items-center gap-1.5 text-sm font-medium text-genz-navy mb-1.5">
                  <Calendar size={14} className="text-genz-teal" />
                  End Date
                </label>
                <input
                  type="date"
                  value={duration.endDate}
                  onChange={(e) => setDuration(prev => ({ ...prev, endDate: e.target.value, preset: '' }))}
                  min={duration.startDate}
                  className="w-full px-3.5 py-2.5 text-sm bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal transition-colors"
                  data-testid="end-date-input"
                />
              </div>
            </div>
          </div>

          {/* Submit */}
          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={() => navigate('/admin/clients')}
              className="px-4 py-2.5 text-sm font-medium text-genz-muted hover:text-genz-navy transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !selectedTool || selectedClients.length === 0}
              className="flex items-center gap-2 px-5 py-2.5 btn-grad rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-50"
              data-testid="bulk-assign-btn"
            >
              <Save size={16} />
              {saving ? 'Assigning...' : `Assign to ${selectedClients.length} Client(s)`}
            </button>
          </div>
        </form>
      </div>
    </AdminLayout>
  );
};

export default AdminBulkAssign;
