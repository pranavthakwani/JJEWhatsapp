SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (SELECT 1 FROM jje.schema_migrations WHERE migration_id = '004_campaign_status_and_message_status')
    BEGIN
        ALTER TABLE jje.campaigns DROP CONSTRAINT CK_jje_campaigns_status;
        ALTER TABLE jje.campaigns ADD CONSTRAINT CK_jje_campaigns_status
            CHECK (status IN ('draft','pending','sending','awaiting_opt_in','completed','failed','cancelled'));

        EXEC(N'
        CREATE OR ALTER PROCEDURE jje.usp_MessageStatus_Apply
            @ProviderMessageId varchar(255),
            @Status varchar(30),
            @ProviderTimestamp datetime2(3) = NULL,
            @ErrorCode varchar(100) = NULL,
            @ErrorMessage nvarchar(2000) = NULL
        AS
        BEGIN
            SET NOCOUNT ON;
            SET XACT_ABORT ON;
            IF @Status NOT IN (''queued'', ''sent'', ''delivered'', ''read'', ''failed'')
                THROW 51011, ''Unsupported message status.'', 1;

            DECLARE @MessageId bigint, @CurrentStatus varchar(30), @CurrentRank tinyint, @IncomingRank tinyint;
            DECLARE @EventPayload nvarchar(max);
            BEGIN TRANSACTION;
            SELECT @MessageId = message_id, @CurrentStatus = status
            FROM jje.messages WITH (UPDLOCK, HOLDLOCK) WHERE provider_message_id = @ProviderMessageId;
            IF @MessageId IS NULL
            BEGIN
                COMMIT TRANSACTION;
                SELECT CAST(0 AS bit) AS was_updated, CAST(NULL AS bigint) AS message_id;
                RETURN;
            END;

            SET @CurrentRank = CASE @CurrentStatus WHEN ''queued'' THEN 0 WHEN ''sent'' THEN 1 WHEN ''delivered'' THEN 2 WHEN ''read'' THEN 3 ELSE 0 END;
            SET @IncomingRank = CASE @Status WHEN ''queued'' THEN 0 WHEN ''sent'' THEN 1 WHEN ''delivered'' THEN 2 WHEN ''read'' THEN 3 ELSE 0 END;

            INSERT jje.message_status_history(message_id, status, error_code, error_message, provider_timestamp)
            VALUES(@MessageId, @Status, @ErrorCode, @ErrorMessage, COALESCE(@ProviderTimestamp, SYSUTCDATETIME()));

            IF (@Status = ''failed'' AND @CurrentRank < 2) OR (@Status <> ''failed'' AND @IncomingRank >= @CurrentRank)
            BEGIN
                UPDATE jje.messages SET status = @Status,
                    error_code = CASE WHEN @Status = ''failed'' THEN @ErrorCode ELSE error_code END,
                    error_message = CASE WHEN @Status = ''failed'' THEN @ErrorMessage ELSE error_message END,
                    sent_at = CASE WHEN @Status IN (''sent'',''delivered'',''read'') THEN COALESCE(sent_at, @ProviderTimestamp, SYSUTCDATETIME()) ELSE sent_at END,
                    delivered_at = CASE WHEN @Status IN (''delivered'',''read'') THEN COALESCE(delivered_at, @ProviderTimestamp, SYSUTCDATETIME()) ELSE delivered_at END,
                    read_at = CASE WHEN @Status = ''read'' THEN COALESCE(read_at, @ProviderTimestamp, SYSUTCDATETIME()) ELSE read_at END,
                    failed_at = CASE WHEN @Status = ''failed'' THEN COALESCE(failed_at, @ProviderTimestamp, SYSUTCDATETIME()) ELSE failed_at END,
                    updated_at = SYSUTCDATETIME()
                WHERE message_id = @MessageId;

                SET @EventPayload = (SELECT @MessageId messageId, @Status status, @ErrorCode errorCode, @ErrorMessage errorMessage FOR JSON PATH, WITHOUT_ARRAY_WRAPPER);
                INSERT jje.outbox_events(event_type, aggregate_type, aggregate_id, payload_json)
                VALUES(''message.status_updated'', ''message'', @MessageId, @EventPayload);
            END;
            COMMIT TRANSACTION;
            SELECT CAST(1 AS bit) AS was_updated, @MessageId AS message_id;
        END;');

        INSERT jje.schema_migrations(migration_id) VALUES ('004_campaign_status_and_message_status');
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
