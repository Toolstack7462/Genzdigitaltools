import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * Password input with a show/hide eye toggle.
 * Spreads all standard input props (value, onChange, name, id, required,
 * placeholder, autoComplete, data-testid, …). `className` styles the input;
 * `wrapperClassName` styles the relative wrapper. The toggle never submits the
 * form and is excluded from tab order.
 */
const PasswordInput = ({ className = '', wrapperClassName = '', ...props }) => {
  const [show, setShow] = useState(false);
  return (
    <div className={`relative ${wrapperClassName}`}>
      <input {...props} type={show ? 'text' : 'password'} className={className} />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-genz-muted hover:text-genz-teal transition-colors p-1 rounded-md"
      >
        {show ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
};

export default PasswordInput;
