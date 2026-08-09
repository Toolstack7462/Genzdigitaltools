import { useEffect, useMemo, useState } from 'react';
import { Save, ShieldCheck, UserCog } from 'lucide-react';
import { crmApi, messageFromError } from '../api';
import { useBusinessCrm } from '../BusinessCrmContext';
import { Button, Card, Empty, ErrorState, Field, Loading, Modal, PageHeader, Select, Status } from '../components/ui';

const ROLES = ['ADMIN','MANAGER','STAFF','VIEWER'];

// Account creation and password resets are intentionally absent: those write the existing `users`
// table (and a reset bumps tokenVersion, dropping a live admin session). The CRM reads accounts and
// assigns business roles/permissions only — the matching backend endpoints return 405.
export default function AccessPage(){
  const crm=useBusinessCrm();
  const [data,setData]=useState(null); const [loading,setLoading]=useState(true); const [error,setError]=useState(''); const [editor,setEditor]=useState(null);
  const load=async()=>{setLoading(true);setError('');try{setData((await crmApi.get('/admin/access')).data)}catch(e){setError(messageFromError(e))}finally{setLoading(false)}};
  useEffect(()=>{load()},[]);
  const grouped=useMemo(()=>{const result={};for(const permission of data?.permissions||[]){const group=permission.split('.')[0];(result[group] ||= []).push(permission)}return result},[data]);
  const openEditor=(user)=>setEditor({id:user.id,name:user.fullName||user.email,businessRole:user.access?.business_role||(user.role==='SUPER_ADMIN'?'OWNER':user.role==='ADMIN'?'ADMIN':'STAFF'),active:user.access?.active!==0,overrides:user.overrides||[]});
  const setOverride=(permission,effect)=>setEditor((current)=>{const next=current.overrides.filter((x)=>x.permission!==permission);if(effect)next.push({permission,effect});return{...current,overrides:next}});
  const saveEditor=async()=>{try{await crmApi.put(`/admin/access/${editor.id}`,{businessRole:editor.businessRole,active:editor.active,overrides:editor.overrides});setEditor(null);load()}catch(e){setError(messageFromError(e))}};
  if(loading)return <Loading label="Loading team access…"/>;if(!data&&error)return <ErrorState message={error} onRetry={load}/>;
  return <><PageHeader title="Team access & permissions" description="One login page, server-derived roles and backend-enforced module permissions."/>{error&&<div className="bcrm-banner warning">{error}</div>}
    <div className="bcrm-banner"><ShieldCheck size={15}/> Existing SUPER_ADMIN, ADMIN and SUPPORT authentication accounts are reused. Business roles only control this CRM workspace — create accounts and reset passwords in the existing admin tools.</div>
    <div className="bcrm-grid bcrm-grid-2">{(data?.users||[]).map((user)=>{const targetRole=user.access?.business_role||(user.role==='SUPER_ADMIN'?'OWNER':user.role==='ADMIN'?'ADMIN':'STAFF');const protectedOwner=targetRole==='OWNER'&&crm.role!=='OWNER';return <Card key={user.id} title={user.fullName||user.email} subtitle={user.email} actions={<Status tone={user.access?.active===0?'danger':'success'}>{user.access?.active===0?'disabled':(user.access?.business_role||user.role)}</Status>}><div className="bcrm-kv"><div><span>Authentication role</span><strong>{user.role}</strong></div><div><span>Last login</span><strong>{user.lastLoginAt?new Date(user.lastLoginAt).toLocaleString():'Never'}</strong></div><div><span>Overrides</span><strong>{user.overrides?.length||0}</strong></div><div><span>Account status</span><strong>{user.status||'active'}</strong></div></div><div className="bcrm-form-actions"><Button icon={UserCog} disabled={protectedOwner} onClick={()=>openEditor(user)}>Permissions</Button></div></Card>})}{!data?.users?.length&&<Empty title="No team users found"/>}</div>
    <Modal open={Boolean(editor)} title={`Access policy — ${editor?.name||''}`} onClose={()=>setEditor(null)} footer={<><Button variant="secondary" onClick={()=>setEditor(null)}>Cancel</Button><Button icon={Save} onClick={saveEditor}>Save access</Button></>}>{editor&&<div className="bcrm-form"><div className="bcrm-form-grid"><Field label="Business role"><Select value={editor.businessRole} onChange={e=>setEditor({...editor,businessRole:e.target.value})}>{(crm.role==='OWNER'?['OWNER',...ROLES]:ROLES).map(r=><option key={r}>{r}</option>)}</Select></Field><label className="bcrm-check"><input type="checkbox" checked={editor.active} onChange={e=>setEditor({...editor,active:e.target.checked})}/> Business CRM access enabled</label></div><p className="bcrm-banner">Role defaults apply first. Optional allow/deny overrides below are enforced by the Express API.</p><div className="bcrm-permission-grid">{Object.entries(grouped).flatMap(([group,permissions])=>permissions.map(permission=>{const current=editor.overrides.find(x=>x.permission===permission)?.effect||'';return <label className="bcrm-permission-row" key={permission}><span><strong>{group}</strong><br/>{permission}</span><Select value={current} onChange={e=>setOverride(permission,e.target.value)}><option value="">Role default</option><option value="allow">Force allow</option><option value="deny">Force deny</option></Select></label>}))}</div></div>}</Modal>
  </>;
}
