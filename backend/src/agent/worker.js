import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { query } from '../repositories/sqlHelpers.js';
import * as repository from './repository.js';
import { runIntake,resumeApprovedAction,prepareActionReview } from './graphs.js';
import { reconcileDispatches } from './sending.js';

export function startAgentWorker(workerId) {
  let running=false;
  return setInterval(async()=>{
    if(running||(!env.features.agentProcessing&&!env.features.agentSending))return;
    running=true;
    try {
      const job=env.features.agentProcessing?await repository.claimConversation(workerId):null;
      if(job) {
        const renew=setInterval(()=>void repository.renewConversation(job.conversation_id,workerId).catch(error=>logger.error('Agent lease renewal failed',{error:error.message})),30000);
        try {await runIntake(job);await repository.finishConversation(job,workerId);}
        catch(error){await repository.finishConversation(job,workerId,error);await repository.updateRun(`intake:${job.conversation_id}:${job.latest_message_id}`,'failed',{error:error.message});logger.error('Agent processing failed',{conversationId:job.conversation_id,error:error.message});}
        finally {clearInterval(renew);}
      }
      await reconcileDispatches();
      // Create the durable interrupt while staff are still reviewing. Claim and
      // approval versions share a content/context thread; edited drafts do not.
      for(const action of await repository.listActions({status:'pending',limit:20}))if(['clarification','verification'].includes(action.kind))await prepareActionReview(action);
      if(env.features.agentSending) {
        const approved=(await repository.listActions({status:'approved',limit:10}));
        for(const action of approved)await resumeApprovedAction(action);
      }
      if(!env.features.agentProcessing)return;
      // Non-blocking reminder proposals: never send or assume stale stock is available.
      const currentPolicy=await repository.policy();
      const stale=await query(`SELECT TOP(10) c.case_id FROM jje.agent_cases c WHERE kind='offering' AND control='active' AND state NOT IN ('closed','cancelled')
        AND JSON_VALUE(fields_json,'$.availability')<>'unavailable'
        AND COALESCE(availability_confirmed_at,created_at)<DATEADD(hour,-${currentPolicy.staleHours},SYSUTCDATETIME())
        AND NOT EXISTS(SELECT 1 FROM jje.agent_actions a WHERE a.case_id=c.case_id AND a.kind='verification' AND a.case_version=c.version);`);
      for(const row of stale.recordset) {
        const record=await repository.getCase(Number(row.case_id));
        if(!currentPolicy.allowlist.includes(record.conversationId))continue;
        const {getConversationById}=await import('../repositories/conversationRepository.js');
        const conversation=await getConversationById(record.conversationId);
        await repository.proposeAction({record,sourceMessageId:conversation.lastMessageId,recipient:conversation.contactWaId,kind:'verification',content:`Could you confirm whether ${record.fields.model || 'this stock'} is still available?`,reason:'Availability is unverified or stale. Confirm before recommending stock.',uncertainty:['Availability requires verification'],policy:currentPolicy});
      }
    } catch(error){logger.error('Agent worker poll failed',{error:error.message});}
    finally {running=false;}
  },1000);
}
