import { Link, useLocation } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { crmPath } from '../constants';

/**
 * Visible CRM not-found state.
 *
 * Replaces the old `<Navigate to="." replace />` fallback, which resolved to the CURRENT path and
 * therefore redirected to itself — rendering nothing and leaving a blank white content region
 * beneath a still-visible shell. A dead-end URL now always produces something readable and a way
 * back, and never a blank panel.
 */
export default function NotFound() {
  const location = useLocation();
  return (
    <div className="bcrm-state">
      <Compass size={30} aria-hidden="true" />
      <strong>That Business CRM page does not exist</strong>
      <p>
        No CRM section matches <code>{location.pathname}</code>. It may have been renamed, or the
        link that brought you here was incomplete.
      </p>
      <Link className="bcrm-btn bcrm-btn-primary" to={crmPath()}>Go to the CRM dashboard</Link>
    </div>
  );
}
