SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (SELECT 1 FROM jje.schema_migrations WHERE migration_id = '005_legacy_import_tracking')
    BEGIN
        CREATE TABLE jje.legacy_import_map (
            legacy_source       varchar(100) NOT NULL,
            source_table        varchar(100) NOT NULL,
            source_id           nvarchar(200) NOT NULL,
            target_table        varchar(100) NOT NULL,
            target_id           bigint NOT NULL,
            source_hash         char(64) NULL,
            imported_at         datetime2(3) NOT NULL CONSTRAINT DF_jje_legacy_import_map_imported DEFAULT SYSUTCDATETIME(),
            updated_at          datetime2(3) NOT NULL CONSTRAINT DF_jje_legacy_import_map_updated DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_jje_legacy_import_map PRIMARY KEY CLUSTERED (legacy_source, source_table, source_id)
        );
        CREATE INDEX IX_jje_legacy_import_map_target
            ON jje.legacy_import_map(target_table, target_id);

        INSERT jje.schema_migrations(migration_id) VALUES ('005_legacy_import_tracking');
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
