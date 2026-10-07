import { useCallback,useEffect,useState } from 'react';
import { Check,MessageCircle,RefreshCw,X } from 'lucide-react';
import { socket } from '../lib/socket';
import { agentActions,agentCases,agentCase,agentHealth,changeAgentAction,changeAgentCase,regenerateAgentCase,linkAgentCases,saveAgentPolicy,agentErrorText } from '../lib/agent';
import type { AgentAction,AgentCase,AgentCaseDetail,AgentHealth } from '../lib/agent';

export function AgentInbox({onOpenConversation}:{onOpenConversation:(id:number)=>void}) {
  const [actions,setActions]=useState<AgentAction[]>([]),[cases,setCases]=useState<AgentCase[]>([]),[health,setHealth]=useState<AgentHealth|null>(null);
  const [status,setStatus]=useState('pending'),[selected,setSelected]=useState<AgentAction|null>(null),[detail,setDetail]=useState<AgentCaseDetail|null>(null);
  const [draft,setDraft]=useState(''),[reason,setReason]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [correction,setCorrection]=useState({field:'priceMin',value:''}),[allowlist,setAllowlist]=useState(''),[budget,setBudget]=useState('5'),[mode,setMode]=useState<'shadow'|'review'>('shadow');
  const [showPolicy,setShowPolicy]=useState(false);
  const [linkTarget,setLinkTarget]=useState('');
  const load=useCallback(async()=>{
    try {const [a,c,h]=await Promise.all([agentActions(status),agentCases(),agentHealth()]);setActions(a);setCases(c);setHealth(h);setError('');}
    catch(e){setError(agentErrorText(e));}
  },[status]);
  useEffect(()=>{void load();const refresh=()=>void load();socket.on('agent:updated',refresh);socket.on('connect',refresh);
    const timer=window.setInterval(refresh,15000);return()=>{socket.off('agent:updated',refresh);socket.off('connect',refresh);window.clearInterval(timer);};},[load]);
  async function openAction(action:AgentAction){setSelected(action);setDraft(action.content);setReason('');setCorrection({field:'priceMin',value:''});try{setDetail(await agentCase(action.caseId));}catch(e){setError(agentErrorText(e));}}
  async function perform(operation:string){
    if(!selected)return;setBusy(true);
    try{const updated=await changeAgentAction(selected,operation,{content:draft,reason});setSelected(updated);setDraft(updated.content);await load();setDetail(await agentCase(updated.caseId));}
    catch(e){setError(agentErrorText(e));await load();}finally{setBusy(false);}
  }
  async function control(operation:string){
    if(!detail)return;setBusy(true);
    try{const value=['ramGb','storageGb','quantityMin','quantityMax','priceMin','priceMax'].includes(correction.field)?Number(correction.value):correction.field==='gstIncluded'?correction.value==='true':correction.value;const fields=operation==='correct'?{[correction.field]:value}:undefined;if(operation==='regenerate')await regenerateAgentCase(detail);else await changeAgentCase(detail,operation,fields);setDetail(await agentCase(detail.id));setSelected(null);await load();}
    catch(e){setError(agentErrorText(e));}finally{setBusy(false);}
  }
  async function savePolicy(){
    if(!health)return;setBusy(true);
    try{await saveAgentPolicy({...health.policy,mode,dailyBudgetUsd:Number(budget),allowlist:allowlist.split(',').map(v=>v.trim()).filter(Boolean).map(Number)});setShowPolicy(false);await load();}
    catch(e){setError(agentErrorText(e));}finally{setBusy(false);}
  }
  const messageAction=selected && ['clarification','verification'].includes(selected.kind);
  return <section className="agent-workspace">
    <header className="agent-toolbar"><div><h2>Agent action inbox</h2><p>Review proposals, complete cases, and hand promising matches to your team.</p></div><button type="button" className="ghost-button" onClick={()=>void load()}><RefreshCw size={16}/>Refresh</button></header>
    {error&&<div className="crm-inline-error" role="alert">{error}<button type="button" onClick={()=>setError('')}><X size={16}/></button></div>}
    {health&&<><div className="agent-summary"><span>Processing <b>{health.processingEnabled?'enabled':'disabled'}</b></span><span>Sending <b>{health.sendingEnabled?'approval required':'disabled'}</b></span><span>Mode <b>{health.policy.mode}</b></span><span>Waiting <b>{health.pending}</b></span><span>Queue <b>{health.queued}</b></span><span>Needs reconciliation <b>{health.unknownSends}</b></span></div>
      <button type="button" className="ghost-button" onClick={()=>{setShowPolicy(!showPolicy);setAllowlist(health.policy.allowlist.join(','));setBudget(String(health.policy.dailyBudgetUsd));setMode(health.policy.mode);}}>Pilot policy</button>
      {showPolicy&&<div className="agent-policy"><p>Only administrators can save these settings. Environment switches still control processing and sending.</p><label>Mode<select value={mode} onChange={e=>setMode(e.target.value as 'shadow'|'review')}><option value="shadow">Shadow: internal evaluation</option><option value="review">Review: staff approval</option></select></label><label>Pilot conversation IDs<input value={allowlist} onChange={e=>setAllowlist(e.target.value)} placeholder="Comma-separated conversation IDs"/></label><label>Daily reserved budget (USD)<input type="number" min="0" max="100" value={budget} onChange={e=>setBudget(e.target.value)}/></label><small>Today reserved: ${Number(health.reservedUsd).toFixed(2)}. A reservation is a conservative processing allowance, not measured billing.</small><button type="button" className="primary-button" disabled={busy} onClick={()=>void savePolicy()}>Save policy</button></div>}
    </>}
    <nav className="agent-tabs" aria-label="Action states">{['pending','approved','shadow','blocked','unknown','failed','accepted','sent','delivered','read','rejected','superseded',''].map(s=><button type="button" key={s} className={status===s?'is-active':''} onClick={()=>setStatus(s)}>{s||'All'}</button>)}</nav>
    <div className="agent-review-layout"><div className="agent-action-list">
      {actions.map(action=><button type="button" className={`agent-action-card ${selected?.id===action.id?'is-selected':''}`} key={action.id} onClick={()=>void openAction(action)}><span className="agent-card-meta">{action.kind} · {action.status}{(action.claimedActor||action.claimedBy)?' · claimed':''}</span><strong>{action.reason}</strong><span>{action.kind==='match'?'Internal supplier shortlist':action.content}</span><small>To {action.recipient} · case #{action.caseId}</small></button>)}
      {!actions.length&&<p className="agent-empty">No {status||'matching'} actions. Select a pilot conversation and enable processing to collect proposals.</p>}
      <h3>Recent cases</h3>{cases.slice(0,20).map(record=><button type="button" className="agent-case-row" key={record.id} onClick={async()=>{setSelected(null);try{setDetail(await agentCase(record.id));}catch(e){setError(agentErrorText(e));}}}><strong>{String(record.fields.model||'Unidentified product')}</strong><small>{record.kind} · {record.state} · {record.control}</small></button>)}
    </div><section className="agent-review-panel">
      {detail?<><header><div><span className="crm-eyebrow">Case #{detail.id} · {detail.kind}</span><h3>{String(detail.fields.model||'Review product')}</h3><small>{detail.state} · {detail.control} · version {detail.version}</small></div><button type="button" className="ghost-button" onClick={()=>onOpenConversation(detail.conversationId)}><MessageCircle size={16}/>Open chat</button></header>
        <dl className="agent-fields">{Object.entries(detail.fields).map(([key,value])=><div key={key}><dt>{key.replace(/([A-Z])/g,' $1')}{detail.protectedFields.includes(key)?' · staff confirmed':''}</dt><dd>{typeof value==='object'?JSON.stringify(value):String(value)}</dd></div>)}</dl>
        {selected&&<section className="agent-proposal"><h4>{messageAction?'Proposed customer message':'Internal review task'}</h4><p>{selected.reason}</p>{selected.uncertainty.length>0&&<ul>{selected.uncertainty.map((u,i)=><li key={i}>{u}</li>)}</ul>}
          {selected.kind!=='match'&&<label>{messageAction?`Draft · ${selected.language} · to ${selected.recipient}${selected.template?' · approved fixed template':''}`:'Proposal details'}<textarea value={draft} onChange={e=>setDraft(e.target.value)} rows={4} maxLength={4000} readOnly={Boolean(selected.template)||!messageAction||selected.status!=='pending'}/></label>}
          <label>Review note<input value={reason} onChange={e=>setReason(e.target.value)} placeholder="Reason or handover note"/></label>
          {selected.error&&<p role="alert" className="agent-error">{selected.error}</p>}
          {selected.status==='pending'&&<div className="agent-controls"><button type="button" className="ghost-button" disabled={busy} onClick={()=>void perform('claim')}>Claim</button><button type="button" className="ghost-button" disabled={busy} onClick={()=>void perform('release')}>Release</button>{messageAction&&<><button type="button" className="ghost-button" disabled={busy||draft===selected.content} onClick={()=>void perform('edit')}>Save edit</button><button type="button" className="primary-button" disabled={busy||draft!==selected.content||!health?.sendingEnabled} onClick={()=>void perform('approve')}><Check size={16}/>Approve message</button></>}<button type="button" className="ghost-button" disabled={busy} onClick={()=>void perform('reject')}>Reject</button></div>}
          {['blocked','failed','unknown','approved','shadow'].includes(selected.status)&&<div className="agent-controls"><button type="button" className="ghost-button" disabled={busy} onClick={()=>void perform('cancel')}>Cancel proposal</button><button type="button" className="ghost-button" disabled={busy} onClick={()=>void perform('resolve')}>Mark reviewed</button></div>}
          {!messageAction&&<><p>Use case corrections or handover below. This task does not send a message.</p>{selected.status==='pending'&&<button type="button" className="ghost-button" disabled={busy} onClick={()=>void perform('resolve')}>Mark reviewed</button>}</>}
        </section>}
        <section><h4>Source evidence</h4>{detail.evidence.slice(0,30).map((e,i)=><blockquote key={i}><strong>{e.field_name} · {e.verification}</strong><p>{e.text_body||e.caption||e.evidence_text||'Staff correction'}</p><small>Message #{e.message_id||'—'} · evidence: {e.evidence_text||'Staff verified'} · value: {JSON.stringify(e.value?.value)}</small></blockquote>)}</section>
        {detail.matches.length>0&&<section><h4>Compatible supplier cases</h4>{detail.matches.map(match=><div className="agent-match" key={match.caseId}><button type="button" className="ghost-button" onClick={async()=>{setSelected(null);setDetail(await agentCase(match.caseId));}}>Supplier case #{match.caseId}</button><strong>{match.score}% · {match.provisional?'Provisional':'Verified details'}</strong><p>{[...match.reasons,...match.uncertainty].join(' · ')}</p></div>)}<p>Supplier prices are internal costs. Staff verifies availability and chooses buyer pricing.</p></section>}
        <section><h4>Human control</h4><div className="agent-controls">{['pause','resume','handover','close','cancel'].map(operation=><button type="button" className="ghost-button" disabled={busy} key={operation} onClick={()=>void control(operation)}>{operation==='handover'?'Take over':operation}</button>)}</div><div className="agent-correction"><label>Correct a field<select value={correction.field} onChange={e=>setCorrection({field:e.target.value,value:''})}>{['brand','model','variant','ramGb','storageGb','quantityMin','quantityMax','priceMin','priceMax','gstIncluded','condition','dispatchLocation','availability'].map(field=><option key={field} value={field}>{field.replace(/([A-Z])/g,' $1')}</option>)}</select></label><label>Confirmed value{['gstIncluded','condition','availability'].includes(correction.field)?<select value={correction.value} onChange={e=>setCorrection({...correction,value:e.target.value})}><option value="">Choose a value</option>{(correction.field==='gstIncluded'?['true','false']:correction.field==='condition'?['fresh','used','unknown']:['available','unavailable','unverified']).map(value=><option value={value} key={value}>{value==='true'?'GST included':value==='false'?'GST excluded':value}</option>)}</select>:<input value={correction.value} onChange={e=>setCorrection({...correction,value:e.target.value})} placeholder="Enter the verified value"/>}</label></div><button type="button" className="ghost-button" disabled={busy||!correction.value.trim()} onClick={()=>void control('correct')}>Save staff-confirmed correction</button></section>
        <section><h4>Resolve case association</h4><p>Move an ambiguous reply into the correct case. Conflicting fields must be corrected first.</p><label>Related case<select value={linkTarget} onChange={e=>setLinkTarget(e.target.value)}><option value="">Choose a case in this conversation</option>{cases.filter(c=>c.id!==detail.id&&c.conversationId===detail.conversationId&&c.kind===detail.kind&&c.control==='active').map(c=><option key={c.id} value={c.id}>#{c.id} · {String(c.fields.model||'Unidentified product')}</option>)}</select></label><div className="agent-controls"><button type="button" className="ghost-button" disabled={busy||!linkTarget} onClick={async()=>{const target=cases.find(c=>c.id===Number(linkTarget));if(!target)return;setBusy(true);try{const linked=await linkAgentCases(detail,target);setDetail(await agentCase(linked.id));setSelected(null);setLinkTarget('');await load();}catch(e){setError(agentErrorText(e));}finally{setBusy(false);}}}>Confirm case link</button><button type="button" className="ghost-button" disabled={busy||detail.control!=='active'} onClick={()=>void control('regenerate')}>Regenerate proposals</button></div></section>
        <section><h4>Review history</h4>{detail.reviews.slice(0,20).map((review,i)=><p key={i}>{review.decision} · {review.actor_key?.startsWith('device:')?`Browser device #${review.actor_key.slice(7)}`:`Staff #${review.user_id??'—'}`} · {new Date(review.created_at).toLocaleString()}</p>)}</section>
      </>:<p className="agent-empty">Select a proposal or case to inspect evidence and decide the next step.</p>}
    </section></div>
  </section>;
}

export function AgentChatIndicator({conversationId,onOpen}:{conversationId:number;onOpen:()=>void}) {
  const [count,setCount]=useState(0);
  useEffect(()=>{let active=true;const load=()=>void agentActions('pending',conversationId).then(a=>{if(active)setCount(a.length);}).catch(()=>{});load();socket.on('agent:updated',load);socket.on('connect',load);return()=>{active=false;socket.off('agent:updated',load);socket.off('connect',load);};},[conversationId]);
  return count>0?<button type="button" className="agent-chat-indicator" onClick={onOpen}>{count} agent proposal{count===1?'':'s'} awaiting review</button>:null;
}
