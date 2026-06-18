import { useNavigate } from 'react-router-dom';
import AdminLayoutEnhanced from '../../components/AdminLayoutEnhanced';
import { Activity, Plus } from 'lucide-react';
import AssignmentManager from '../../components/admin/AssignmentManager';

const AdminAssignments = () => {
  const navigate = useNavigate();

  return (
    <AdminLayoutEnhanced>
      <div className="max-w-7xl mx-auto space-y-5" data-testid="admin-assignments-page">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="font-heading text-2xl font-extrabold text-genz-navy mb-0.5 flex items-center gap-2.5">
              <span className="ds-icon-grad w-9 h-9 rounded-xl flex items-center justify-center"><Activity size={18} /></span>
              Assignments
            </h1>
            <p className="text-sm text-genz-muted">See which client has which tool, and manage access</p>
          </div>
          <button
            onClick={() => navigate('/admin/assign')}
            className="btn-grad flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold"
            data-testid="bulk-assign-btn"
          >
            <Plus size={16} />
            <span>Bulk Assign</span>
          </button>
        </div>

        {/* Central filterable view */}
        <div className="ds-card p-4 sm:p-5">
          <AssignmentManager showFilters />
        </div>
      </div>
    </AdminLayoutEnhanced>
  );
};

export default AdminAssignments;
