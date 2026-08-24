SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (SELECT 1 FROM jje.schema_migrations WHERE migration_id = '003_seed_configuration')
    BEGIN
        UPDATE jje.roles SET display_name = 'Administrator' WHERE role_key = 'admin';
        IF @@ROWCOUNT = 0 INSERT jje.roles(role_key, display_name) VALUES('admin', 'Administrator');
        UPDATE jje.roles SET display_name = 'Operator' WHERE role_key = 'operator';
        IF @@ROWCOUNT = 0 INSERT jje.roles(role_key, display_name) VALUES('operator', 'Operator');
        UPDATE jje.roles SET display_name = 'Viewer' WHERE role_key = 'viewer';
        IF @@ROWCOUNT = 0 INSERT jje.roles(role_key, display_name) VALUES('viewer', 'Viewer');

        UPDATE jje.system_settings
        SET setting_value = 'false', is_secret = 0,
            description = 'Optional AI lead/offering extraction. WhatsApp remains functional when disabled.',
            updated_at = SYSUTCDATETIME()
        WHERE setting_key = 'ai.extraction.enabled';
        IF @@ROWCOUNT = 0 INSERT jje.system_settings(setting_key, setting_value, is_secret, description)
            VALUES('ai.extraction.enabled', 'false', 0, 'Optional AI lead/offering extraction. WhatsApp remains functional when disabled.');

        UPDATE jje.system_settings
        SET setting_value = 'true', is_secret = 0, description = 'Enable durable campaign recipient processing.', updated_at = SYSUTCDATETIME()
        WHERE setting_key = 'campaign.worker.enabled';
        IF @@ROWCOUNT = 0 INSERT jje.system_settings(setting_key, setting_value, is_secret, description)
            VALUES('campaign.worker.enabled', 'true', 0, 'Enable durable campaign recipient processing.');

        UPDATE jje.system_settings
        SET setting_value = 'local', is_secret = 0, description = 'Media provider: local, azure, or s3.', updated_at = SYSUTCDATETIME()
        WHERE setting_key = 'media.storage.provider';
        IF @@ROWCOUNT = 0 INSERT jje.system_settings(setting_key, setting_value, is_secret, description)
            VALUES('media.storage.provider', 'local', 0, 'Media provider: local, azure, or s3.');

        UPDATE jje.system_settings
        SET setting_value = '91', is_secret = 0, description = 'Default country calling code for locally entered contacts.', updated_at = SYSUTCDATETIME()
        WHERE setting_key = 'whatsapp.default.country_code';
        IF @@ROWCOUNT = 0 INSERT jje.system_settings(setting_key, setting_value, is_secret, description)
            VALUES('whatsapp.default.country_code', '91', 0, 'Default country calling code for locally entered contacts.');

        INSERT jje.schema_migrations(migration_id) VALUES ('003_seed_configuration');
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
