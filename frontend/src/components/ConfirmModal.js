import { AlertTriangle, X } from 'lucide-react';

const ConfirmModal = ({
  isOpen,
  onClose,
  onConfirm,
  title = 'Confirm Action',
  message = 'Are you sure you want to proceed?',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  confirmStyle = 'danger' // 'danger' | 'warning' | 'primary'
}) => {
  if (!isOpen) return null;

  const confirmColors = {
    danger: 'bg-red-500 hover:bg-red-600',
    warning: 'bg-yellow-500 hover:bg-yellow-600',
    primary: 'bg-gradient-orange hover:opacity-90'
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative bg-white/[0.04] border border-white/10 rounded-2xl p-6 w-full max-w-md animate-in fade-in zoom-in duration-200">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-genz-muted hover:text-white transition-colors"
        >
          <X size={20} />
        </button>

        <div className="flex items-center gap-4 mb-4">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
            confirmStyle === 'danger' ? 'bg-red-500/20' :
            confirmStyle === 'warning' ? 'bg-yellow-500/20' :
            'bg-genz-teal/20'
          }`}>
            <AlertTriangle size={24} className={
              confirmStyle === 'danger' ? 'text-red-400' :
              confirmStyle === 'warning' ? 'text-yellow-400' :
              'text-genz-teal'
            } />
          </div>
          <h3 className="text-xl font-semibold text-white">{title}</h3>
        </div>

        <p className="text-genz-muted mb-6 pl-16">{message}</p>

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2 text-genz-muted hover:text-white transition-colors"
            data-testid="modal-cancel-btn"
          >
            {cancelText}
          </button>
          <button
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className={`px-5 py-2 text-white rounded-full font-medium transition-all ${confirmColors[confirmStyle]}`}
            data-testid="modal-confirm-btn"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmModal;
