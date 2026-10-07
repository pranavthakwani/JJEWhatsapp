import { randomUUID } from 'node:crypto';
import { getConversationById } from '../repositories/conversationRepository.js';
import { getCase,policy,context,proposeAction,offeringCandidates,buyerCandidates } from './repository.js';
import { missingFields,matchOffering,agentError } from './domain.js';
import { fallbackDraft } from './graphs.js';

// Corrections/resume do not need another paid extraction of the same message.
export async function refreshCase(id,{regenerate=false}={}) {
  const record=await getCase(id);if(!record)throw agentError('Case not found.',404);
  if(record.control!=='active'||['closed','cancelled'].includes(record.state))return record;
  const currentPolicy=await policy();if(!currentPolicy.allowlist.includes(record.conversationId))return record;
  const conversation=await getConversationById(record.conversationId),snapshot=await context(record.conversationId,Number.MAX_SAFE_INTEGER);
  const missing=missingFields(record.kind,record.fields),regeneration=regenerate?randomUUID():null;
  if(missing.length)await proposeAction({record,sourceMessageId:snapshot.latestMessageId,recipient:conversation.contactWaId,kind:'clarification',content:fallbackDraft(missing,'en'),reason:'Complete the case after staff review.',uncertainty:missing,policy:currentPolicy,regeneration});
  if(record.kind==='lead'&&missing.length===0) {
    const matches=(await offeringCandidates(record.conversationId)).map(c=>matchOffering(record.fields,c,currentPolicy)).filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,10);
    if(matches.length)await proposeAction({record,sourceMessageId:snapshot.latestMessageId,recipient:conversation.contactWaId,kind:'match',content:JSON.stringify(matches),reason:'Updated internal supplier shortlist after staff review.',uncertainty:matches.flatMap(m=>m.uncertainty),policy:currentPolicy,regeneration});
  }
  if(record.kind==='offering')for(const buyer of await buyerCandidates(record.conversationId)) {
    if(missingFields('lead',buyer.fields).length||!currentPolicy.allowlist.includes(buyer.conversationId))continue;
    const match=matchOffering(buyer.fields,record,currentPolicy);if(!match)continue;
    const contact=await getConversationById(buyer.conversationId),messages=await context(buyer.conversationId,Number.MAX_SAFE_INTEGER);
    await proposeAction({record:buyer,sourceMessageId:messages.latestMessageId,recipient:contact.contactWaId,kind:'match',content:JSON.stringify([match]),reason:'Staff-corrected supplier details match this buying request.',uncertainty:match.uncertainty,policy:currentPolicy});
  }
  return record;
}
