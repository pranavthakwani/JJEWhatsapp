SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (SELECT 1 FROM jje.schema_migrations WHERE migration_id = '009_realtime_reliability')
    BEGIN
        IF COL_LENGTH('jje.messages', 'client_request_id') IS NULL
            ALTER TABLE jje.messages ADD client_request_id varchar(80) NULL;

        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('jje.messages') AND name = 'UX_jje_messages_client_request_id')
            EXEC(N'CREATE UNIQUE INDEX UX_jje_messages_client_request_id
              ON jje.messages(client_request_id) WHERE client_request_id IS NOT NULL;');

        IF OBJECT_ID(N'jje.webhook_events', N'U') IS NULL
        BEGIN
            CREATE TABLE jje.webhook_events (
                webhook_event_id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_jje_webhook_events PRIMARY KEY,
                event_key varchar(64) NOT NULL,
                payload_json nvarchar(max) NOT NULL,
                status varchar(20) NOT NULL CONSTRAINT DF_jje_webhook_events_status DEFAULT 'pending',
                attempts int NOT NULL CONSTRAINT DF_jje_webhook_events_attempts DEFAULT 0,
                available_at datetime2(3) NOT NULL CONSTRAINT DF_jje_webhook_events_available DEFAULT SYSUTCDATETIME(),
                locked_at datetime2(3) NULL,
                completed_at datetime2(3) NULL,
                last_error nvarchar(2000) NULL,
                created_at datetime2(3) NOT NULL CONSTRAINT DF_jje_webhook_events_created DEFAULT SYSUTCDATETIME(),
                updated_at datetime2(3) NOT NULL CONSTRAINT DF_jje_webhook_events_updated DEFAULT SYSUTCDATETIME(),
                CONSTRAINT UQ_jje_webhook_events_key UNIQUE(event_key),
                CONSTRAINT CK_jje_webhook_events_status CHECK(status IN ('pending','processing','completed','failed'))
            );
            CREATE INDEX IX_jje_webhook_events_pending ON jje.webhook_events(status, available_at, webhook_event_id);
        END;

        INSERT jje.schema_migrations(migration_id) VALUES ('009_realtime_reliability');
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
