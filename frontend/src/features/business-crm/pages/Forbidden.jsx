import { ShieldX } from 'lucide-react';
import { PageHeader } from '../components/ui';
export default function Forbidden(){return <><PageHeader title="Access restricted" description="Your Business CRM role does not include this module."/><div className="bcrm-state"><ShieldX size={36}/><strong>Permission required</strong><p>Ask the owner or administrator to update your Business CRM role or permission overrides.</p></div></>}
