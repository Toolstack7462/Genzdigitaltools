import { useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * Light-themed modal shell matching the admin "Enhanced" pages (ds-card surface,
 * genz-navy text). Use for hosting larger panels like the Assignment Manager.
 */
const AdminModal = ({ isOpen, onClose, title, subtitle, icon: Icon, maxWidth = 'max-w-3xl', children }) => {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9990] flex items-start sm:items-center justify-center p-3 sm:p-4">
      <div className="absolute inset-0 bg-genz-navy/40 backdrop-blur-sm" onClick={onClose} />

      <div
        className={`relative w-full ${maxWidth} max-h-[90vh] flex flex-col bg-white border border-genz-border rounded-2xl shadow-2xl animate-in fade-in zoom-in duration-150`}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start gap-3 p-5 border-b border-genz-border">
          {Icon && (
            <span className="ds-icon-grad w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0">
              <Icon size={18} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-genz-navy truncate">{title}</h2>
            {subtitle && <p className="text-sm text-genz-muted truncate">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-genz-muted hover:text-genz-navy hover:bg-genz-bg transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {children}
        </div>
      </div>
    </div>
  );
};

export default AdminModal;
