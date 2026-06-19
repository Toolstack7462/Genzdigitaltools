import { useState, useEffect } from 'react';
import AdminLayout from '../../components/AdminLayout';
import { Search, Mail, Trash2, Eye, Filter, Clock, AlertCircle, CheckCircle, Archive, MessageSquare } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';
import ConfirmModal from '../../components/ConfirmModal';

const AdminContacts = () => {
  const { showSuccess, showError } = useToast();
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedContact, setSelectedContact] = useState(null);
  const [deleteModal, setDeleteModal] = useState({ open: false, contact: null });
  const [stats, setStats] = useState({ total: 0, new: 0, read: 0, replied: 0, archived: 0 });

  useEffect(() => {
    loadContacts();
    loadStats();
  }, [statusFilter]);

  const loadContacts = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (statusFilter) params.append('status', statusFilter);
      
      const res = await api.get(`/admin/contacts?${params}`);
      setContacts(res.data.contacts || []);
    } catch (error) {
      showError('Failed to load contacts');
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const res = await api.get('/admin/contacts/stats');
      setStats(res.data.stats || {});
    } catch (error) {
      console.error('Failed to load stats');
    }
  };

  const viewContact = async (contact) => {
    try {
      const res = await api.get(`/admin/contacts/${contact._id}`);
      setSelectedContact(res.data.contact);
      // Update local state to reflect read status
      if (contact.status === 'new') {
        setContacts(contacts.map(c => c._id === contact._id ? { ...c, status: 'read' } : c));
        loadStats();
      }
    } catch (error) {
      showError('Failed to load contact details');
    }
  };

  const updateStatus = async (contactId, status) => {
    try {
      await api.put(`/admin/contacts/${contactId}`, { status });
      setContacts(contacts.map(c => c._id === contactId ? { ...c, status } : c));
      if (selectedContact?._id === contactId) {
        setSelectedContact(prev => ({ ...prev, status }));
      }
      showSuccess(`Contact marked as ${status}`);
      loadStats();
    } catch (error) {
      showError('Failed to update status');
    }
  };

  const handleDelete = async () => {
    if (!deleteModal.contact) return;
    try {
      await api.delete(`/admin/contacts/${deleteModal.contact._id}`);
      setContacts(contacts.filter(c => c._id !== deleteModal.contact._id));
      if (selectedContact?._id === deleteModal.contact._id) {
        setSelectedContact(null);
      }
      showSuccess('Contact deleted successfully');
      setDeleteModal({ open: false, contact: null });
      loadStats();
    } catch (error) {
      showError('Failed to delete contact');
    }
  };

  const filteredContacts = contacts.filter(contact =>
    contact.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    contact.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    contact.subject?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getStatusIcon = (status) => {
    switch (status) {
      case 'new': return <AlertCircle size={16} className="text-blue-500" />;
      case 'read': return <Eye size={16} className="text-yellow-500" />;
      case 'replied': return <CheckCircle size={16} className="text-green-500" />;
      case 'archived': return <Archive size={16} className="text-gray-500" />;
      default: return null;
    }
  };

  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'high': return 'text-red-500 bg-red-500/10';
      case 'medium': return 'text-yellow-500 bg-yellow-500/10';
      case 'low': return 'text-green-500 bg-green-500/10';
      default: return 'text-gray-500 bg-gray-500/10';
    }
  };

  if (loading) {
    return (
      <AdminLayout>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8" aria-busy="true" aria-label="Loading messages">
          <div className="mb-8 space-y-2 animate-pulse">
            <div className="h-7 w-56 rounded bg-genz-navy/10" />
            <div className="h-4 w-72 rounded bg-genz-navy/10" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="bg-genz-bg border border-genz-border rounded-xl p-4 text-center animate-pulse">
                <div className="h-7 w-10 mx-auto mb-2 rounded bg-genz-navy/10" />
                <div className="h-3 w-14 mx-auto rounded bg-genz-navy/10" />
              </div>
            ))}
          </div>
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="bg-genz-bg border border-genz-border rounded-xl p-4 flex items-center gap-4 animate-pulse">
                <div className="w-10 h-10 rounded-full bg-genz-navy/10 flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/3 rounded bg-genz-navy/10" />
                  <div className="h-3 w-2/3 rounded bg-genz-navy/10" />
                </div>
                <div className="h-5 w-16 rounded-full bg-genz-navy/10" />
              </div>
            ))}
          </div>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-genz-navy mb-2">Contact Messages</h1>
          <p className="text-genz-muted">Manage incoming contact form submissions</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          {[
            { label: 'Total', value: stats.total, color: 'bg-genz-bg' },
            { label: 'New', value: stats.new, color: 'bg-blue-500/10' },
            { label: 'Read', value: stats.read, color: 'bg-yellow-500/10' },
            { label: 'Replied', value: stats.replied, color: 'bg-green-500/10' },
            { label: 'Archived', value: stats.archived, color: 'bg-gray-500/10' }
          ].map((stat, idx) => (
            <div key={idx} className={`${stat.color} border border-genz-border rounded-xl p-4 text-center`}>
              <div className="text-2xl font-bold text-genz-navy">{stat.value}</div>
              <div className="text-sm text-genz-muted">{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" size={20} />
            <input
              type="text"
              placeholder="Search contacts..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-12 pr-4 py-3 bg-[#FFFFFF] border border-genz-border rounded-lg text-genz-navy placeholder-genz-muted focus:outline-none focus:ring-2 focus:ring-genz-teal/30 focus:border-genz-teal transition-all hover:border-genz-muted"
              data-testid="search-contacts-input"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-4 py-3 bg-[#FFFFFF] border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:ring-2 focus:ring-genz-teal/30 focus:border-genz-teal transition-all appearance-none cursor-pointer hover:border-genz-muted min-w-[160px]"
            style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 1rem center', backgroundSize: '0.75rem' }}
            data-testid="status-filter"
          >
            <option value="" className="bg-[#FFFFFF] text-genz-navy">All Status</option>
            <option value="new" className="bg-[#FFFFFF] text-genz-navy">New</option>
            <option value="read" className="bg-[#FFFFFF] text-genz-navy">Read</option>
            <option value="replied" className="bg-[#FFFFFF] text-genz-navy">Replied</option>
            <option value="archived" className="bg-[#FFFFFF] text-genz-navy">Archived</option>
          </select>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Contact List */}
          <div className="lg:col-span-1">
            <div className="bg-white border border-genz-border rounded-xl overflow-hidden">
              <div className="p-4 border-b border-genz-border">
                <h2 className="font-semibold text-genz-navy flex items-center gap-2">
                  <MessageSquare size={18} />
                  Messages ({filteredContacts.length})
                </h2>
              </div>
              
              {filteredContacts.length === 0 ? (
                <div className="p-8 text-center">
                  <Mail size={40} className="mx-auto mb-3 text-genz-muted opacity-50" />
                  <p className="text-genz-muted">No contacts found</p>
                </div>
              ) : (
                <div className="divide-y divide-genz-border max-h-[600px] overflow-y-auto">
                  {filteredContacts.map((contact) => (
                    <button
                      key={contact._id}
                      onClick={() => viewContact(contact)}
                      className={`w-full p-4 text-left hover:bg-genz-bg transition-colors ${
                        selectedContact?._id === contact._id ? 'bg-genz-bg' : ''
                      } ${contact.status === 'new' ? 'bg-blue-500/5' : ''}`}
                      data-testid={`contact-item-${contact._id}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            {getStatusIcon(contact.status)}
                            <span className="font-medium text-genz-navy truncate">{contact.name}</span>
                          </div>
                          <p className="text-sm text-genz-muted truncate">{contact.subject}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <Clock size={12} className="text-genz-muted" />
                            <span className="text-xs text-genz-muted">
                              {new Date(contact.createdAt).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${getPriorityColor(contact.priority)}`}>
                          {contact.priority}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Contact Detail */}
          <div className="lg:col-span-2">
            {selectedContact ? (
              <div className="bg-white border border-genz-border rounded-xl overflow-hidden">
                <div className="p-4 border-b border-genz-border flex items-center justify-between">
                  <div>
                    <h2 className="font-semibold text-genz-navy">{selectedContact.subject}</h2>
                    <p className="text-sm text-genz-muted">From: {selectedContact.name}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedContact.status !== 'replied' && (
                      <button
                        onClick={() => updateStatus(selectedContact._id, 'replied')}
                        className="p-2 text-green-500 hover:bg-green-500/10 rounded-lg transition-colors"
                        title="Mark as Replied"
                      >
                        <CheckCircle size={20} />
                      </button>
                    )}
                    {selectedContact.status !== 'archived' && (
                      <button
                        onClick={() => updateStatus(selectedContact._id, 'archived')}
                        className="p-2 text-gray-500 hover:bg-gray-500/10 rounded-lg transition-colors"
                        title="Archive"
                      >
                        <Archive size={20} />
                      </button>
                    )}
                    <button
                      onClick={() => setDeleteModal({ open: true, contact: selectedContact })}
                      className="p-2 text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"
                      title="Delete"
                    >
                      <Trash2 size={20} />
                    </button>
                  </div>
                </div>
                
                <div className="p-6">
                  {/* Contact Info */}
                  <div className="grid grid-cols-2 gap-4 mb-6 p-4 bg-genz-bg rounded-xl">
                    <div>
                      <span className="text-xs text-genz-muted block">Email</span>
                      <a href={`mailto:${selectedContact.email}`} className="text-genz-teal hover:underline">
                        {selectedContact.email}
                      </a>
                    </div>
                    <div>
                      <span className="text-xs text-genz-muted block">Phone</span>
                      <span className="text-genz-navy">{selectedContact.phone || 'Not provided'}</span>
                    </div>
                    <div>
                      <span className="text-xs text-genz-muted block">Received</span>
                      <span className="text-genz-navy">{new Date(selectedContact.createdAt).toLocaleString()}</span>
                    </div>
                    <div>
                      <span className="text-xs text-genz-muted block">Status</span>
                      <span className="capitalize text-genz-navy flex items-center gap-2">
                        {getStatusIcon(selectedContact.status)}
                        {selectedContact.status}
                      </span>
                    </div>
                  </div>
                  
                  {/* Message */}
                  <div>
                    <h3 className="text-sm font-medium text-genz-muted mb-2">Message</h3>
                    <div className="p-4 bg-genz-bg rounded-xl text-genz-navy whitespace-pre-wrap">
                      {selectedContact.message}
                    </div>
                  </div>
                  
                  {/* Quick Reply */}
                  <div className="mt-6">
                    <a
                      href={`mailto:${selectedContact.email}?subject=Re: ${selectedContact.subject}`}
                      className="inline-flex items-center gap-2 px-6 py-3 btn-grad rounded-full font-medium hover:opacity-90 transition-opacity"
                    >
                      <Mail size={18} />
                      Reply via Email
                    </a>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-white border border-genz-border rounded-xl p-12 text-center">
                <Mail size={48} className="mx-auto mb-4 text-genz-muted opacity-50" />
                <h3 className="text-lg font-medium text-genz-navy mb-2">Select a message</h3>
                <p className="text-genz-muted">Click on a contact to view details</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmModal
        isOpen={deleteModal.open}
        onClose={() => setDeleteModal({ open: false, contact: null })}
        onConfirm={handleDelete}
        title="Delete Contact"
        message={`Are you sure you want to delete the message from "${deleteModal.contact?.name}"?`}
        confirmText="Delete"
        confirmStyle="danger"
      />
    </AdminLayout>
  );
};

export default AdminContacts;
