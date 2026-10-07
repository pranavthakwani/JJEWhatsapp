import { input, query, sql, parseJson, iso, clampInteger } from '../repositories/sqlHelpers.js';
import { env } from '../config/env.js';
import { DEFAULT_POLICY, agentError, validatePolicy, normalizeFields, fingerprint, missingFields } from './domain.js';
import { actorUserId,actorKey } from './access.js';

const p=(name,value,type=sql.NVarChar(sql.MAX))=>input(name,type,value);
export function mapCase(row) {
  return row && { id:Number(row.case_id),conversationId:Number(row.conversation_id),kind:row.kind,key:row.case_key,
    fields:parseJson(row.fields_json,{}),protectedFields:parseJson(row.protected_fields_json,[]),state:row.state,control:row.control,
    version:row.version,sourceMessageId:Number(row.source_message_id),recordId:row.record_id ? Number(row.record_id):null,
    confirmedAt:iso(row.availability_confirmed_at),updatedAt:iso(row.updated_at) };
}
export function mapAction(row) {
  return row && { id:Number(row.action_id),caseId:Number(row.case_id),conversationId:Number(row.conversation_id),kind:row.kind,
    status:row.status,version:row.version,caseVersion:row.case_version,sourceMessageId:Number(row.source_message_id),recipient:row.recipient,
    content:row.content,language:row.language,reason:row.reason,uncertainty:parseJson(row.uncertainty_json,[]),
    claimedBy:row.claimed_by?Number(row.claimed_by):null,approvedBy:row.approved_by?Number(row.approved_by):null,
    claimedActor:row.claimed_actor,approvedActor:row.approved_actor,
    approvedAt:iso(row.approved_at),approvedContent:row.approved_content,providerMessageId:row.provider_message_id,
    template:parseJson(row.template_json,null),error:row.last_error,updatedAt:iso(row.updated_at) };
}
export async function policy() {
  const r=await query("SELECT setting_value FROM jje.system_settings WHERE setting_key='agent.policy'");
  return validatePolicy({ ...DEFAULT_POLICY,...parseJson(r.recordset[0]?.setting_value,{}) });
}
export async function savePolicy(value,userId) {
  const next=validatePolicy(value);
  await query(`UPDATE jje.system_settings SET setting_value=@value,updated_at=SYSUTCDATETIME() WHERE setting_key='agent.policy';
    INSERT jje.audit_logs(user_id,action,entity_type,entity_id,metadata_json)
    VALUES(@user,'agent.policy_changed','system_setting',NULL,@audit);`,[p('value',JSON.stringify(next)),p('audit',JSON.stringify({policy:next,actor:actorKey(userId)})),p('user',actorUserId(userId),sql.BigInt)]);
  return next;
}
export async function syncAgentSetting() {
  await query(`UPDATE jje.system_settings SET setting_value=@enabled,updated_at=SYSUTCDATETIME() WHERE setting_key='agent.processing.enabled';
    IF @@ROWCOUNT=0 INSERT jje.system_settings(setting_key,setting_value,is_secret,description)
      VALUES('agent.processing.enabled',@enabled,0,'Controlled by AGENT_PROCESSING_ENABLED.');`,[p('enabled',String(env.features.agentProcessing))]);
}
export async function claimConversation(workerId) {
  const r=await query(`;WITH next_job AS (SELECT TOP(1) * FROM jje.agent_conversation_queue WITH(UPDLOCK,READPAST,ROWLOCK)
    WHERE latest_message_id>processed_message_id AND available_at<=SYSUTCDATETIME() AND attempts<5
      AND (locked_until IS NULL OR locked_until<SYSUTCDATETIME()) ORDER BY available_at)
    UPDATE next_job SET locked_by=@worker,locked_until=DATEADD(second,120,SYSUTCDATETIME()),attempts=attempts+1
    OUTPUT inserted.*;`,[p('worker',workerId,sql.VarChar(100))]);
  return r.recordset[0];
}
export async function renewConversation(conversationId,workerId) {
  await query(`UPDATE jje.agent_conversation_queue SET locked_until=DATEADD(second,120,SYSUTCDATETIME())
    WHERE conversation_id=@id AND locked_by=@worker;`,[p('id',conversationId,sql.BigInt),p('worker',workerId,sql.VarChar(100))]);
}
export async function finishConversation(job,workerId,error=null) {
  await query(`UPDATE jje.agent_conversation_queue SET processed_message_id=CASE WHEN @error IS NULL THEN @message ELSE processed_message_id END,
    locked_by=NULL,locked_until=NULL,last_error=@error,
    available_at=CASE WHEN @error IS NULL THEN available_at ELSE DATEADD(second,60,SYSUTCDATETIME()) END
    WHERE conversation_id=@id AND locked_by=@worker;`,[p('id',job.conversation_id,sql.BigInt),p('message',job.latest_message_id,sql.BigInt),p('worker',workerId,sql.VarChar(100)),p('error',error?.message?.slice(0,2000))]);
}
export async function context(conversationId,sourceMessageId) {
  const r=await query(`SELECT TOP(40) message_id,direction,text_body,caption,provider_message_id,parent_provider_message_id,created_at
    FROM jje.messages WHERE conversation_id=@id AND message_id<=@source AND deleted_at IS NULL ORDER BY message_id DESC;
    SELECT * FROM jje.agent_cases WHERE conversation_id=@id AND state NOT IN ('closed','cancelled') ORDER BY case_id;
    SELECT MAX(message_id) latest FROM jje.messages WHERE conversation_id=@id;
    SELECT DISTINCT e.case_id,m.provider_message_id FROM jje.agent_evidence e INNER JOIN jje.agent_cases c ON c.case_id=e.case_id
      INNER JOIN jje.messages m ON m.message_id=e.message_id WHERE c.conversation_id=@id AND m.provider_message_id IS NOT NULL
    UNION SELECT case_id,provider_message_id FROM jje.agent_actions WHERE conversation_id=@id AND provider_message_id IS NOT NULL;
    SELECT processed_message_id FROM jje.agent_conversation_queue WHERE conversation_id=@id;`,[p('id',conversationId,sql.BigInt),p('source',sourceMessageId,sql.BigInt)]);
  return { messages:r.recordsets[0].reverse(), cases:r.recordsets[1].map(mapCase), latestMessageId:Number(r.recordsets[2][0].latest),quoteLinks:r.recordsets[3],processedMessageId:Number(r.recordsets[4][0]?.processed_message_id||0) };
}
export async function getCase(id) { const r=await query('SELECT * FROM jje.agent_cases WHERE case_id=@id',[p('id',id,sql.BigInt)]);return mapCase(r.recordset[0]); }
export async function getAction(id) { const r=await query('SELECT * FROM jje.agent_actions WHERE action_id=@id',[p('id',id,sql.BigInt)]);return mapAction(r.recordset[0]); }
export async function listCases(conversationId=null) {
  const r=await query('SELECT TOP(100) * FROM jje.agent_cases WHERE (@conversation IS NULL OR conversation_id=@conversation) ORDER BY updated_at DESC',[p('conversation',conversationId,sql.BigInt)]);
  return r.recordset.map(mapCase);
}
export async function listActions({ status=null,conversationId=null,limit=50 }={}) {
  const r=await query(`SELECT TOP(@limit) * FROM jje.agent_actions WHERE (@status IS NULL OR status=@status)
    AND (@conversation IS NULL OR conversation_id=@conversation) ORDER BY CASE WHEN status='pending' THEN 0 WHEN status IN ('failed','unknown','blocked') THEN 1 ELSE 2 END,updated_at DESC`,
  [p('status',status,sql.VarChar(30)),p('conversation',conversationId,sql.BigInt),p('limit',clampInteger(limit,50,1,100),sql.Int)]);
  return r.recordset.map(mapAction);
}
export async function caseDetail(id) {
  const record=await getCase(id);if(!record) throw agentError('Case not found.',404);
  const r=await query(`SELECT evidence.*,message.text_body,message.caption,message.provider_timestamp FROM jje.agent_evidence evidence
    LEFT JOIN jje.messages message ON message.message_id=evidence.message_id WHERE evidence.case_id=@id ORDER BY evidence_id DESC;
    SELECT * FROM jje.agent_reviews WHERE case_id=@id ORDER BY review_id DESC;`,[p('id',id,sql.BigInt)]);
  return {...record,evidence:r.recordsets[0].map(row=>({...row,value:parseJson(row.value_json)})),reviews:r.recordsets[1],actions:(await listActions({conversationId:record.conversationId})).filter(a=>a.caseId===record.id)};
}
export async function persistCase({existing,key,kind,conversationId,sourceMessageId,fields,evidence,state='qualifying',runId}) {
  const r=await query(`SET XACT_ABORT ON; BEGIN TRANSACTION;
    DECLARE @id bigint; SELECT @id=case_id FROM jje.agent_cases WITH(UPDLOCK,HOLDLOCK) WHERE conversation_id=@conversation AND case_key=@key;
    IF @id IS NOT NULL AND EXISTS(SELECT 1 FROM jje.agent_cases WHERE case_id=@id AND last_run_id=@run)
    BEGIN COMMIT TRANSACTION;SELECT * FROM jje.agent_cases WHERE case_id=@id;RETURN;END;
    IF @id IS NULL BEGIN
      INSERT jje.agent_cases(conversation_id,case_key,kind,fields_json,source_message_id,state,last_run_id) VALUES(@conversation,@key,@kind,@fields,@source,@state,@run);
      SET @id=SCOPE_IDENTITY();
    END ELSE BEGIN
      IF @expected IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jje.agent_cases WHERE case_id=@id AND version=@expected)
        THROW 51000,'Case changed while processing. Retry with fresh context.',1;
      UPDATE jje.agent_cases SET fields_json=@fields,state=CASE WHEN control='active' THEN @state ELSE state END,
        version=version+1,last_run_id=@run,updated_at=SYSUTCDATETIME() WHERE case_id=@id;
    END;
    INSERT jje.agent_evidence(case_id,field_name,value_json,message_id,evidence_text,verification,case_version)
    SELECT @id,field,value,messageId,evidence,COALESCE(verification,'extracted'),(SELECT version FROM jje.agent_cases WHERE case_id=@id)
    FROM OPENJSON(@evidence) WITH(field varchar(60),value nvarchar(max) AS JSON,messageId bigint,evidence nvarchar(2000),verification varchar(20));
    UPDATE jje.agent_actions SET status='superseded',version=version+1,updated_at=SYSUTCDATETIME()
      WHERE case_id=@id AND case_version<>(SELECT version FROM jje.agent_cases WHERE case_id=@id) AND status IN ('shadow','pending','approved','blocked');
    INSERT jje.outbox_events(event_type,aggregate_type,aggregate_id,payload_json) VALUES('agent.case_updated','agent_case',@id,'{}');
    COMMIT TRANSACTION; SELECT * FROM jje.agent_cases WHERE case_id=@id;`,[
      p('conversation',conversationId,sql.BigInt),p('key',key,sql.VarChar(160)),p('kind',kind,sql.VarChar(20)),p('source',sourceMessageId,sql.BigInt),
      p('fields',JSON.stringify(fields)),p('state',state,sql.VarChar(30)),p('expected',existing?.version,sql.Int),p('run',runId,sql.VarChar(100)),
      p('evidence',JSON.stringify(evidence.map(e=>({...e,value:{value:e.value}}))))]);
  return mapCase(r.recordset[0]);
}
export async function proposeAction({record,sourceMessageId,recipient,kind,content,language='en',reason,uncertainty=[],template=null,regeneration=null,contextKey=null,policy:currentPolicy}) {
  // Language-model wording changes must not resurrect a rejected proposal.
  const key=fingerprint(record.id,kind,record.fields,record.control,contextKey,template,regeneration,kind==='match'?content:null);
  const r=await query(`SET XACT_ABORT ON; BEGIN TRANSACTION;
    IF NOT EXISTS(SELECT 1 FROM jje.agent_actions WITH(UPDLOCK,HOLDLOCK) WHERE deduplication_key=@key)
    BEGIN
      INSERT jje.agent_actions(case_id,conversation_id,kind,status,case_version,source_message_id,recipient,content,language,reason,uncertainty_json,deduplication_key,template_json)
      VALUES(@case,@conversation,@kind,CASE WHEN @source<>(SELECT MAX(message_id) FROM jje.messages WHERE conversation_id=@conversation) THEN 'superseded' ELSE @status END,@version,@source,@recipient,@content,@language,@reason,@uncertainty,@key,@template);
      DECLARE @id bigint=SCOPE_IDENTITY();
      INSERT jje.outbox_events(event_type,aggregate_type,aggregate_id,payload_json) VALUES('agent.action_created','agent_action',@id,'{}');
    END ELSE BEGIN
      UPDATE jje.agent_actions SET status=@status,case_version=@version,source_message_id=@source,content=@content,
        approved_by=NULL,approved_actor=NULL,approved_content=NULL,approved_at=NULL,claimed_by=NULL,claimed_actor=NULL,claimed_at=NULL,version=version+1,updated_at=SYSUTCDATETIME()
        WHERE deduplication_key=@key AND status='superseded' AND NOT EXISTS(SELECT 1 FROM jje.agent_dispatch_attempts attempt WHERE attempt.action_id=jje.agent_actions.action_id);
    END; COMMIT TRANSACTION;
    SELECT * FROM jje.agent_actions WHERE deduplication_key=@key;`,[
    p('key',key,sql.VarChar(200)),p('case',record.id,sql.BigInt),p('conversation',record.conversationId,sql.BigInt),p('kind',kind,sql.VarChar(30)),
    p('status',currentPolicy.mode==='shadow'?'shadow':'pending',sql.VarChar(30)),p('version',record.version,sql.Int),p('source',sourceMessageId,sql.BigInt),
    p('recipient',recipient,sql.VarChar(64)),p('content',content.slice(0,4000)),p('language',language,sql.VarChar(20)),p('reason',reason.slice(0,2000)),p('uncertainty',JSON.stringify(uncertainty)),p('template',template?JSON.stringify(template):null)]);
  return mapAction(r.recordset[0]);
}
export async function mutateAction(id,userId,version,operation,{content,reason=''}={}) {
  if(!['claim','release','edit','approve','reject','cancel','resolve'].includes(operation)) throw agentError('Unknown action operation.',400);
  if(operation==='edit' && (typeof content!=='string'||!content.trim()||content.length>4000)) throw agentError('Message must contain 1–4000 characters.',400);
  const r=await query(`SET XACT_ABORT ON; BEGIN TRANSACTION;
    DECLARE @case bigint;
    SELECT @case=case_id FROM jje.agent_actions WITH(UPDLOCK,HOLDLOCK) WHERE action_id=@id AND version=@version;
    IF @case IS NULL THROW 51000,'Action changed; refresh before continuing.',1;
    IF EXISTS(SELECT 1 FROM jje.agent_actions WHERE action_id=@id AND claimed_actor IS NOT NULL AND claimed_actor<>@actor
      AND claimed_at>DATEADD(minute,-15,SYSUTCDATETIME())) THROW 51000,'Another staff member has claimed this action.',1;
    IF NOT EXISTS(SELECT 1 FROM jje.agent_actions WHERE action_id=@id AND
      (status='pending' OR (@operation IN ('cancel','resolve') AND status IN ('shadow','blocked','failed','unknown','approved'))))
      THROW 51000,'This action cannot be modified in its current state.',1;
    IF @operation='approve' AND EXISTS(SELECT 1 FROM jje.agent_actions a INNER JOIN jje.agent_cases c ON c.case_id=a.case_id
      WHERE a.action_id=@id AND (c.version<>a.case_version OR c.control<>'active' OR a.source_message_id<>(SELECT MAX(message_id) FROM jje.messages WHERE conversation_id=a.conversation_id)))
      THROW 51000,'Context changed or case is paused. Review a new proposal.',1;
    IF @operation IN ('approve','edit') AND EXISTS(SELECT 1 FROM jje.agent_actions WHERE action_id=@id AND
      (kind NOT IN ('clarification','verification') OR (@operation='edit' AND template_json IS NOT NULL)))
      THROW 51000,'Internal review tasks and approved template bodies cannot be sent as edited text.',1;
    UPDATE jje.agent_actions SET version=version+1,updated_at=SYSUTCDATETIME(),
      claimed_by=CASE WHEN @operation='release' THEN NULL ELSE @user END,
      claimed_actor=CASE WHEN @operation='release' THEN NULL ELSE @actor END,
      claimed_at=CASE WHEN @operation='release' THEN NULL ELSE SYSUTCDATETIME() END,
      content=CASE WHEN @operation='edit' THEN @content ELSE content END,
      status=CASE @operation WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' WHEN 'cancel' THEN 'cancelled' WHEN 'resolve' THEN 'resolved' ELSE status END,
      approved_by=CASE WHEN @operation='approve' THEN @user ELSE NULL END,
      approved_actor=CASE WHEN @operation='approve' THEN @actor ELSE NULL END,
      approved_at=CASE WHEN @operation='approve' THEN SYSUTCDATETIME() ELSE NULL END,
      approved_content=CASE WHEN @operation='approve' THEN content ELSE NULL END
    WHERE action_id=@id;
    IF @operation='approve'
      UPDATE c SET protected_fields_json=(SELECT COALESCE('['+STRING_AGG('"'+[key]+'"',',')+']','[]') FROM OPENJSON(c.fields_json))
      FROM jje.agent_cases c WHERE case_id=@case;
    INSERT jje.agent_reviews(action_id,case_id,user_id,actor_key,decision,action_version,snapshot_json)
    VALUES(@id,@case,@user,@actor,@operation,@version,(SELECT content,recipient,case_version,source_message_id,@reason reason FROM jje.agent_actions WHERE action_id=@id FOR JSON PATH,WITHOUT_ARRAY_WRAPPER));
    INSERT jje.outbox_events(event_type,aggregate_type,aggregate_id,payload_json) VALUES('agent.action_updated','agent_action',@id,'{}');
    COMMIT TRANSACTION; SELECT * FROM jje.agent_actions WHERE action_id=@id;`,[
      p('id',id,sql.BigInt),p('user',actorUserId(userId),sql.BigInt),p('actor',actorKey(userId),sql.VarChar(100)),p('version',version,sql.Int),p('operation',operation,sql.VarChar(30)),p('content',content?.trim()),p('reason',reason)]);
  return mapAction(r.recordset[0]);
}
export async function mutateCase(id,userId,version,{operation,fields={}}) {
  if(!['correct','pause','resume','handover','close','cancel'].includes(operation)) throw agentError('Invalid case operation.',400);
  const normalized=normalizeFields(fields);
  const r=await query(`SET XACT_ABORT ON; BEGIN TRANSACTION;
    DECLARE @old nvarchar(max),@protected nvarchar(max);
    SELECT @old=fields_json,@protected=protected_fields_json FROM jje.agent_cases WITH(UPDLOCK,HOLDLOCK) WHERE case_id=@id AND version=@version;
    IF @old IS NULL THROW 51000,'Case changed; refresh before correcting.',1;
    IF @operation='correct' BEGIN
      SELECT @old=JSON_MODIFY(@old,CONCAT('$.',field),JSON_VALUE(value,'$.value'))
      FROM OPENJSON(@fields) WITH(field varchar(60),value nvarchar(max) AS JSON);
    END;
    UPDATE jje.agent_cases SET version=version+1,updated_at=SYSUTCDATETIME(),fields_json=CASE WHEN @operation='correct' THEN @merged ELSE fields_json END,
      protected_fields_json=CASE WHEN @operation='correct' THEN @protectedNext ELSE protected_fields_json END,
      availability_confirmed_at=CASE WHEN @operation='correct' AND @confirm=1 THEN SYSUTCDATETIME() ELSE availability_confirmed_at END,
      control=CASE @operation WHEN 'pause' THEN 'paused' WHEN 'handover' THEN 'handover' WHEN 'resume' THEN 'active' ELSE control END,
      state=CASE @operation WHEN 'close' THEN 'closed' WHEN 'cancel' THEN 'cancelled' WHEN 'correct' THEN @qualified ELSE state END WHERE case_id=@id;
    UPDATE jje.agent_actions SET status='superseded',version=version+1,updated_at=SYSUTCDATETIME() WHERE case_id=@id AND status IN ('shadow','pending','approved','blocked');
    INSERT jje.agent_reviews(case_id,user_id,actor_key,decision,snapshot_json) VALUES(@id,@user,@actor,@operation,@fields);
    INSERT jje.agent_evidence(case_id,field_name,value_json,verification,user_id,actor_key,case_version)
    SELECT @id,field,value,'human',@user,@actor,@version+1 FROM OPENJSON(@fields) WITH(field varchar(60),value nvarchar(max) AS JSON);
    INSERT jje.outbox_events(event_type,aggregate_type,aggregate_id,payload_json) VALUES('agent.case_updated','agent_case',@id,'{}');
    COMMIT TRANSACTION; SELECT * FROM jje.agent_cases WHERE case_id=@id;`,await (async()=>{
      const current=await getCase(id);if(!current)throw agentError('Case not found.',404);
      return [p('id',id,sql.BigInt),p('user',actorUserId(userId),sql.BigInt),p('actor',actorKey(userId),sql.VarChar(100)),p('version',version,sql.Int),p('operation',operation,sql.VarChar(30)),
        p('fields',JSON.stringify(Object.entries(normalized).map(([field,value])=>({field,value:{value}})))),
        p('merged',JSON.stringify({...current.fields,...normalized})),p('qualified',missingFields(current.kind,{...current.fields,...normalized}).length?'qualifying':'ready',sql.VarChar(30)),p('confirm',normalized.availability==='available',sql.Bit),p('protectedNext',JSON.stringify([...new Set([...current.protectedFields,...Object.keys(normalized)])]))];
    })());
  const record=mapCase(r.recordset[0]);await projectCase(record);return record;
}
export async function projectCase(record) {
  const fields=record.fields;
  const table=record.kind==='lead'?'leads':'offerings', idColumn=record.kind==='lead'?'lead_id':'offering_id';
  const priceMin=record.kind==='lead'?'target_price_min':'price_min',priceMax=record.kind==='lead'?'target_price_max':'price_max';
  const r=await query(`SET XACT_ABORT ON; BEGIN TRANSACTION;
    DECLARE @analysis bigint,@record bigint,@slot int;
    SELECT @record=record_id FROM jje.agent_cases WITH(UPDLOCK,HOLDLOCK) WHERE case_id=@case;
    SELECT @analysis=message_analysis_id FROM jje.message_analysis WITH(UPDLOCK,HOLDLOCK) WHERE message_id=@source AND analysis_version=1;
    IF @analysis IS NULL BEGIN INSERT jje.message_analysis(message_id,analysis_version,classification,confidence,model_name,prompt_version,extracted_json,status)
      VALUES(@source,1,@kind,1,'agent','agent-v1',@fields,'completed');SET @analysis=SCOPE_IDENTITY();END;
    IF @record IS NULL BEGIN
      SELECT TOP(1) @record=${idColumn} FROM jje.${table} WITH(UPDLOCK,HOLDLOCK) WHERE message_analysis_id=@analysis
        AND model=JSON_VALUE(@fields,'$.model') AND ISNULL(variant,'')=ISNULL(JSON_VALUE(@fields,'$.variant'),'')
        AND ISNULL(ram_gb,0)=ISNULL(TRY_CONVERT(int,JSON_VALUE(@fields,'$.ramGb')),0)
        AND ISNULL(storage_gb,0)=ISNULL(TRY_CONVERT(int,JSON_VALUE(@fields,'$.storageGb')),0)
        AND NOT EXISTS(SELECT 1 FROM jje.agent_cases own WHERE own.kind=@kind AND own.record_id=jje.${table}.${idColumn});
      IF @record IS NULL BEGIN
        SELECT @slot=COALESCE(MAX(item_index),-1)+1 FROM jje.${table} WHERE message_analysis_id=@analysis;
        INSERT jje.${table}(message_analysis_id,item_index) VALUES(@analysis,@slot);SET @record=SCOPE_IDENTITY();
      END;
      UPDATE jje.agent_cases SET record_id=@record WHERE case_id=@case;
    END;
    UPDATE jje.${table} SET brand=JSON_VALUE(@fields,'$.brand'),model=JSON_VALUE(@fields,'$.model'),variant=JSON_VALUE(@fields,'$.variant'),
      ram_gb=TRY_CONVERT(int,JSON_VALUE(@fields,'$.ramGb')),storage_gb=TRY_CONVERT(int,JSON_VALUE(@fields,'$.storageGb')),
      colors_json=JSON_QUERY(@fields,'$.colors'),quantity_min=TRY_CONVERT(int,JSON_VALUE(@fields,'$.quantityMin')),quantity_max=TRY_CONVERT(int,JSON_VALUE(@fields,'$.quantityMax')),
      ${priceMin}=TRY_CONVERT(decimal(19,4),JSON_VALUE(@fields,'$.priceMin')),${priceMax}=TRY_CONVERT(decimal(19,4),JSON_VALUE(@fields,'$.priceMax')),
      gst_included=CASE JSON_VALUE(@fields,'$.gstIncluded') WHEN 'true' THEN 1 WHEN 'false' THEN 0 ELSE NULL END,
      condition=JSON_VALUE(@fields,'$.condition'),dispatch_location=JSON_VALUE(@fields,'$.dispatchLocation'),status=@status,updated_at=SYSUTCDATETIME()
      WHERE ${idColumn}=@record; COMMIT TRANSACTION;`,[
      p('case',record.id,sql.BigInt),p('source',record.sourceMessageId,sql.BigInt),p('kind',record.kind,sql.VarChar(20)),p('fields',JSON.stringify(fields)),
      p('status',record.kind==='lead'?(['closed','cancelled'].includes(record.state)?'closed':'open'):(['closed','cancelled'].includes(record.state)?'archived':fields.availability==='unavailable'?'sold':missingFields('offering',fields).includes('price')?'pending_price':'complete'),sql.VarChar(30))]);
  return r;
}
export async function offeringCandidates(conversationId) {
  const r=await query(`SELECT TOP(500) c.* FROM jje.agent_cases c INNER JOIN jje.conversations conversation ON conversation.conversation_id=c.conversation_id
    INNER JOIN jje.phone_numbers number ON number.phone_number_id=conversation.phone_number_id
    WHERE c.kind='offering' AND c.state NOT IN ('closed','cancelled') AND c.conversation_id<>@id
      AND number.business_account_id=(SELECT n.business_account_id FROM jje.conversations own INNER JOIN jje.phone_numbers n ON n.phone_number_id=own.phone_number_id WHERE own.conversation_id=@id)
    ORDER BY c.updated_at DESC;`,[p('id',conversationId,sql.BigInt)]);
  return r.recordset.map(mapCase);
}
export async function buyerCandidates(conversationId) {
  const r=await query(`SELECT TOP(100) c.* FROM jje.agent_cases c INNER JOIN jje.conversations conversation ON conversation.conversation_id=c.conversation_id
    INNER JOIN jje.phone_numbers number ON number.phone_number_id=conversation.phone_number_id
    WHERE c.kind='lead' AND c.state NOT IN ('closed','cancelled') AND c.control='active' AND c.conversation_id<>@id
      AND number.business_account_id=(SELECT n.business_account_id FROM jje.conversations own INNER JOIN jje.phone_numbers n ON n.phone_number_id=own.phone_number_id WHERE own.conversation_id=@id)
    ORDER BY c.updated_at DESC;`,[p('id',conversationId,sql.BigInt)]);
  return r.recordset.map(mapCase);
}
export async function linkCases(sourceId,targetId,userId,sourceVersion,targetVersion) {
  const source=await getCase(sourceId),target=await getCase(targetId);
  if(!source||!target||source.id===target.id||source.conversationId!==target.conversationId||source.kind!==target.kind)throw agentError('Choose a different case of the same type in this conversation.',400);
  if(target.control!=='active'||['closed','cancelled'].includes(target.state))throw agentError('Target case is not active.');
  for(const [key,value] of Object.entries(source.fields))if(target.fields[key]!==undefined&&fingerprint(target.fields[key])!==fingerprint(value))throw agentError(`Resolve the conflicting ${key} in case corrections before linking.`);
  const fields={...target.fields,...source.fields};
  await query(`SET XACT_ABORT ON;BEGIN TRANSACTION;
    IF NOT EXISTS(SELECT 1 FROM jje.agent_cases WITH(UPDLOCK,HOLDLOCK) WHERE case_id=@source AND version=@sourceVersion)
      OR NOT EXISTS(SELECT 1 FROM jje.agent_cases WITH(UPDLOCK,HOLDLOCK) WHERE case_id=@target AND version=@targetVersion)
      THROW 51000,'A case changed before linking; refresh.',1;
    UPDATE jje.agent_cases SET fields_json=@fields,protected_fields_json=@protected,version=version+1,
      state=@state,updated_at=SYSUTCDATETIME() WHERE case_id=@target;
    UPDATE jje.agent_evidence SET case_id=@target,case_version=@targetVersion+1 WHERE case_id=@source;
    UPDATE jje.agent_cases SET state='closed',control='handover',version=version+1,updated_at=SYSUTCDATETIME() WHERE case_id=@source;
    UPDATE jje.agent_actions SET status='superseded',version=version+1,updated_at=SYSUTCDATETIME()
      WHERE case_id IN(@source,@target) AND status IN('pending','shadow','approved','blocked');
    INSERT jje.agent_reviews(case_id,user_id,actor_key,decision,snapshot_json) VALUES(@target,@user,@actor,'link',@snapshot),(@source,@user,@actor,'linked_to',@snapshot);
    INSERT jje.outbox_events(event_type,aggregate_type,aggregate_id,payload_json) VALUES('agent.case_updated','agent_case',@target,@snapshot),('agent.case_updated','agent_case',@source,@snapshot);
    COMMIT TRANSACTION;`,[p('source',sourceId,sql.BigInt),p('target',targetId,sql.BigInt),p('user',actorUserId(userId),sql.BigInt),p('actor',actorKey(userId),sql.VarChar(100)),p('sourceVersion',sourceVersion,sql.Int),p('targetVersion',targetVersion,sql.Int),
      p('fields',JSON.stringify(fields)),p('protected',JSON.stringify([...new Set([...target.protectedFields,...Object.keys(source.fields)])])),p('state',missingFields(target.kind,fields).length?'qualifying':'ready',sql.VarChar(30)),p('snapshot',JSON.stringify({sourceId,targetId,sourceVersion,targetVersion}))]);
  const next=await getCase(targetId);await projectCase(next);await projectCase(await getCase(sourceId));return next;
}
export async function reserveRun(runId,conversationId,sourceMessageId,budget) {
  const r=await query(`SET XACT_ABORT ON;BEGIN TRANSACTION;
    DECLARE @lock int;EXEC @lock=sys.sp_getapplock @Resource='jje-agent-budget',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=5000;
    IF @lock<0 THROW 51000,'Agent budget lock unavailable.',1;
    IF NOT EXISTS(SELECT 1 FROM jje.agent_runs WHERE run_id=@run) BEGIN
      INSERT jje.agent_runs(run_id,conversation_id,source_message_id,reserved_usd) VALUES(@run,@conversation,@source,0);
    END;COMMIT TRANSACTION;`,[p('run',runId,sql.VarChar(100)),p('conversation',conversationId,sql.BigInt),p('source',sourceMessageId,sql.BigInt),p('budget',budget,sql.Decimal(12,6))]);return r;
}
export async function reserveModelCall(runId,budget) {
  await query(`SET XACT_ABORT ON;BEGIN TRANSACTION;
    DECLARE @lock int;EXEC @lock=sys.sp_getapplock @Resource='jje-agent-budget',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=5000;
    IF @lock<0 THROW 51000,'Agent budget lock unavailable.',1;
    IF (SELECT COALESCE(SUM(reserved_usd),0) FROM jje.agent_runs WHERE updated_at>=CONVERT(date,SYSUTCDATETIME()))+.25>@budget
      THROW 51000,'Agent daily budget exhausted. Chat remains available.',1;
    IF NOT EXISTS(SELECT 1 FROM jje.agent_runs WHERE run_id=@run AND reserved_usd<1.25) THROW 51000,'Model retry limit reached.',1;
    UPDATE jje.agent_runs SET reserved_usd=reserved_usd+.25,updated_at=SYSUTCDATETIME() WHERE run_id=@run;
    COMMIT TRANSACTION;`,[p('run',runId,sql.VarChar(100)),p('budget',budget,sql.Decimal(12,6))]);
}
export async function updateRun(runId,stage,{inputTokens=0,outputTokens=0,error=null}={}) {
  await query(`UPDATE jje.agent_runs SET stage=@stage,input_tokens=input_tokens+@input,output_tokens=output_tokens+@output,error_message=@error,updated_at=SYSUTCDATETIME() WHERE run_id=@run`,[
    p('run',runId,sql.VarChar(100)),p('stage',stage,sql.VarChar(40)),p('input',inputTokens,sql.Int),p('output',outputTokens,sql.Int),p('error',error?.slice(0,2000))]);
}
export async function health() {
  const r=await query(`SELECT (SELECT COUNT(*) FROM jje.agent_conversation_queue WHERE latest_message_id>processed_message_id) queued,
    (SELECT COUNT(*) FROM jje.agent_conversation_queue WHERE attempts>=5 AND latest_message_id>processed_message_id) failed,
    (SELECT COUNT(*) FROM jje.agent_actions WHERE status='pending') pending,
    (SELECT COUNT(*) FROM jje.agent_actions WHERE status='unknown') unknownSends,
    (SELECT MAX(updated_at) FROM jje.agent_runs) lastRunAt,
    (SELECT COALESCE(SUM(reserved_usd),0) FROM jje.agent_runs WHERE updated_at>=CONVERT(date,SYSUTCDATETIME())) reservedUsd;
    SELECT TOP(30) stage,error_message,updated_at FROM jje.agent_runs ORDER BY updated_at DESC;
    SELECT decision,COUNT(*) total FROM jje.agent_reviews GROUP BY decision;
    SELECT COUNT(*) cases,AVG(DATEDIFF(second,created_at,updated_at)*1.0) qualificationSeconds FROM jje.agent_cases WHERE state='ready';
    SELECT stage,AVG(DATEDIFF(millisecond,created_at,updated_at)*1.0) latencyMs,SUM(input_tokens) inputTokens,SUM(output_tokens) outputTokens FROM jje.agent_runs GROUP BY stage;
    SELECT status,COUNT(*) total FROM jje.agent_dispatch_attempts GROUP BY status;`);
  return {...r.recordsets[0][0],runs:r.recordsets[1],metrics:{reviews:r.recordsets[2],qualification:r.recordsets[3][0],worker:r.recordsets[4],dispatch:r.recordsets[5]},processingEnabled:env.features.agentProcessing,sendingEnabled:env.features.agentSending,policy:await policy()};
}
