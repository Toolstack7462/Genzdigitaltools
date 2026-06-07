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
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <button
            onClick={() => navigate('/admin/clients')}
            className="flex items-center gap-2 text-genz-muted hover:text-genz-navy transition-colors mb-4"
          >
            <ArrowLeft size={20} />
            Back to Clients
          </button>
          <h1 className="text-3xl font-bold text-genz-navy">Bulk Assign Tool</h1>
          <p className="text-genz-muted mt-2">Assign one tool to multiple clients at once</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Step 1: Select Tool */}
          <div className="bg-white border border-genz-border rounded-xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 bg-gradient-orange rounded-full flex items-center justify-center text-genz-navy font-bold">1</div>
              <h2 className="text-lg font-semibold text-genz-navy">Select Tool</h2>
            </div>

            <div className="relative mb-4">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-genz-muted" size={18} />
              <input
                type="text"
                placeholder="Search tools..."
                value={toolSearch}
                onChange={(e) => setToolSearch(e.target.value)}
                className="w-full pl-12 pr-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-60 overflow-y-auto">
              {filteredTools.map(tool => (
                <button
                  key={tool._id}
                  type="button"
                  onClick={() => setSelectedTool(tool)}
                  className={`p-4 rounded-xl border text-left transition-all ${
                    selectedTool?._id === tool._id
                      ? 'border-genz-teal bg-genz-teal/10'
                      : 'border-genz-border bg-genz-bg hover:border-genz-teal/50'
                  }`}
                  data-testid={`select-tool-${tool._id}`}
                >
                  <div className="flex items-center gap-3">
                    <Package size={20} className={selectedTool?._id === tool._id ? 'text-genz-teal' : 'text-genz-muted'} />
                    <div>
                      <p className="font-medium text-genz-navy">{tool.name}</p>
                      <p className="text-xs text-genz-muted truncate">{tool.description}</p>
                    </div>
                    {selectedTool?._id === tool._id && (
                      <CheckCircle2 size={20} className="ml-auto text-genz-teal" />
                    )}
                  </div>
                </button>
              ))}
            </div>
            
            {filteredTools.length === 0 && (
              <p className="text-center text-genz-muted py-4">No active tools found</p>
            )}
          </div>

          {/* Step 2: Select Clients */}
          <div className="bg-white border border-genz-border rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-gradient-orange rounded-full flex items-center justify-center text-genz-navy font-bold">2</div>
                <h2 className="text-lg font-semibold text-genz-navy">Select Clients</h2>
                <span className="px-2 py-1 bg-genz-teal/20 text-genz-teal text-sm rounded-full">
                  {selectedClients.length} selected
                </span>
              </div>
              <button
                type="button"
                onClick={selectAllClients}
                className="text-sm text-genz-teal hover:underline"
              >
                {filteredClients.every(c => selectedClients.some(s => s._id === c._id)) ? 'Deselect All' : 'Select All'}
              </button>
            </div>

            <div className="relative mb-4">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-genz-muted" size={18} />
              <input
                type="text"
                placeholder="Search clients..."
                value={clientSearch}
                onChange={(e) => setClientSearch(e.target.value)}
                className="w-full pl-12 pr-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
              />
            </div>

            {/* Selected Clients Tags */}
            {selectedClients.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4 p-3 bg-genz-bg rounded-xl">
                {selectedClients.map(client => (
                  <span
                    key={client._id}
                    className="inline-flex items-center gap-1 px-3 py-1 bg-genz-teal/20 text-genz-teal text-sm rounded-full"
                  >
                    {client.fullName}
                    <button type="button" onClick={() => toggleClient(client)} className="hover:text-genz-navy">
                      <X size={14} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-60 overflow-y-auto">
              {filteredClients.map(client => {
                const isSelected = selectedClients.some(c => c._id === client._id);
                return (
                  <button
                    key={client._id}
                    type="button"
                    onClick={() => toggleClient(client)}
                    className={`p-4 rounded-xl border text-left transition-all ${
                      isSelected
                        ? 'border-genz-teal bg-genz-teal/10'
                        : 'border-genz-border bg-genz-bg hover:border-genz-teal/50'
                    }`}
                    data-testid={`select-client-${client._id}`}
                  >
                    <div className="flex items-center gap-3">
                      <Users size={20} className={isSelected ? 'text-genz-teal' : 'text-genz-muted'} />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-genz-navy">{client.fullName}</p>
                        <p className="text-xs text-genz-muted truncate">{client.email}</p>
                      </div>
                      {isSelected && <CheckCircle2 size={20} className="text-genz-teal flex-shrink-0" />}
                    </div>
                  </button>
                );
              })}
            </div>
            
            {filteredClients.length === 0 && (
              <p className="text-center text-genz-muted py-4">No active clients found</p>
            )}
          </div>

          {/* Step 3: Set Duration */}
          <div className="bg-white border border-genz-border rounded-xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 bg-gradient-orange rounded-full flex items-center justify-center text-genz-navy font-bold">3</div>
              <h2 className="text-lg font-semibold text-genz-navy">Set Access Duration</h2>
            </div>

            <div className="flex flex-wrap gap-2 mb-4">
              {['7', '30', '90', '365'].map(days => (
                <button
                  key={days}
                  type="button"
                  onClick={() => handlePresetChange(days)}
                  className={`px-4 py-2 rounded-full text-sm transition-all ${
                    duration.preset === days
                      ? 'bg-gradient-orange text-genz-navy'
                      : 'bg-genz-bg text-genz-muted hover:bg-genz-bg'
                  }`}
                >
                  {days === '7' && '1 Week'}
                  {days === '30' && '1 Month'}
                  {days === '90' && '3 Months'}
                  {days === '365' && '1 Year'}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-genz-navy mb-2">
                  <Calendar size={16} className="text-genz-teal" />
                  Start Date
                </label>
                <input
                  type="date"
                  value={duration.startDate}
                  onChange={(e) => setDuration(prev => ({ ...prev, startDate: e.target.value }))}
                  className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal transition-colors"
                  data-testid="start-date-input"
                />
              </div>
              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-genz-navy mb-2">
                  <Calendar size={16} className="text-genz-teal" />
                  End Date
                </label>
                <input
                  type="date"
                  value={duration.endDate}
                  onChange={(e) => setDuration(prev => ({ ...prev, endDate: e.target.value, preset: '' }))}
                  min={duration.startDate}
                  className="w-full px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal transition-colors"
                  data-testid="end-date-input"
                />
              </div>
            </div>
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-4">
            <button
              type="button"
              onClick={() => navigate('/admin/clients')}
              className="px-6 py-3 text-genz-muted hover:text-genz-navy transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !selectedTool || selectedClients.length === 0}
              className="flex items-center gap-2 px-8 py-3 bg-gradient-orange text-genz-navy rounded-full font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              data-testid="bulk-assign-btn"
            >
              <Save size={20} />
              {saving ? 'Assigning...' : `Assign to ${selectedClients.length} Client(s)`}
            </button>
          </div>
        </form>
      </div>
    </AdminLayout>
  );
};

export default AdminBulkAssign;
