SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (SELECT 1 FROM jje.schema_migrations WHERE migration_id = '007_monotonic_message_receipts')
    BEGIN
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

            DECLARE @MessageId bigint;
            DECLARE @CurrentStatus varchar(30);
            DECLARE @CurrentRank smallint;
            DECLARE @IncomingRank smallint;
            DECLARE @FinalStatus varchar(30);
            DECLARE @StatusAt datetime2(3) = COALESCE(@ProviderTimestamp, SYSUTCDATETIME());
            DECLARE @EventPayload nvarchar(max);

            BEGIN TRANSACTION;

            SELECT @MessageId = message_id, @CurrentStatus = status
            FROM jje.messages WITH (UPDLOCK, HOLDLOCK)
            WHERE provider_message_id = @ProviderMessageId;

            IF @MessageId IS NULL
            BEGIN
                COMMIT TRANSACTION;
                SELECT CAST(0 AS bit) AS was_updated, CAST(NULL AS bigint) AS message_id;
                RETURN;
            END;

            SET @CurrentRank = CASE @CurrentStatus
                WHEN ''queued'' THEN 0 WHEN ''sent'' THEN 1 WHEN ''delivered'' THEN 2
                WHEN ''read'' THEN 3 WHEN ''failed'' THEN 4 ELSE -1 END;
            SET @IncomingRank = CASE @Status
                WHEN ''queued'' THEN 0 WHEN ''sent'' THEN 1 WHEN ''delivered'' THEN 2
                WHEN ''read'' THEN 3 WHEN ''failed'' THEN 4 ELSE -1 END;

            INSERT jje.message_status_history(message_id, status, error_code, error_message, provider_timestamp)
            VALUES(@MessageId, @Status, @ErrorCode, @ErrorMessage, @StatusAt);

            UPDATE jje.messages
            SET status = CASE WHEN @IncomingRank >= @CurrentRank THEN @Status ELSE status END,
                error_code = CASE WHEN @Status = ''failed'' THEN @ErrorCode ELSE error_code END,
                error_message = CASE WHEN @Status = ''failed'' THEN @ErrorMessage ELSE error_message END,
                sent_at = CASE
                    WHEN @Status IN (''sent'', ''delivered'', ''read'') AND sent_at IS NULL THEN @StatusAt
                    ELSE sent_at END,
                delivered_at = CASE
                    WHEN @Status IN (''delivered'', ''read'') AND delivered_at IS NULL THEN @StatusAt
                    ELSE delivered_at END,
                read_at = CASE WHEN @Status = ''read'' AND read_at IS NULL THEN @StatusAt ELSE read_at END,
                failed_at = CASE WHEN @Status = ''failed'' AND failed_at IS NULL THEN @StatusAt ELSE failed_at END,
                updated_at = SYSUTCDATETIME()
            WHERE message_id = @MessageId;

            SELECT @FinalStatus = status FROM jje.messages WHERE message_id = @MessageId;
            SET @EventPayload = (
                SELECT @MessageId AS messageId, @FinalStatus AS status,
                       @ErrorCode AS errorCode, @ErrorMessage AS errorMessage
                FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
            );

            INSERT jje.outbox_events(event_type, aggregate_type, aggregate_id, payload_json)
            VALUES(''message.status_updated'', ''message'', @MessageId, @EventPayload);

            COMMIT TRANSACTION;
            SELECT CAST(1 AS bit) AS was_updated, @MessageId AS message_id;
        END;');

        INSERT jje.schema_migrations(migration_id) VALUES ('007_monotonic_message_receipts');
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
