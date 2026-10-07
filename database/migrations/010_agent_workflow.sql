SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF NOT EXISTS (SELECT 1 FROM jje.schema_migrations WHERE migration_id='010_agent_workflow')
BEGIN
  CREATE TABLE jje.agent_cases (
    case_id bigint IDENTITY PRIMARY KEY, conversation_id bigint NOT NULL REFERENCES jje.conversations(conversation_id),
    kind varchar(20) NOT NULL CHECK(kind IN ('lead','offering')), case_key varchar(160) NOT NULL,
    fields_json nvarchar(max) NOT NULL DEFAULT '{}', protected_fields_json nvarchar(max) NOT NULL DEFAULT '[]',
    state varchar(30) NOT NULL DEFAULT 'qualifying', control varchar(20) NOT NULL DEFAULT 'active',
    version int NOT NULL DEFAULT 1, source_message_id bigint NOT NULL REFERENCES jje.messages(message_id), last_run_id varchar(100) NULL,
    record_id bigint NULL, availability_confirmed_at datetime2(3) NULL,
    created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), updated_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UX_agent_case_key UNIQUE(conversation_id,case_key),
    CHECK(ISJSON(fields_json)=1 AND ISJSON(protected_fields_json)=1),
    CHECK(control IN ('active','paused','handover')), CHECK(state IN ('qualifying','ready','waiting_reply','review','closed','cancelled'))
  );
  CREATE TABLE jje.agent_evidence (
    evidence_id bigint IDENTITY PRIMARY KEY, case_id bigint NOT NULL REFERENCES jje.agent_cases(case_id),
    field_name varchar(60) NOT NULL, value_json nvarchar(max) NOT NULL,
    message_id bigint NULL REFERENCES jje.messages(message_id), evidence_text nvarchar(2000) NULL,
    verification varchar(20) NOT NULL, user_id bigint NULL REFERENCES jje.users(user_id),
    case_version int NOT NULL, created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    CHECK(ISJSON(value_json)=1), CHECK(verification IN ('extracted','human','conflict'))
  );
  CREATE TABLE jje.agent_actions (
    action_id bigint IDENTITY PRIMARY KEY, case_id bigint NOT NULL REFERENCES jje.agent_cases(case_id),
    conversation_id bigint NOT NULL REFERENCES jje.conversations(conversation_id), kind varchar(30) NOT NULL,
    status varchar(30) NOT NULL DEFAULT 'pending', version int NOT NULL DEFAULT 1, case_version int NOT NULL,
    source_message_id bigint NOT NULL, recipient varchar(64) NOT NULL, content nvarchar(4000) NOT NULL,
    language varchar(20) NOT NULL, reason nvarchar(2000) NOT NULL, uncertainty_json nvarchar(max) NOT NULL DEFAULT '[]',
    deduplication_key varchar(200) NOT NULL UNIQUE, claimed_by bigint NULL REFERENCES jje.users(user_id),
    claimed_at datetime2(3) NULL, approved_by bigint NULL REFERENCES jje.users(user_id), approved_at datetime2(3) NULL,
    approved_content nvarchar(4000) NULL, provider_message_id varchar(255) NULL, message_id bigint NULL REFERENCES jje.messages(message_id),
    template_json nvarchar(max) NULL, last_error nvarchar(2000) NULL,
    created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), updated_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    CHECK(kind IN ('clarification','verification','review','handover','match')),
    CHECK(status IN ('shadow','pending','approved','dispatching','accepted','sent','delivered','read','failed','unknown','blocked','rejected','cancelled','superseded','resolved'))
  );
  CREATE INDEX IX_agent_actions_inbox ON jje.agent_actions(status,updated_at DESC);
  CREATE TABLE jje.agent_reviews (
    review_id bigint IDENTITY PRIMARY KEY, action_id bigint NULL REFERENCES jje.agent_actions(action_id),
    case_id bigint NOT NULL REFERENCES jje.agent_cases(case_id), user_id bigint NOT NULL REFERENCES jje.users(user_id),
    decision varchar(30) NOT NULL, action_version int NULL, snapshot_json nvarchar(max) NOT NULL,
    created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), CHECK(ISJSON(snapshot_json)=1)
  );
  CREATE TABLE jje.agent_dispatch_attempts (
    attempt_id bigint IDENTITY PRIMARY KEY, action_id bigint NOT NULL UNIQUE REFERENCES jje.agent_actions(action_id),
    request_id varchar(80) NOT NULL UNIQUE, status varchar(30) NOT NULL DEFAULT 'prepared',
    provider_message_id varchar(255) NULL, error_message nvarchar(2000) NULL,
    created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), updated_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE TABLE jje.agent_conversation_queue (
    conversation_id bigint PRIMARY KEY REFERENCES jje.conversations(conversation_id), latest_message_id bigint NOT NULL,
    first_pending_at datetime2(3) NOT NULL, available_at datetime2(3) NOT NULL,
    locked_by varchar(100) NULL, locked_until datetime2(3) NULL, processed_message_id bigint NOT NULL DEFAULT 0,
    attempts int NOT NULL DEFAULT 0, last_error nvarchar(2000) NULL
  );
  CREATE TABLE jje.agent_runs (
    run_id varchar(100) PRIMARY KEY, conversation_id bigint NULL, source_message_id bigint NULL,
    stage varchar(40) NOT NULL DEFAULT 'queued', input_tokens int NOT NULL DEFAULT 0, output_tokens int NOT NULL DEFAULT 0,
    reserved_usd decimal(12,6) NOT NULL DEFAULT 0, estimated_usd decimal(12,6) NOT NULL DEFAULT 0,
    error_message nvarchar(2000) NULL, created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE TABLE jje.agent_checkpoints (
    thread_id varchar(200) NOT NULL, checkpoint_ns varchar(200) NOT NULL, checkpoint_id varchar(100) NOT NULL,
    parent_id varchar(100) NULL, checkpoint_type varchar(50) NOT NULL, checkpoint_data varbinary(max) NOT NULL,
    metadata_type varchar(50) NOT NULL, metadata_data varbinary(max) NOT NULL,
    PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id)
  );
  CREATE TABLE jje.agent_checkpoint_writes (
    thread_id varchar(200) NOT NULL, checkpoint_ns varchar(200) NOT NULL, checkpoint_id varchar(100) NOT NULL,
    task_id varchar(200) NOT NULL, write_index int NOT NULL, channel nvarchar(200) NOT NULL,
    value_type varchar(50) NOT NULL, value_data varbinary(max) NOT NULL, task_path nvarchar(1000) NULL,
    PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id,task_id,write_index)
  );
  INSERT jje.system_settings(setting_key,setting_value,is_secret,description)
  VALUES('agent.policy','{"mode":"shadow","allowlist":[],"dailyBudgetUsd":5,"maxClarifications":2,"cooldownHours":24,"staleHours":24}',0,'Agent pilot policy; environment toggles remain the master switches.');
  INSERT jje.schema_migrations(migration_id) VALUES('010_agent_workflow');
