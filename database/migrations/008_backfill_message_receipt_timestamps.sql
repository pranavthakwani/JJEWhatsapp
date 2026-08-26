SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (SELECT 1 FROM jje.schema_migrations WHERE migration_id = '008_backfill_message_receipt_timestamps')
    BEGIN
        UPDATE jje.messages
        SET sent_at = CASE
                WHEN status IN ('sent','delivered','read')
                  THEN COALESCE(sent_at, delivered_at, read_at, provider_timestamp, created_at)
                ELSE sent_at END,
            delivered_at = CASE
                WHEN status IN ('delivered','read')
                  THEN COALESCE(delivered_at, read_at, provider_timestamp, created_at)
                ELSE delivered_at END,
            read_at = CASE
                WHEN status = 'read' THEN COALESCE(read_at, provider_timestamp, created_at)
                ELSE read_at END,
            updated_at = SYSUTCDATETIME()
        WHERE direction = 'outbound'
          AND (
            (status IN ('sent','delivered','read') AND sent_at IS NULL)
            OR (status IN ('delivered','read') AND delivered_at IS NULL)
            OR (status = 'read' AND read_at IS NULL)
          );

        UPDATE jje.campaign_recipients
        SET sent_at = CASE
                WHEN status IN ('sent','delivered','read') THEN COALESCE(sent_at, delivered_at, read_at, updated_at, created_at)
                ELSE sent_at END,
            delivered_at = CASE
                WHEN status IN ('delivered','read') THEN COALESCE(delivered_at, read_at, updated_at, created_at)
                ELSE delivered_at END,
            read_at = CASE WHEN status = 'read' THEN COALESCE(read_at, updated_at, created_at) ELSE read_at END,
            updated_at = SYSUTCDATETIME()
        WHERE (status IN ('sent','delivered','read') AND sent_at IS NULL)
           OR (status IN ('delivered','read') AND delivered_at IS NULL)
           OR (status = 'read' AND read_at IS NULL);

        INSERT jje.schema_migrations(migration_id) VALUES ('008_backfill_message_receipt_timestamps');
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
