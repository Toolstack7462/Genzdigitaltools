import { useEffect, useState } from 'react';
import { CloudUpload, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useBusinessCrm } from '../BusinessCrmContext';
import { discardOperation, listQueueForUser, retryOperationAsNew } from '../offline/queue';
import { Button, Card, Empty, PageHeader, Status, Table } from '../components/ui';
import { formatDate } from '../constants';

export default function OfflineQueue(){
  const crm=useBusinessCrm(); const[rows,setRows]=useState([]); const[message,setMessage]=useState('');
  const userId=crm.bootstrap?.user?.id;
  const load=()=>listQueueForUser(userId).then(setRows).catch((error)=>setMessage(error.message));
  useEffect(()=>{if(userId)load()},[userId]); // eslint-disable-line react-hooks/exhaustive-deps
  const sync=async()=>{setMessage('');await crm.runSync();await load()};
  const discard=async(row)=>{if(row.ownership!=='current'){setMessage('This operation belongs to another or an unknown account. Sign in as its owner to discard it safely.');return}if(!window.confirm('Discard this unsynchronized operation? It will not reach the server.'))return;try{await discardOperation(row,userId);crm.setQueued(Math.max(0,crm.queued-1));load()}catch(error){setMessage(error.message)}};
  const retry=async(row)=>{if(!['failed','rejected'].includes(row.lastStatus)){setMessage('Sync this operation with its existing key first. A new key is allowed only after an explicit server failure or rejection.');return}if(!window.confirm('Create a new operation key only after checking that the original transaction was not posted. Continuing without verification can create a duplicate financial entry.'))return;try{await retryOperationAsNew(row,userId);setMessage('A new idempotency key was created after confirmation. Sync again when online.');load()}catch(error){setMessage(error.message)}};
  const owned=rows.filter(row=>row.ownership==='current');
  const clear=async()=>{if(!window.confirm('Discard every queued operation owned by this account? This cannot be undone.'))return;for(const row of owned)await discardOperation(row,userId);crm.setQueued(0);load()};
  return <><PageHeader title="Offline synchronization queue" description="Only credential-free new entries can be queued. Existing financial records, deletions and credential changes remain online-only." actions={<div className="bcrm-actions"><Button variant="secondary" icon={RefreshCw} onClick={load}>Refresh</Button><Button icon={CloudUpload} disabled={!crm.online||crm.syncing||!owned.length} onClick={sync}>{crm.syncing?'Syncing…':'Sync mine'}</Button></div>}/>{message&&<div className="bcrm-banner">{message}</div>}
    <Card className="flush" title={`${owned.length} owned operation${owned.length===1?'':'s'} waiting`} subtitle={rows.length!==owned.length?`${rows.length-owned.length} operation(s) are blocked because they belong to another or unknown account.`:null} actions={owned.length?<Button variant="danger" icon={Trash2} onClick={clear}>Discard mine</Button>:null}>{rows.length?<Table rows={rows} columns={[{key:'type',label:'Operation'},{key:'createdAt',label:'Queued',render:x=>formatDate(x.createdAt,true)},{key:'attempts',label:'Attempts',render:x=>x.attempts||0},{key:'status',label:'Status',render:x=><Status tone={x.ownership!=='current'||x.lastStatus==='failed'||x.lastStatus==='rejected'?'danger':'warning'}>{x.ownership!=='current'?x.ownership:(x.lastStatus||'waiting')}</Status>},{key:'error',label:'Last result',render:x=>x.lastError||'Not synchronized yet'},{key:'actions',label:'',render:x=><div className="bcrm-actions"><Button variant="secondary" icon={RotateCcw} disabled={x.ownership!=='current'||!['failed','rejected'].includes(x.lastStatus)} onClick={()=>retry(x)}>Retry as new</Button><Button variant="danger" icon={Trash2} disabled={x.ownership!=='current'} onClick={()=>discard(x)}>Discard</Button></div>}]} />:<Empty title="Offline queue is empty" description="All locally queued operations have been synchronized or discarded."/>}</Card>
  </>;
}
