import { createContext, useContext, useState, useCallback } from 'react';
import { motion, AnimatePresence, MotionConfig } from 'framer-motion';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';

const ToastContext = createContext();

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
};

export const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  }, []);

  const addToast = useCallback((message, type = 'info', duration = 5000) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type, duration }]);

    if (duration > 0) {
      setTimeout(() => {
        setToasts(prev => prev.filter(toast => toast.id !== id));
      }, duration);
    }
  }, []);

  const showSuccess = useCallback((message, duration) => {
    addToast(message, 'success', duration);
  }, [addToast]);

  const showError = useCallback((message, duration) => {
    addToast(message, 'error', duration);
  }, [addToast]);

  const showWarning = useCallback((message, duration) => {
    addToast(message, 'warning', duration);
  }, [addToast]);

  const showInfo = useCallback((message, duration) => {
    addToast(message, 'info', duration);
  }, [addToast]);

  return (
    <ToastContext.Provider value={{ addToast, showSuccess, showError, showWarning, showInfo }}>
      {children}
      <MotionConfig reducedMotion="user">
        <div className="fixed top-4 right-4 left-4 sm:left-auto z-[10000] flex flex-col items-end gap-3 pointer-events-none">
          <AnimatePresence initial={false}>
            {toasts.map(toast => (
              <Toast key={toast.id} {...toast} onClose={() => removeToast(toast.id)} />
            ))}
          </AnimatePresence>
        </div>
      </MotionConfig>
    </ToastContext.Provider>
  );
};

// Per-type accent: bright icon color + matching glow. Text stays white on a
// deep navy glass surface for maximum contrast on any page (light or dark).
const TOAST_STYLES = {
  success: { accent: '#34D399', glow: 'rgba(52,211,153,0.30)',  Icon: CheckCircle2 },
  error:   { accent: '#FB7185', glow: 'rgba(251,113,133,0.34)', Icon: XCircle },
  warning: { accent: '#FBBF24', glow: 'rgba(251,191,36,0.30)',  Icon: AlertTriangle },
  info:    { accent: '#22D3EE', glow: 'rgba(34,211,238,0.30)',  Icon: Info },
};

const EASE_OUT = [0.16, 1, 0.3, 1];

const Toast = ({ message, type, onClose }) => {
  const { accent, glow, Icon } = TOAST_STYLES[type] || TOAST_STYLES.info;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 48, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 48, scale: 0.96 }}
      transition={{ duration: 0.34, ease: EASE_OUT }}
      role="alert"
      aria-live={type === 'error' ? 'assertive' : 'polite'}
      className="pointer-events-auto relative flex items-start gap-3 w-[340px] max-w-[calc(100vw-2rem)] rounded-2xl px-4 py-3.5 overflow-hidden"
      style={{
        background: 'linear-gradient(180deg, rgba(0,18,52,0.97), rgba(0,8,30,0.98))',
        backdropFilter: 'blur(16px) saturate(150%)',
        WebkitBackdropFilter: 'blur(16px) saturate(150%)',
        border: `1px solid ${accent}66`,
        boxShadow: `0 18px 44px -12px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05), 0 0 30px -8px ${glow}`,
      }}
    >
      {/* soft accent glow */}
      <span aria-hidden className="absolute -top-9 -left-7 w-28 h-28 rounded-full pointer-events-none"
            style={{ background: `radial-gradient(circle, ${glow}, transparent 70%)` }} />
      {/* icon chip */}
      <span className="relative flex-shrink-0 w-9 h-9 rounded-xl grid place-items-center"
            style={{ background: `${accent}26`, color: accent, border: `1px solid ${accent}59` }}>
        <Icon size={20} strokeWidth={2.4} />
      </span>
      <p className="relative flex-1 self-center text-[14px] font-semibold leading-snug text-white" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.35)' }}>
        {message}
      </p>
      <button onClick={onClose} aria-label="Dismiss notification"
              className="relative flex-shrink-0 -mr-1 -mt-0.5 w-7 h-7 grid place-items-center rounded-lg text-white/65 hover:text-white hover:bg-white/10 transition-colors">
        <X size={17} strokeWidth={2.5} />
      </button>
    </motion.div>
  );
};

export default Toast;
