SET XACT_ABORT ON;
BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (SELECT 1 FROM jje.schema_migrations WHERE migration_id = '006_leadops_indexes')
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID('jje.leads') AND name='IX_jje_leads_operations')
            CREATE INDEX IX_jje_leads_operations ON jje.leads(status,created_at DESC,lead_id DESC) INCLUDE (brand,model,ram_gb,storage_gb,target_price_min,target_price_max,message_analysis_id);

        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID('jje.offerings') AND name='IX_jje_offerings_operations')
            CREATE INDEX IX_jje_offerings_operations ON jje.offerings(status,created_at DESC,offering_id DESC) INCLUDE (brand,model,ram_gb,storage_gb,price_min,price_max,message_analysis_id);

        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID('jje.message_analysis') AND name='IX_jje_message_analysis_operations')
            CREATE INDEX IX_jje_message_analysis_operations ON jje.message_analysis(classification,created_at DESC,message_analysis_id DESC) INCLUDE (message_id,status,confidence,token_input,token_output);

        INSERT jje.schema_migrations(migration_id) VALUES ('006_leadops_indexes');
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