END;
COMMIT TRANSACTION;
GO
IF OBJECT_ID('jje.analysis_revisions','U') IS NULL
CREATE TABLE jje.analysis_revisions (
  revision_id bigint IDENTITY PRIMARY KEY,
  message_analysis_id bigint NOT NULL REFERENCES jje.message_analysis(message_analysis_id),
  extracted_json nvarchar(max) NOT NULL CHECK(ISJSON(extracted_json)=1),
  classification varchar(30) NOT NULL, model_name nvarchar(100) NULL, prompt_version varchar(50) NULL,
  created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID('jje.agent_cases') AND name='UX_agent_case_record')
CREATE UNIQUE INDEX UX_agent_case_record ON jje.agent_cases(kind,record_id) WHERE record_id IS NOT NULL;
GO
CREATE OR ALTER TRIGGER jje.tr_agent_message_queue ON jje.messages AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  -- Never resend an obsolete proposal after either party advances the chat.
  UPDATE action SET status='superseded', version=version+1, updated_at=SYSUTCDATETIME()
  FROM jje.agent_actions action INNER JOIN inserted msg ON msg.conversation_id=action.conversation_id
  WHERE action.status IN ('shadow','pending','approved','blocked') AND msg.message_id>action.source_message_id
    AND ISNULL(msg.client_request_id,'')<>CONCAT('agent:',action.action_id);
  IF NOT EXISTS(SELECT 1 FROM jje.system_settings WHERE setting_key='agent.processing.enabled' AND setting_value='true') RETURN;
  DECLARE @now datetime2(3)=SYSUTCDATETIME();
  ;WITH source AS (SELECT conversation_id,MIN(message_id) first_id,MAX(message_id) latest FROM inserted
    WHERE direction='inbound' AND deleted_at IS NULL AND COALESCE(NULLIF(text_body,''),NULLIF(caption,'')) IS NOT NULL GROUP BY conversation_id)
  MERGE jje.agent_conversation_queue WITH(HOLDLOCK) target USING source ON target.conversation_id=source.conversation_id
  WHEN MATCHED THEN UPDATE SET latest_message_id=source.latest,
    first_pending_at=CASE WHEN target.processed_message_id>=target.latest_message_id THEN @now ELSE target.first_pending_at END,
    attempts=0, available_at=CASE WHEN DATEADD(second,15,CASE WHEN target.processed_message_id>=target.latest_message_id THEN @now ELSE target.first_pending_at END)<DATEADD(second,3,@now)
      THEN DATEADD(second,15,target.first_pending_at) ELSE DATEADD(second,3,@now) END
  WHEN NOT MATCHED THEN INSERT(conversation_id,latest_message_id,processed_message_id,first_pending_at,available_at) VALUES(source.conversation_id,source.latest,source.first_id-1,@now,DATEADD(second,3,@now));
END;
GO
CREATE OR ALTER TRIGGER jje.tr_agent_delivery ON jje.messages AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF NOT UPDATE(status) RETURN;
  UPDATE action SET status=msg.status,last_error=msg.error_message,updated_at=SYSUTCDATETIME()
  FROM jje.agent_actions action INNER JOIN inserted msg ON msg.provider_message_id=action.provider_message_id
  WHERE msg.status IN ('sent','delivered','read','failed');
  INSERT jje.outbox_events(event_type,aggregate_type,aggregate_id,payload_json)
    SELECT 'agent.action_updated','agent_action',action.action_id,'{}' FROM jje.agent_actions action
    INNER JOIN inserted msg ON msg.provider_message_id=action.provider_message_id WHERE msg.status IN ('sent','delivered','read','failed');
END;
