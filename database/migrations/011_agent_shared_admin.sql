SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF NOT EXISTS(SELECT 1 FROM jje.schema_migrations WHERE migration_id='011_agent_shared_admin')
BEGIN
  ALTER TABLE jje.agent_reviews ALTER COLUMN user_id bigint NULL;
  ALTER TABLE jje.agent_actions ADD claimed_actor varchar(100) NULL, approved_actor varchar(100) NULL;
  ALTER TABLE jje.agent_reviews ADD actor_key varchar(100) NULL;
  ALTER TABLE jje.agent_evidence ADD actor_key varchar(100) NULL;
  EXEC('UPDATE jje.agent_actions SET claimed_actor=CONCAT(''user:'',claimed_by) WHERE claimed_by IS NOT NULL; UPDATE jje.agent_actions SET approved_actor=CONCAT(''user:'',approved_by) WHERE approved_by IS NOT NULL; UPDATE jje.agent_reviews SET actor_key=CONCAT(''user:'',user_id) WHERE user_id IS NOT NULL; UPDATE jje.agent_evidence SET actor_key=CONCAT(''user:'',user_id) WHERE user_id IS NOT NULL;');
  INSERT jje.schema_migrations(migration_id) VALUES('011_agent_shared_admin');
END;
COMMIT TRANSACTION;
