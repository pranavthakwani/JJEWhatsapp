import { input,query,sql } from '../repositories/sqlHelpers.js';
import { getConversationById } from '../repositories/conversationRepository.js';
import { getBusinessNumberById } from '../repositories/businessRepository.js';
import { createConversationMessageFromSend,getMessageByClientRequestId } from '../repositories/messageRepository.js';
import { sendConversationText } from '../services/conversationSendingService.js';
import { env } from '../config/env.js';
import { assertSendAllowed,agentError } from './domain.js';
import { getAction,getCase,policy } from './repository.js';
import { proposeAction } from './repository.js';
import { findWindowTemplate,sendReviewedTemplate } from './templates.js';

const p=(name,value,type=sql.NVarChar(sql.MAX))=>input(name,type,value);
export async function dispatchAction(id,{sendText=sendConversationText,sendTemplate=sendReviewedTemplate,sendingEnabled=env.features.agentSending,policyOverride=null}={}) {
  const action=await getAction(id);if(!action)throw agentError('Action not found.',404);
  const requestId=`agent:${id}`,already=await getMessageByClientRequestId(requestId);
  if(already)return {status:already.status,providerMessageId:already.waMessageId};
  const record=await getCase(action.caseId),conversation=await getConversationById(action.conversationId),currentPolicy=policyOverride||await policy();
  const stats=await query(`SELECT MAX(message_id) latest FROM jje.messages WHERE conversation_id=@conversation;
    SELECT COUNT(*) total,MAX(attempt.created_at) last_send FROM jje.agent_dispatch_attempts attempt
    INNER JOIN jje.agent_actions a ON a.action_id=attempt.action_id
    WHERE a.case_id=@case AND attempt.status IN ('dispatching','accepted','unknown')
      AND a.source_message_id>COALESCE((SELECT MAX(message_id) FROM jje.messages WHERE conversation_id=@conversation AND direction='inbound' AND message_id>a.source_message_id),0);`,[
      p('conversation',action.conversationId,sql.BigInt),p('case',action.caseId,sql.BigInt)]);
  try {
    assertSendAllowed({action,caseRecord:record,conversation,policy:currentPolicy,sendingEnabled,
      latestMessageId:Number(stats.recordsets[0][0].latest),unanswered:stats.recordsets[1][0].total,lastClarificationAt:stats.recordsets[1][0].last_send});
  } catch(error) {
    await query(`UPDATE jje.agent_actions SET status='blocked',last_error=@error,version=version+1,updated_at=SYSUTCDATETIME() WHERE action_id=@id AND status='approved';
      INSERT jje.outbox_events(event_type,aggregate_type,aggregate_id,payload_json) VALUES('agent.action_updated','agent_action',@id,'{}');`,[p('id',id,sql.BigInt),p('error',error.message)]);
    if(error.code==='CUSTOMER_WINDOW_CLOSED'&&conversation.contactOptInStatus==='opted_in') {
      const template=await findWindowTemplate(await getBusinessNumberById(conversation.phoneNumberId)).catch(()=>null);
      if(template)await proposeAction({record,sourceMessageId:Number(stats.recordsets[0][0].latest),recipient:conversation.contactWaId,kind:'verification',
        content:template.body,language:template.language,template,reason:'The chat window closed. Separately review this approved fixed template to request a reply; the original clarification will not be substituted.',uncertainty:['Original text remains blocked until a customer reply opens the window'],policy:currentPolicy});
    }
    return {status:'blocked',reason:error.message};
  }
  // Revalidate the snapshot under locks before recording the irreversible attempt.
  const claimed=await query(`SET XACT_ABORT ON;BEGIN TRANSACTION;
    DECLARE @latest bigint; SELECT @latest=MAX(message_id) FROM jje.messages WITH(UPDLOCK,HOLDLOCK) WHERE conversation_id=@conversation;
    IF NOT EXISTS(SELECT 1 FROM jje.agent_actions a WITH(UPDLOCK,HOLDLOCK) INNER JOIN jje.agent_cases c WITH(UPDLOCK,HOLDLOCK) ON c.case_id=a.case_id
      WHERE a.action_id=@id AND a.version=@version AND a.status='approved' AND a.source_message_id=@latest AND a.case_version=c.version
        AND c.control='active' AND c.state NOT IN ('closed','cancelled') AND a.approved_at>DATEADD(minute,-30,SYSUTCDATETIME()))
    BEGIN COMMIT TRANSACTION;SELECT 0 claimed;RETURN;END;
    IF EXISTS(SELECT 1 FROM jje.agent_dispatch_attempts WHERE action_id=@id)
    BEGIN COMMIT TRANSACTION;SELECT 0 claimed;RETURN;END;
    INSERT jje.agent_dispatch_attempts(action_id,request_id,status) VALUES(@id,@request,'dispatching');
    UPDATE jje.agent_actions SET status='dispatching',updated_at=SYSUTCDATETIME() WHERE action_id=@id;
    COMMIT TRANSACTION;SELECT 1 claimed;`,[p('id',id,sql.BigInt),p('version',action.version,sql.Int),p('conversation',action.conversationId,sql.BigInt),p('request',requestId,sql.VarChar(80))]);
  if(!claimed.recordset[0]?.claimed)return {status:'not_claimed'};
  let providerId=null;
  try {
    const number=await getBusinessNumberById(conversation.phoneNumberId);
    const freshConversation=await getConversationById(action.conversationId);
    const freshAction=await getAction(id),freshCase=await getCase(action.caseId);
    if(freshAction.status!=='dispatching'||freshCase.control!=='active'||freshCase.version!==action.caseVersion||freshConversation.lastMessageId!==action.sourceMessageId)throw agentError('Conversation changed before dispatch; review again.',409,'INVALID_MESSAGE');
    const result=action.template?await sendTemplate(number,freshConversation,action.template,action.approvedContent):await sendText({number,conversation:freshConversation,text:action.approvedContent});
    providerId=result.messageId;
    if(!providerId)throw new Error('Meta response did not include a message ID; acceptance is uncertain.');
    // Save the provider ID before local message persistence for restart reconciliation.
    await query(`UPDATE jje.agent_dispatch_attempts SET status='accepted',provider_message_id=@provider,updated_at=SYSUTCDATETIME() WHERE action_id=@id;
      UPDATE jje.agent_actions SET provider_message_id=@provider,status='accepted',updated_at=SYSUTCDATETIME() WHERE action_id=@id;`,[p('id',id,sql.BigInt),p('provider',providerId,sql.VarChar(255))]);
    const message=await createConversationMessageFromSend({conversationId:conversation.id,phoneNumberId:conversation.phoneNumberId,contactId:conversation.contactId,
      responseMessageId:providerId,payload:{messageType:action.template?'template':'text',textBody:action.approvedContent,templateName:action.template?.name,templateLanguage:action.template?.language,clientRequestId:requestId},timestamp:new Date()});
    await query(`UPDATE jje.agent_actions SET message_id=@message,updated_at=SYSUTCDATETIME() WHERE action_id=@id;
      UPDATE jje.agent_cases SET state='waiting_reply' WHERE case_id=@case AND state NOT IN ('closed','cancelled');
      INSERT jje.outbox_events(event_type,aggregate_type,aggregate_id,payload_json) VALUES('agent.action_updated','agent_action',@id,'{}');`,[p('id',id,sql.BigInt),p('message',message.id,sql.BigInt),p('case',action.caseId,sql.BigInt)]);
    return {status:'accepted',providerMessageId:providerId};
  } catch(error) {
    // A response explicitly rejecting the request is safe to show as failed.
    // No response, an acceptance ID, or a transport timeout is never auto-retried.
    const certainRejection=error.code==='CONTACT_OPTED_OUT'||error.code==='CUSTOMER_WINDOW_CLOSED'||error.code==='INVALID_MESSAGE'||(error.response?.status>=400 && error.response?.status<500);
    const status=!providerId&&certainRejection?'failed':'unknown';
    await query(`UPDATE jje.agent_actions SET status=@status,last_error=@error,provider_message_id=COALESCE(@provider,provider_message_id),updated_at=SYSUTCDATETIME() WHERE action_id=@id;
      UPDATE jje.agent_dispatch_attempts SET status=@status,error_message=@error,provider_message_id=COALESCE(@provider,provider_message_id),updated_at=SYSUTCDATETIME() WHERE action_id=@id;
      INSERT jje.outbox_events(event_type,aggregate_type,aggregate_id,payload_json) VALUES('agent.action_updated','agent_action',@id,'{}');`,[p('id',id,sql.BigInt),p('status',status,sql.VarChar(30)),p('error',error.message.slice(0,2000)),p('provider',providerId,sql.VarChar(255))]);
    return {status,reason:error.message};
  }
}
export async function reconcileDispatches() {
  // Meta accepted, then the process stopped before storing its chat bubble.
  // Rebuild local state from the durable receipt; never call Meta a second time.
  const accepted=await query(`SELECT TOP(20) action_id FROM jje.agent_actions WHERE status='accepted' AND message_id IS NULL AND provider_message_id IS NOT NULL
    AND updated_at<DATEADD(minute,-2,SYSUTCDATETIME());`);
  for(const row of accepted.recordset) {
    const action=await getAction(Number(row.action_id)),conversation=await getConversationById(action.conversationId);
    try {
      const requestId=`agent:${action.id}`;
      const message=await getMessageByClientRequestId(requestId)||await createConversationMessageFromSend({conversationId:conversation.id,phoneNumberId:conversation.phoneNumberId,contactId:conversation.contactId,
        responseMessageId:action.providerMessageId,payload:{messageType:action.template?'template':'text',textBody:action.approvedContent,templateName:action.template?.name,templateLanguage:action.template?.language,clientRequestId:requestId}});
      await query(`UPDATE jje.agent_actions SET message_id=@message,updated_at=SYSUTCDATETIME() WHERE action_id=@id;
        INSERT jje.outbox_events(event_type,aggregate_type,aggregate_id,payload_json) VALUES('agent.action_updated','agent_action',@id,'{}');`,[p('id',action.id,sql.BigInt),p('message',message.id,sql.BigInt)]);
    } catch(error) {
      await query(`UPDATE jje.agent_actions SET status='unknown',last_error=@error,updated_at=SYSUTCDATETIME() WHERE action_id=@id;`,[p('id',action.id,sql.BigInt),p('error',`Accepted by Meta, but local reconciliation failed: ${error.message}`.slice(0,2000))]);
    }
  }
  await query(`UPDATE a SET status=CASE WHEN msg.message_id IS NOT NULL THEN msg.status ELSE 'unknown' END,
    message_id=msg.message_id,last_error=CASE WHEN msg.message_id IS NULL THEN 'Worker stopped during dispatch. Reconcile before any resend.' ELSE msg.error_message END,
    updated_at=SYSUTCDATETIME()
    FROM jje.agent_actions a LEFT JOIN jje.messages msg ON msg.client_request_id=CONCAT('agent:',a.action_id)
    WHERE a.status='dispatching' AND a.updated_at<DATEADD(minute,-2,SYSUTCDATETIME());
    UPDATE attempt SET status=a.status,error_message=a.last_error,updated_at=SYSUTCDATETIME()
    FROM jje.agent_dispatch_attempts attempt INNER JOIN jje.agent_actions a ON a.action_id=attempt.action_id
    WHERE attempt.status='dispatching' AND a.status='unknown';`);
}
