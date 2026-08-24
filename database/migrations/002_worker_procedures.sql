SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (SELECT 1 FROM jje.schema_migrations WHERE migration_id = '002_worker_procedures')
    BEGIN
        EXEC(N'
        CREATE OR ALTER PROCEDURE jje.usp_BackgroundJob_ClaimBatch
            @WorkerId varchar(100),
            @JobType varchar(60) = NULL,
            @BatchSize int = 10
        AS
        BEGIN
            SET NOCOUNT ON;
            SET XACT_ABORT ON;

            IF @BatchSize < 1 OR @BatchSize > 100
                THROW 51000, ''BatchSize must be between 1 and 100.'', 1;

            ;WITH claimable AS (
                SELECT TOP (@BatchSize) job_id
                FROM jje.background_jobs WITH (UPDLOCK, READPAST, ROWLOCK)
                WHERE status = ''queued''
                  AND available_at <= SYSUTCDATETIME()
                  AND (@JobType IS NULL OR job_type = @JobType)
                ORDER BY priority ASC, available_at ASC, job_id ASC
            )
            UPDATE jobs
            SET status = ''processing'',
                locked_at = SYSUTCDATETIME(),
                locked_by = @WorkerId,
                attempt_count = attempt_count + 1,
                updated_at = SYSUTCDATETIME()
            OUTPUT inserted.*
            FROM jje.background_jobs jobs
            INNER JOIN claimable ON claimable.job_id = jobs.job_id;
        END;');

        EXEC(N'
        CREATE OR ALTER PROCEDURE jje.usp_CampaignRecipient_ClaimBatch
            @WorkerId varchar(100),
            @BatchSize int = 20
        AS
        BEGIN
            SET NOCOUNT ON;
            SET XACT_ABORT ON;

            IF @BatchSize < 1 OR @BatchSize > 100
                THROW 51001, ''BatchSize must be between 1 and 100.'', 1;

            ;WITH claimable AS (
                SELECT TOP (@BatchSize) recipient.campaign_recipient_id
                FROM jje.campaign_recipients recipient WITH (UPDLOCK, READPAST, ROWLOCK)
                INNER JOIN jje.campaigns campaign ON campaign.campaign_id = recipient.campaign_id
                WHERE recipient.status = ''queued''
                  AND campaign.status IN (''pending'', ''sending'')
                  AND (recipient.next_attempt_at IS NULL OR recipient.next_attempt_at <= SYSUTCDATETIME())
                ORDER BY recipient.campaign_recipient_id ASC
            )
            UPDATE recipient
            SET status = ''dispatching'',
                locked_at = SYSUTCDATETIME(),
                locked_by = @WorkerId,
                attempt_count = attempt_count + 1,
                updated_at = SYSUTCDATETIME()
            OUTPUT inserted.*
            FROM jje.campaign_recipients recipient
            INNER JOIN claimable ON claimable.campaign_recipient_id = recipient.campaign_recipient_id;
        END;');

        EXEC(N'
        CREATE OR ALTER PROCEDURE jje.usp_Job_RequeueExpiredLocks
            @LockTimeoutMinutes int = 10
        AS
        BEGIN
            SET NOCOUNT ON;
            SET XACT_ABORT ON;

            IF @LockTimeoutMinutes < 1 OR @LockTimeoutMinutes > 1440
                THROW 51002, ''LockTimeoutMinutes must be between 1 and 1440.'', 1;

            UPDATE jje.background_jobs
            SET status = CASE WHEN attempt_count >= max_attempts THEN ''failed'' ELSE ''queued'' END,
                available_at = CASE WHEN attempt_count >= max_attempts THEN available_at ELSE DATEADD(second, POWER(2, CASE WHEN attempt_count > 10 THEN 10 ELSE attempt_count END) * 15, SYSUTCDATETIME()) END,
                locked_at = NULL,
                locked_by = NULL,
                last_error = COALESCE(last_error, ''Worker lock expired''),
                updated_at = SYSUTCDATETIME()
            WHERE status = ''processing''
              AND locked_at < DATEADD(minute, -@LockTimeoutMinutes, SYSUTCDATETIME());

            UPDATE jje.campaign_recipients
            SET status = CASE WHEN attempt_count >= 5 THEN ''failed'' ELSE ''queued'' END,
                next_attempt_at = CASE WHEN attempt_count >= 5 THEN next_attempt_at ELSE DATEADD(second, POWER(2, CASE WHEN attempt_count > 10 THEN 10 ELSE attempt_count END) * 15, SYSUTCDATETIME()) END,
                locked_at = NULL,
                locked_by = NULL,
                error_message = COALESCE(error_message, ''Worker lock expired''),
                updated_at = SYSUTCDATETIME()
            WHERE status = ''dispatching''
              AND locked_at < DATEADD(minute, -@LockTimeoutMinutes, SYSUTCDATETIME());
        END;');

        EXEC(N'
        CREATE OR ALTER PROCEDURE jje.usp_InboundMessage_Store
            @MetaPhoneNumberId varchar(100),
            @ContactWaId varchar(64),
            @ContactPhoneNumber varchar(32) = NULL,
            @ProfileName nvarchar(240) = NULL,
            @ProviderMessageId varchar(255),
            @ParentProviderMessageId varchar(255) = NULL,
            @MessageType varchar(30),
            @TextBody nvarchar(max) = NULL,
            @Caption nvarchar(max) = NULL,
            @ProviderMediaId varchar(255) = NULL,
            @MimeType nvarchar(255) = NULL,
            @FileName nvarchar(512) = NULL,
            @ProviderTimestamp datetime2(3) = NULL
        AS
        BEGIN
            SET NOCOUNT ON;
            SET XACT_ABORT ON;

            DECLARE @PhoneNumberId bigint;
            DECLARE @ContactId bigint;
            DECLARE @ConversationId bigint;
            DECLARE @MessageId bigint;
            DECLARE @ParentMessageId bigint;
            DECLARE @EventPayload nvarchar(max);
            DECLARE @AnalysisEnabled bit = 0;

            BEGIN TRANSACTION;

            SELECT @MessageId = message_id
            FROM jje.messages WITH (UPDLOCK, HOLDLOCK)
            WHERE provider_message_id = @ProviderMessageId;

            IF @MessageId IS NOT NULL
            BEGIN
                COMMIT TRANSACTION;
                SELECT @MessageId AS message_id, CAST(0 AS bit) AS was_inserted;
                RETURN;
            END;

            SELECT @PhoneNumberId = phone_number_id
            FROM jje.phone_numbers WITH (UPDLOCK, HOLDLOCK)
            WHERE meta_phone_number_id = @MetaPhoneNumberId
              AND status = ''active'';

            IF @PhoneNumberId IS NULL
                THROW 51010, ''Unknown or inactive Meta phone number.'', 1;

            SELECT @ContactId = contact_id
            FROM jje.contacts WITH (UPDLOCK, HOLDLOCK)
            WHERE wa_id = @ContactWaId;

            IF @ContactId IS NULL
            BEGIN
                INSERT jje.contacts(wa_id, phone_number, profile_name, last_inbound_at)
                VALUES(@ContactWaId, @ContactPhoneNumber, NULLIF(LTRIM(RTRIM(@ProfileName)), ''''), SYSUTCDATETIME());
                SET @ContactId = SCOPE_IDENTITY();
            END
            ELSE
            BEGIN
                UPDATE jje.contacts
                SET phone_number = COALESCE(@ContactPhoneNumber, phone_number),
                    profile_name = COALESCE(NULLIF(LTRIM(RTRIM(@ProfileName)), ''''), profile_name),
                    last_inbound_at = SYSUTCDATETIME(),
                    updated_at = SYSUTCDATETIME()
                WHERE contact_id = @ContactId;
            END;

            SELECT @ConversationId = conversation_id
            FROM jje.conversations WITH (UPDLOCK, HOLDLOCK)
            WHERE phone_number_id = @PhoneNumberId
              AND contact_id = @ContactId;

            IF @ConversationId IS NULL
            BEGIN
                INSERT jje.conversations(phone_number_id, contact_id)
                VALUES(@PhoneNumberId, @ContactId);
                SET @ConversationId = SCOPE_IDENTITY();
            END;

            IF @ParentProviderMessageId IS NOT NULL
                SELECT @ParentMessageId = message_id
                FROM jje.messages
                WHERE provider_message_id = @ParentProviderMessageId;

            INSERT jje.messages(
                conversation_id, phone_number_id, contact_id, direction,
                message_type, provider_message_id, parent_message_id,
                parent_provider_message_id, text_body, caption,
                provider_media_id, mime_type, file_name, status,
                provider_timestamp
            )
            VALUES(
                @ConversationId, @PhoneNumberId, @ContactId, ''inbound'',
                @MessageType, @ProviderMessageId, @ParentMessageId,
                @ParentProviderMessageId, @TextBody, @Caption,
                @ProviderMediaId, @MimeType, @FileName, ''received'',
                COALESCE(@ProviderTimestamp, SYSUTCDATETIME())
            );
            SET @MessageId = SCOPE_IDENTITY();

            UPDATE jje.conversations
            SET last_message_id = @MessageId,
                last_message_preview = LEFT(COALESCE(NULLIF(@TextBody, ''''), NULLIF(@Caption, ''''), CONCAT(''['', @MessageType, '']'')), 500),
                last_message_at = COALESCE(@ProviderTimestamp, SYSUTCDATETIME()),
                unread_count = unread_count + 1,
                is_archived = 0,
                updated_at = SYSUTCDATETIME()
            WHERE conversation_id = @ConversationId;

            SET @EventPayload = (
                SELECT @MessageId AS messageId,
                       @ConversationId AS conversationId,
                       @PhoneNumberId AS phoneNumberId,
                       @ContactId AS contactId
                FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
            );

            INSERT jje.outbox_events(event_type, aggregate_type, aggregate_id, payload_json)
            VALUES(''message.created'', ''message'', @MessageId, @EventPayload);

            SELECT @AnalysisEnabled = CASE WHEN setting_value = ''true'' THEN 1 ELSE 0 END
            FROM jje.system_settings
            WHERE setting_key = ''ai.extraction.enabled'';

            IF @AnalysisEnabled = 1 AND COALESCE(NULLIF(@TextBody, ''''), NULLIF(@Caption, '''')) IS NOT NULL
            BEGIN
                INSERT jje.background_jobs(job_type, aggregate_type, aggregate_id, deduplication_key, payload_json)
                VALUES(''analyze_message'', ''message'', @MessageId, CONCAT(''ai:message:'', @MessageId, '':v1''), @EventPayload);
            END;

            COMMIT TRANSACTION;
            SELECT @MessageId AS message_id, CAST(1 AS bit) AS was_inserted;
        END;');

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
            DECLARE @CurrentRank tinyint;
            DECLARE @IncomingRank tinyint;
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

            SET @CurrentRank = CASE @CurrentStatus WHEN ''queued'' THEN 0 WHEN ''sent'' THEN 1 WHEN ''delivered'' THEN 2 WHEN ''read'' THEN 3 ELSE 0 END;
            SET @IncomingRank = CASE @Status WHEN ''queued'' THEN 0 WHEN ''sent'' THEN 1 WHEN ''delivered'' THEN 2 WHEN ''read'' THEN 3 ELSE 0 END;

            INSERT jje.message_status_history(message_id, status, error_code, error_message, provider_timestamp)
            VALUES(@MessageId, @Status, @ErrorCode, @ErrorMessage, COALESCE(@ProviderTimestamp, SYSUTCDATETIME()));

            IF @Status = ''failed'' OR @IncomingRank >= @CurrentRank
            BEGIN
                UPDATE jje.messages
                SET status = @Status,
                    error_code = CASE WHEN @Status = ''failed'' THEN @ErrorCode ELSE error_code END,
                    error_message = CASE WHEN @Status = ''failed'' THEN @ErrorMessage ELSE error_message END,
                    sent_at = CASE WHEN @Status = ''sent'' AND sent_at IS NULL THEN COALESCE(@ProviderTimestamp, SYSUTCDATETIME()) ELSE sent_at END,
                    delivered_at = CASE WHEN @Status = ''delivered'' AND delivered_at IS NULL THEN COALESCE(@ProviderTimestamp, SYSUTCDATETIME()) ELSE delivered_at END,
                    read_at = CASE WHEN @Status = ''read'' AND read_at IS NULL THEN COALESCE(@ProviderTimestamp, SYSUTCDATETIME()) ELSE read_at END,
                    failed_at = CASE WHEN @Status = ''failed'' AND failed_at IS NULL THEN COALESCE(@ProviderTimestamp, SYSUTCDATETIME()) ELSE failed_at END,
                    updated_at = SYSUTCDATETIME()
                WHERE message_id = @MessageId;

                SET @EventPayload = (
                    SELECT @MessageId AS messageId,
                           @Status AS status,
                           @ErrorCode AS errorCode,
                           @ErrorMessage AS errorMessage
                    FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
                );

                INSERT jje.outbox_events(event_type, aggregate_type, aggregate_id, payload_json)
                VALUES(''message.status_updated'', ''message'', @MessageId, @EventPayload);
            END;

            COMMIT TRANSACTION;
            SELECT CAST(1 AS bit) AS was_updated, @MessageId AS message_id;
        END;');

        INSERT jje.schema_migrations(migration_id) VALUES ('002_worker_procedures');
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
