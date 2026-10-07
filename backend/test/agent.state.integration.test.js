import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { input,query,sql } from '../src/repositories/sqlHelpers.js';
import * as repo from '../src/agent/repository.js';
import { closePool } from '../src/config/db.js';
import { DEFAULT_POLICY } from '../src/agent/domain.js';
import { dispatchAction,reconcileDispatches } from '../src/agent/sending.js';
import { updateOfferingStatus } from '../src/repositories/leadOpsRepository.js';
import { importSelectedRecords } from '../src/agent/backfill.js';
import { saveMessageAnalysis } from '../src/repositories/analysisRepository.js';

test('SQL stable IDs, evidence, claims, approval races and stale drafts',async()=>{
  const tag=`agent-test-${randomUUID()}`;let conversation,contact,message;
  const p=(name,value,type=sql.BigInt)=>input(name,type,value);
  try {
    const fixture=await query(`SET XACT_ABORT ON;BEGIN TRANSACTION;
      DECLARE @phone bigint=(SELECT TOP(1) phone_number_id FROM jje.phone_numbers ORDER BY phone_number_id),@contact bigint,@conversation bigint,@message bigint;
      INSERT jje.contacts(wa_id,profile_name,last_inbound_at) VALUES(@tag,'Agent integration fixture',SYSUTCDATETIME());SET @contact=SCOPE_IDENTITY();
      INSERT jje.conversations(phone_number_id,contact_id) VALUES(@phone,@contact);SET @conversation=SCOPE_IDENTITY();
      INSERT jje.messages(conversation_id,phone_number_id,contact_id,direction,message_type,text_body,status)
        VALUES(@conversation,@phone,@contact,'inbound','text','A16 20 black','received');SET @message=SCOPE_IDENTITY();
      INSERT jje.users(display_name,email,password_hash,status) VALUES('Agent test staff',CONCAT(@tag,'-1@test.invalid'),'not-a-valid-login-hash','locked'),('Agent test staff 2',CONCAT(@tag,'-2@test.invalid'),'not-a-valid-login-hash','locked');
      COMMIT TRANSACTION;SELECT @contact contact,@conversation conversation,@message message;
      SELECT user_id FROM jje.users WHERE email IN(CONCAT(@tag,'-1@test.invalid'),CONCAT(@tag,'-2@test.invalid')) ORDER BY user_id;`,[p('tag',tag,sql.VarChar(64))]);
    ({conversation,contact,message}=fixture.recordsets[0][0]);const users=fixture.recordsets[1].map(r=>Number(r.user_id));assert.ok(users.length);
    // Switch the SQL hook on only inside a rolled-back transaction. No setting,
    // message or processing job escapes this isolated burst-grouping check.
    const burst=await query(`SET XACT_ABORT ON;BEGIN TRANSACTION;
      UPDATE jje.system_settings SET setting_value='true' WHERE setting_key='agent.processing.enabled';
      INSERT jje.messages(conversation_id,phone_number_id,contact_id,direction,message_type,text_body,status)
        SELECT conversation_id,phone_number_id,contact_id,'inbound','text','20 black','received' FROM jje.conversations WHERE conversation_id=@id;
      SELECT *,DATEDIFF(millisecond,first_pending_at,available_at) quiet_ms FROM jje.agent_conversation_queue WHERE conversation_id=@id;
      UPDATE jje.agent_conversation_queue SET first_pending_at=DATEADD(second,-14,SYSUTCDATETIME()) WHERE conversation_id=@id;
      INSERT jje.messages(conversation_id,phone_number_id,contact_id,direction,message_type,text_body,status)
        SELECT conversation_id,phone_number_id,contact_id,'inbound','text','Price 14500','received' FROM jje.conversations WHERE conversation_id=@id;
      SELECT *,DATEDIFF(millisecond,first_pending_at,available_at) capped_ms FROM jje.agent_conversation_queue WHERE conversation_id=@id;
      ROLLBACK TRANSACTION;`,[p('id',conversation)]);
    assert.equal(burst.recordsets[0][0].quiet_ms,3000);
    assert.equal(burst.recordsets[1][0].capped_ms,15000);
    const args={key:tag,kind:'offering',conversationId:Number(conversation),sourceMessageId:Number(message),fields:{model:'A16',quantityMin:20},evidence:[{field:'model',value:'A16',messageId:Number(message),evidence:'A16'},{field:'quantityMin',value:20,messageId:Number(message),evidence:'20'}],state:'qualifying',runId:tag};
    const first=await repo.persistCase(args);const replay=await repo.persistCase(args);assert.equal(first.id,replay.id);assert.equal(first.version,replay.version);
    await repo.projectCase(first);const projected=await repo.getCase(first.id);assert.ok(projected.recordId);
    await repo.projectCase(projected);assert.equal((await repo.getCase(first.id)).recordId,projected.recordId);
    assert.equal((await repo.caseDetail(first.id)).evidence.length,2);
    const imported=await importSelectedRecords([{kind:'offering',recordId:projected.recordId}],users[0]);
    assert.equal(imported[0].id,first.id);assert.equal((await repo.listActions({conversationId:Number(conversation)})).length,0);
    await assert.rejects(importSelectedRecords([],users[0]),/explicit/);
    const analysisId=await saveMessageAnalysis({messageId:Number(message),extraction:{classification:'offering',confidence:1,gstIncluded:null,items:[{model:'A16',quantityMin:99},{model:'A18',quantityMin:5,priceMin:12000}]},model:'fixture',promptVersion:'fixture'});
    const legacy=await query('SELECT offering_id,quantity_min FROM jje.offerings WHERE message_analysis_id=@id ORDER BY item_index; SELECT COUNT(*) revisions FROM jje.analysis_revisions WHERE message_analysis_id=@id',[p('id',analysisId)]);
    assert.equal(Number(legacy.recordsets[0][0].offering_id),projected.recordId);assert.equal(legacy.recordsets[0][0].quantity_min,20);assert.equal(legacy.recordsets[1][0].revisions,1);
    const historical=await importSelectedRecords([{kind:'offering',recordId:Number(legacy.recordsets[0][1].offering_id)}],users[0]);
    assert.equal(historical[0].fields.model,'A18');assert.equal(historical[0].fields.availability,'unverified');
    assert.equal((await repo.listActions({conversationId:Number(conversation)})).length,0);
    assert.equal((await importSelectedRecords([{kind:'offering',recordId:historical[0].recordId}],users[0]))[0].id,historical[0].id);
    const create=()=>repo.proposeAction({record:projected,sourceMessageId:Number(message),recipient:tag,kind:'clarification',content:'Price and GST?',reason:'Need price',policy:{...DEFAULT_POLICY,mode:'review'}});
    const proposed=await create();assert.equal((await create()).id,proposed.id);
    const browser1={key:'device:1001',userId:null},browser2={key:'device:1002',userId:null};
    const claimed=await repo.mutateAction(proposed.id,browser1,proposed.version,'claim');
    await assert.rejects(repo.mutateAction(proposed.id,browser1,proposed.version,'approve'),/changed/);
    await assert.rejects(repo.mutateAction(proposed.id,browser2,claimed.version,'claim'),/claimed/);
    const approvals=await Promise.allSettled([repo.mutateAction(claimed.id,browser1,claimed.version,'approve'),repo.mutateAction(claimed.id,browser1,claimed.version,'approve')]);
    assert.equal(approvals.filter(r=>r.status==='fulfilled').length,1);const approved=await repo.getAction(claimed.id);assert.equal(approved.approvedContent,'Price and GST?');assert.equal(approved.approvedBy,null);assert.equal(approved.approvedActor,'device:1001');
    await query(`INSERT jje.messages(conversation_id,phone_number_id,contact_id,direction,message_type,text_body,status)
      SELECT conversation_id,phone_number_id,contact_id,'inbound','text','Price 14500','received' FROM jje.conversations WHERE conversation_id=@id;`,[p('id',conversation)]);
    assert.equal((await repo.getAction(approved.id)).status,'superseded');
    const corrected=await repo.mutateCase(first.id,users[0],(await repo.getCase(first.id)).version,{operation:'correct',fields:{priceMin:14500,availability:'available'}});
    assert.equal(corrected.fields.priceMin,14500);assert.ok(corrected.protectedFields.includes('priceMin'));assert.ok(corrected.confirmedAt);
    assert.equal((await repo.getCase(first.id)).recordId,projected.recordId);
    await assert.rejects(repo.mutateCase(first.id,users[0],1,{operation:'pause'}),/changed/);
    const latest=await query('SELECT MAX(message_id) latest FROM jje.messages WHERE conversation_id=@id',[p('id',conversation)]);
    await query('UPDATE jje.conversations SET last_message_id=@message WHERE conversation_id=@id',[p('id',conversation),p('message',latest.recordset[0].latest)]);
    const pilot={...DEFAULT_POLICY,mode:'review',allowlist:[Number(conversation)]};
    const draft=await repo.proposeAction({record:corrected,sourceMessageId:Number(latest.recordset[0].latest),recipient:tag,kind:'clarification',content:'Confirm GST?',reason:'Test send',policy:pilot,contextKey:'mock-send'});
    const sendAction=await repo.mutateAction(draft.id,browser1,draft.version,'approve');let sends=0;
    const transport=async()=>{sends++;return {messageId:`fixture-provider-${randomUUID()}`};};
    await Promise.all([dispatchAction(sendAction.id,{sendText:transport,sendingEnabled:true,policyOverride:pilot}),dispatchAction(sendAction.id,{sendText:transport,sendingEnabled:true,policyOverride:pilot})]);
    assert.equal(sends,1);const accepted=await repo.getAction(sendAction.id);assert.equal(accepted.status,'accepted');assert.ok(accepted.providerMessageId);
    await dispatchAction(sendAction.id,{sendText:transport,sendingEnabled:true,policyOverride:pilot});assert.equal(sends,1);
    // Simulate an accepted receipt whose bubble-link write was lost at shutdown.
    await query("UPDATE jje.agent_actions SET message_id=NULL,updated_at=DATEADD(minute,-3,SYSUTCDATETIME()) WHERE action_id=@id",[p('id',accepted.id)]);
    await reconcileDispatches();assert.equal(sends,1);assert.ok((await repo.getAction(accepted.id)).providerMessageId);
    const timeoutCase=await repo.persistCase({...args,key:`${tag}-timeout`,runId:`${tag}-timeout`,fields:{model:'A17',quantityMin:1},evidence:[]});
    const newest=await query('SELECT MAX(message_id) latest FROM jje.messages WHERE conversation_id=@id',[p('id',conversation)]);
    const timeoutDraft=await repo.proposeAction({record:timeoutCase,sourceMessageId:Number(newest.recordset[0].latest),recipient:tag,kind:'clarification',content:'Price?',reason:'Test timeout',policy:pilot});
    const timeoutApproval=await repo.mutateAction(timeoutDraft.id,users[0],timeoutDraft.version,'approve');let attempts=0;
    const uncertain=async()=>{attempts++;throw Object.assign(new Error('Provider timed out'),{code:'ETIMEDOUT'});};
    assert.equal((await dispatchAction(timeoutApproval.id,{sendText:uncertain,sendingEnabled:true,policyOverride:pilot})).status,'unknown');
    await dispatchAction(timeoutApproval.id,{sendText:uncertain,sendingEnabled:true,policyOverride:pilot});assert.equal(attempts,1);assert.equal((await repo.getAction(timeoutApproval.id)).status,'unknown');
    const rejectDraft=await repo.proposeAction({record:timeoutCase,sourceMessageId:Number(newest.recordset[0].latest),recipient:tag,kind:'verification',content:'Confirm stock?',reason:'Test reject',policy:pilot});
    await repo.mutateAction(rejectDraft.id,users[0],rejectDraft.version,'reject');
    const paraphrase=await repo.proposeAction({record:timeoutCase,sourceMessageId:Number(newest.recordset[0].latest),recipient:tag,kind:'verification',content:'Is this available now?',reason:'New wording',uncertainty:['Different model wording'],policy:pilot});
    assert.equal(paraphrase.id,rejectDraft.id);assert.equal(paraphrase.status,'rejected');
    const unlinked=await repo.persistCase({...args,key:`${tag}-unlinked`,runId:`${tag}-unlinked`,fields:{storageGb:256},evidence:[]});
    const linked=await repo.linkCases(unlinked.id,timeoutCase.id,users[0],unlinked.version,(await repo.getCase(timeoutCase.id)).version);
    assert.equal(linked.fields.storageGb,256);assert.equal((await repo.getCase(unlinked.id)).state,'closed');
    await updateOfferingStatus(projected.recordId,'sold',users[0]);assert.equal((await repo.getCase(first.id)).fields.availability,'unavailable');assert.equal((await repo.getCase(first.id)).state,'closed');
  } finally {
    if(conversation)await query(`SET XACT_ABORT ON;BEGIN TRANSACTION;
      DELETE o FROM jje.outbox_events o WHERE (o.aggregate_type='agent_action' AND o.aggregate_id IN(SELECT action_id FROM jje.agent_actions WHERE conversation_id=@conversation))
        OR (o.aggregate_type='agent_case' AND o.aggregate_id IN(SELECT case_id FROM jje.agent_cases WHERE conversation_id=@conversation))
        OR (o.aggregate_type='offering' AND o.aggregate_id IN(SELECT record_id FROM jje.agent_cases WHERE conversation_id=@conversation AND kind='offering'))
        OR (o.aggregate_type='analysis' AND o.aggregate_id IN(SELECT message_analysis_id FROM jje.message_analysis WHERE message_id IN(SELECT message_id FROM jje.messages WHERE conversation_id=@conversation)))
        OR (o.aggregate_type='message' AND o.aggregate_id IN(SELECT message_id FROM jje.messages WHERE conversation_id=@conversation));
      DELETE FROM jje.agent_reviews WHERE case_id IN(SELECT case_id FROM jje.agent_cases WHERE conversation_id=@conversation);
      DELETE FROM jje.agent_dispatch_attempts WHERE action_id IN(SELECT action_id FROM jje.agent_actions WHERE conversation_id=@conversation);
      DELETE FROM jje.agent_actions WHERE conversation_id=@conversation;DELETE FROM jje.agent_evidence WHERE case_id IN(SELECT case_id FROM jje.agent_cases WHERE conversation_id=@conversation);
      DELETE FROM jje.agent_cases WHERE conversation_id=@conversation;
      DELETE FROM jje.offerings WHERE message_analysis_id IN(SELECT message_analysis_id FROM jje.message_analysis WHERE message_id IN(SELECT message_id FROM jje.messages WHERE conversation_id=@conversation));
      DELETE FROM jje.analysis_revisions WHERE message_analysis_id IN(SELECT message_analysis_id FROM jje.message_analysis WHERE message_id IN(SELECT message_id FROM jje.messages WHERE conversation_id=@conversation));
      DELETE FROM jje.message_analysis WHERE message_id IN(SELECT message_id FROM jje.messages WHERE conversation_id=@conversation);
      DELETE FROM jje.agent_conversation_queue WHERE conversation_id=@conversation;
      UPDATE jje.conversations SET last_message_id=NULL WHERE conversation_id=@conversation;
      DELETE FROM jje.messages WHERE conversation_id=@conversation;DELETE FROM jje.conversations WHERE conversation_id=@conversation;DELETE FROM jje.contacts WHERE contact_id=@contact;
      DELETE FROM jje.users WHERE email IN(CONCAT(@tag,'-1@test.invalid'),CONCAT(@tag,'-2@test.invalid'));
      COMMIT TRANSACTION;`,[p('conversation',conversation),p('contact',contact),p('tag',tag,sql.VarChar(64))]);
  }
});
test.after(()=>closePool());
