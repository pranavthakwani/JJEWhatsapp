import axios from 'axios';
const api=axios.create({baseURL:import.meta.env.VITE_API_BASE_URL||'http://localhost:4500/api',withCredentials:true});
export type AgentAction={id:number;caseId:number;conversationId:number;kind:string;status:string;version:number;caseVersion:number;sourceMessageId:number;recipient:string;content:string;language:string;reason:string;uncertainty:string[];claimedBy:number|null;approvedBy:number|null;claimedActor?:string|null;approvedActor?:string|null;error:string|null;updatedAt:string;template?:{name:string;language:string;body:string}|null};
export type AgentCase={id:number;conversationId:number;kind:string;version:number;state:string;control:string;fields:Record<string,unknown>;protectedFields:string[];sourceMessageId:number;confirmedAt:string|null;updatedAt:string};
export type AgentEvidence={field_name:string;value:{value:unknown};message_id:number|null;evidence_text:string|null;text_body:string|null;caption:string|null;verification:string};
export type AgentMatch={caseId:number;score:number;provisional:boolean;reasons:string[];uncertainty:string[]};
export type AgentCaseDetail=AgentCase & {evidence:AgentEvidence[];reviews:{decision:string;user_id:number|null;actor_key?:string|null;created_at:string}[];matches:AgentMatch[];actions:AgentAction[]};
export type AgentPolicy={mode:'shadow'|'review';allowlist:number[];dailyBudgetUsd:number;maxClarifications:number;cooldownHours:number;staleHours:number};
export type AgentHealth={processingEnabled:boolean;sendingEnabled:boolean;queued:number;failed:number;pending:number;unknownSends:number;reservedUsd:number;lastRunAt:string|null;policy:AgentPolicy;runs:{stage:string;error_message:string|null;updated_at:string}[]};
export async function agentActions(status?:string,conversationId?:number):Promise<AgentAction[]>{return (await api.get('/agent/actions',{params:{status:status||undefined,conversationId}})).data;}
export async function agentCases(conversationId?:number):Promise<AgentCase[]>{return (await api.get('/agent/cases',{params:{conversationId}})).data;}
export async function agentCase(id:number):Promise<AgentCaseDetail>{return (await api.get(`/agent/cases/${id}`)).data;}
export async function agentHealth():Promise<AgentHealth>{return (await api.get('/agent/health')).data;}
export async function changeAgentAction(action:AgentAction,operation:string,extra:Record<string,unknown>={}):Promise<AgentAction>{return (await api.post(`/agent/actions/${action.id}/${operation}`,{version:action.version,...extra})).data;}
export async function changeAgentCase(record:AgentCase,operation:string,fields?:Record<string,unknown>):Promise<AgentCase>{return (await api.patch(`/agent/cases/${record.id}`,{version:record.version,operation,fields})).data;}
export async function regenerateAgentCase(record:AgentCase):Promise<AgentCase>{return (await api.post(`/agent/cases/${record.id}/regenerate`,{version:record.version})).data;}
export async function linkAgentCases(source:AgentCase,target:AgentCase):Promise<AgentCase>{return (await api.post(`/agent/cases/${source.id}/link`,{version:source.version,targetCaseId:target.id,targetVersion:target.version})).data;}
export async function saveAgentPolicy(policy:AgentPolicy):Promise<AgentPolicy>{return (await api.put('/agent/policy',policy)).data;}
export function agentErrorText(reason:unknown){return axios.isAxiosError(reason)?reason.response?.data?.error||reason.message:reason instanceof Error?reason.message:'Agent request failed';}
