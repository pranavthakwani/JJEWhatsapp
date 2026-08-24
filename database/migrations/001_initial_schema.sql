SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'jje')
        EXEC(N'CREATE SCHEMA [jje] AUTHORIZATION [dbo];');

    IF OBJECT_ID(N'jje.schema_migrations', N'U') IS NULL
    BEGIN
        CREATE TABLE jje.schema_migrations (
            migration_id       varchar(100) NOT NULL,
            applied_at         datetime2(3) NOT NULL CONSTRAINT DF_jje_schema_migrations_applied_at DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_jje_schema_migrations PRIMARY KEY CLUSTERED (migration_id)
        );
    END;

    IF NOT EXISTS (SELECT 1 FROM jje.schema_migrations WHERE migration_id = '001_initial_schema')
    BEGIN
        CREATE TABLE jje.roles (
            role_id             smallint IDENTITY(1,1) NOT NULL,
            role_key            varchar(40) NOT NULL,
            display_name        nvarchar(100) NOT NULL,
            created_at          datetime2(3) NOT NULL CONSTRAINT DF_jje_roles_created_at DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_jje_roles PRIMARY KEY CLUSTERED (role_id),
            CONSTRAINT UQ_jje_roles_role_key UNIQUE (role_key)
        );

        CREATE TABLE jje.users (
            user_id             bigint IDENTITY(1,1) NOT NULL,
            display_name        nvarchar(160) NOT NULL,
            email               nvarchar(320) NOT NULL,
            password_hash       nvarchar(500) NOT NULL,
            status              varchar(20) NOT NULL CONSTRAINT DF_jje_users_status DEFAULT 'active',
            last_login_at       datetime2(3) NULL,
            created_at          datetime2(3) NOT NULL CONSTRAINT DF_jje_users_created_at DEFAULT SYSUTCDATETIME(),
            updated_at          datetime2(3) NOT NULL CONSTRAINT DF_jje_users_updated_at DEFAULT SYSUTCDATETIME(),
            row_version         rowversion NOT NULL,
            CONSTRAINT PK_jje_users PRIMARY KEY CLUSTERED (user_id),
            CONSTRAINT CK_jje_users_status CHECK (status IN ('active','disabled','locked'))
        );
        CREATE UNIQUE INDEX UX_jje_users_email ON jje.users(email);

        CREATE TABLE jje.user_roles (
            user_id             bigint NOT NULL,
            role_id             smallint NOT NULL,
            assigned_at         datetime2(3) NOT NULL CONSTRAINT DF_jje_user_roles_assigned_at DEFAULT SYSUTCDATETIME(),
            assigned_by_user_id bigint NULL,
            CONSTRAINT PK_jje_user_roles PRIMARY KEY CLUSTERED (user_id, role_id),
            CONSTRAINT FK_jje_user_roles_user FOREIGN KEY (user_id) REFERENCES jje.users(user_id),
            CONSTRAINT FK_jje_user_roles_role FOREIGN KEY (role_id) REFERENCES jje.roles(role_id),
            CONSTRAINT FK_jje_user_roles_assigned_by FOREIGN KEY (assigned_by_user_id) REFERENCES jje.users(user_id)
        );

        CREATE TABLE jje.devices (
            device_id           bigint IDENTITY(1,1) NOT NULL,
            device_token_hash   binary(32) NOT NULL,
            user_id             bigint NULL,
            device_name         nvarchar(160) NULL,
            user_agent          nvarchar(1000) NULL,
            ip_address          varchar(64) NULL,
            status              varchar(20) NOT NULL CONSTRAINT DF_jje_devices_status DEFAULT 'pending',
            approved_by_user_id bigint NULL,
            approved_at         datetime2(3) NULL,
            last_seen_at        datetime2(3) NULL,
            created_at          datetime2(3) NOT NULL CONSTRAINT DF_jje_devices_created_at DEFAULT SYSUTCDATETIME(),
            updated_at          datetime2(3) NOT NULL CONSTRAINT DF_jje_devices_updated_at DEFAULT SYSUTCDATETIME(),
            row_version         rowversion NOT NULL,
            CONSTRAINT PK_jje_devices PRIMARY KEY CLUSTERED (device_id),
            CONSTRAINT UQ_jje_devices_token_hash UNIQUE (device_token_hash),
            CONSTRAINT CK_jje_devices_status CHECK (status IN ('pending','approved','blocked','revoked')),
            CONSTRAINT FK_jje_devices_user FOREIGN KEY (user_id) REFERENCES jje.users(user_id),
            CONSTRAINT FK_jje_devices_approved_by FOREIGN KEY (approved_by_user_id) REFERENCES jje.users(user_id)
        );

        CREATE TABLE jje.sessions (
            session_id          bigint IDENTITY(1,1) NOT NULL,
            session_token_hash  binary(32) NOT NULL,
            user_id             bigint NOT NULL,
            device_id           bigint NULL,
            expires_at          datetime2(3) NOT NULL,
            revoked_at          datetime2(3) NULL,
            last_seen_at        datetime2(3) NULL,
            created_at          datetime2(3) NOT NULL CONSTRAINT DF_jje_sessions_created_at DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_jje_sessions PRIMARY KEY CLUSTERED (session_id),
            CONSTRAINT UQ_jje_sessions_token_hash UNIQUE (session_token_hash),
            CONSTRAINT FK_jje_sessions_user FOREIGN KEY (user_id) REFERENCES jje.users(user_id),
            CONSTRAINT FK_jje_sessions_device FOREIGN KEY (device_id) REFERENCES jje.devices(device_id)
        );
        CREATE INDEX IX_jje_sessions_user_active ON jje.sessions(user_id, expires_at) INCLUDE (revoked_at);

        CREATE TABLE jje.business_accounts (
            business_account_id bigint IDENTITY(1,1) NOT NULL,
            meta_waba_id         varchar(100) NOT NULL,
            name                 nvarchar(200) NOT NULL,
            status               varchar(20) NOT NULL CONSTRAINT DF_jje_business_accounts_status DEFAULT 'active',
            created_at           datetime2(3) NOT NULL CONSTRAINT DF_jje_business_accounts_created_at DEFAULT SYSUTCDATETIME(),
            updated_at           datetime2(3) NOT NULL CONSTRAINT DF_jje_business_accounts_updated_at DEFAULT SYSUTCDATETIME(),
            row_version          rowversion NOT NULL,
            CONSTRAINT PK_jje_business_accounts PRIMARY KEY CLUSTERED (business_account_id),
            CONSTRAINT UQ_jje_business_accounts_waba UNIQUE (meta_waba_id),
            CONSTRAINT CK_jje_business_accounts_status CHECK (status IN ('active','inactive'))
        );

        CREATE TABLE jje.phone_numbers (
            phone_number_id      bigint IDENTITY(1,1) NOT NULL,
            business_account_id  bigint NOT NULL,
            display_name         nvarchar(200) NOT NULL,
            phone_number         varchar(32) NOT NULL,
            meta_phone_number_id varchar(100) NOT NULL,
            access_token_cipher  varbinary(max) NOT NULL,
            verify_token_hash    binary(32) NOT NULL,
            api_version          varchar(20) NOT NULL CONSTRAINT DF_jje_phone_numbers_api_version DEFAULT 'v22.0',
            webhook_path         nvarchar(500) NULL,
            is_default           bit NOT NULL CONSTRAINT DF_jje_phone_numbers_is_default DEFAULT 0,
            status               varchar(20) NOT NULL CONSTRAINT DF_jje_phone_numbers_status DEFAULT 'active',
            created_at           datetime2(3) NOT NULL CONSTRAINT DF_jje_phone_numbers_created_at DEFAULT SYSUTCDATETIME(),
            updated_at           datetime2(3) NOT NULL CONSTRAINT DF_jje_phone_numbers_updated_at DEFAULT SYSUTCDATETIME(),
            row_version          rowversion NOT NULL,
            CONSTRAINT PK_jje_phone_numbers PRIMARY KEY CLUSTERED (phone_number_id),
            CONSTRAINT UQ_jje_phone_numbers_meta_id UNIQUE (meta_phone_number_id),
            CONSTRAINT FK_jje_phone_numbers_account FOREIGN KEY (business_account_id) REFERENCES jje.business_accounts(business_account_id),
            CONSTRAINT CK_jje_phone_numbers_status CHECK (status IN ('active','inactive'))
        );
        CREATE UNIQUE INDEX UX_jje_phone_numbers_single_default ON jje.phone_numbers(is_default) WHERE is_default = 1;

        CREATE TABLE jje.contacts (
            contact_id            bigint IDENTITY(1,1) NOT NULL,
            wa_id                 varchar(64) NOT NULL,
            phone_number          varchar(32) NULL,
            profile_name          nvarchar(240) NULL,
            business_name         nvarchar(240) NULL,
            notes                 nvarchar(2000) NULL,
            opt_in_status         varchar(30) NOT NULL CONSTRAINT DF_jje_contacts_opt_in_status DEFAULT 'unknown',
            opt_in_keyword        nvarchar(100) NULL,
            opt_in_source         varchar(50) NULL,
            opt_in_updated_at     datetime2(3) NULL,
            last_opt_in_template  nvarchar(512) NULL,
            last_opt_in_prompt_at datetime2(3) NULL,
            last_inbound_at       datetime2(3) NULL,
            last_outbound_at      datetime2(3) NULL,
            created_at            datetime2(3) NOT NULL CONSTRAINT DF_jje_contacts_created_at DEFAULT SYSUTCDATETIME(),
            updated_at            datetime2(3) NOT NULL CONSTRAINT DF_jje_contacts_updated_at DEFAULT SYSUTCDATETIME(),
            row_version           rowversion NOT NULL,
            CONSTRAINT PK_jje_contacts PRIMARY KEY CLUSTERED (contact_id),
            CONSTRAINT UQ_jje_contacts_wa_id UNIQUE (wa_id),
            CONSTRAINT CK_jje_contacts_opt_in CHECK (opt_in_status IN ('unknown','pending_initial','pending_followup','opted_in','opted_out'))
        );
        CREATE INDEX IX_jje_contacts_phone ON jje.contacts(phone_number) WHERE phone_number IS NOT NULL;
        CREATE INDEX IX_jje_contacts_name ON jje.contacts(profile_name) INCLUDE (business_name, phone_number);

        CREATE TABLE jje.conversations (
            conversation_id       bigint IDENTITY(1,1) NOT NULL,
            phone_number_id       bigint NOT NULL,
            contact_id            bigint NOT NULL,
            last_message_id       bigint NULL,
            last_message_preview  nvarchar(500) NULL,
            last_message_at       datetime2(3) NULL,
            unread_count          int NOT NULL CONSTRAINT DF_jje_conversations_unread DEFAULT 0,
            is_archived           bit NOT NULL CONSTRAINT DF_jje_conversations_archived DEFAULT 0,
            cleared_at            datetime2(3) NULL,
            created_at            datetime2(3) NOT NULL CONSTRAINT DF_jje_conversations_created_at DEFAULT SYSUTCDATETIME(),
            updated_at            datetime2(3) NOT NULL CONSTRAINT DF_jje_conversations_updated_at DEFAULT SYSUTCDATETIME(),
            row_version           rowversion NOT NULL,
            CONSTRAINT PK_jje_conversations PRIMARY KEY CLUSTERED (conversation_id),
            CONSTRAINT UQ_jje_conversations_number_contact UNIQUE (phone_number_id, contact_id),
            CONSTRAINT FK_jje_conversations_number FOREIGN KEY (phone_number_id) REFERENCES jje.phone_numbers(phone_number_id),
            CONSTRAINT FK_jje_conversations_contact FOREIGN KEY (contact_id) REFERENCES jje.contacts(contact_id),
            CONSTRAINT CK_jje_conversations_unread CHECK (unread_count >= 0)
        );
        CREATE INDEX IX_jje_conversations_number_last_message ON jje.conversations(phone_number_id, is_archived, last_message_at DESC, conversation_id DESC);

        CREATE TABLE jje.campaigns (
            campaign_id           bigint IDENTITY(1,1) NOT NULL,
            phone_number_id       bigint NOT NULL,
            contact_list_id       bigint NULL,
            title                 nvarchar(240) NOT NULL,
            mode                  varchar(20) NOT NULL,
            body_text             nvarchar(max) NULL,
            template_name         nvarchar(512) NULL,
            initial_template_name nvarchar(512) NULL,
            followup_template_name nvarchar(512) NULL,
            template_language     varchar(20) NULL,
            template_params_json  nvarchar(max) NULL,
            media_asset_id        bigint NULL,
            status                varchar(30) NOT NULL CONSTRAINT DF_jje_campaigns_status DEFAULT 'pending',
            total_recipients      int NOT NULL CONSTRAINT DF_jje_campaigns_total DEFAULT 0,
            sent_count            int NOT NULL CONSTRAINT DF_jje_campaigns_sent DEFAULT 0,
            failed_count          int NOT NULL CONSTRAINT DF_jje_campaigns_failed DEFAULT 0,
            created_by_user_id    bigint NULL,
            created_at            datetime2(3) NOT NULL CONSTRAINT DF_jje_campaigns_created_at DEFAULT SYSUTCDATETIME(),
            updated_at            datetime2(3) NOT NULL CONSTRAINT DF_jje_campaigns_updated_at DEFAULT SYSUTCDATETIME(),
            started_at            datetime2(3) NULL,
            completed_at          datetime2(3) NULL,
            row_version           rowversion NOT NULL,
            CONSTRAINT PK_jje_campaigns PRIMARY KEY CLUSTERED (campaign_id),
            CONSTRAINT FK_jje_campaigns_number FOREIGN KEY (phone_number_id) REFERENCES jje.phone_numbers(phone_number_id),
            CONSTRAINT FK_jje_campaigns_created_by FOREIGN KEY (created_by_user_id) REFERENCES jje.users(user_id),
            CONSTRAINT CK_jje_campaigns_mode CHECK (mode IN ('text','image','video','audio','document','template')),
            CONSTRAINT CK_jje_campaigns_status CHECK (status IN ('draft','pending','sending','completed','failed','cancelled')),
            CONSTRAINT CK_jje_campaigns_template_json CHECK (template_params_json IS NULL OR ISJSON(template_params_json) = 1),
            CONSTRAINT CK_jje_campaigns_counts CHECK (total_recipients >= 0 AND sent_count >= 0 AND failed_count >= 0)
        );

        CREATE TABLE jje.messages (
            message_id             bigint IDENTITY(1,1) NOT NULL,
            conversation_id        bigint NOT NULL,
            phone_number_id        bigint NOT NULL,
            contact_id             bigint NOT NULL,
            direction              varchar(10) NOT NULL,
            message_type           varchar(30) NOT NULL,
            provider_message_id     varchar(255) NULL,
            parent_message_id       bigint NULL,
            parent_provider_message_id varchar(255) NULL,
            text_body               nvarchar(max) NULL,
            caption                 nvarchar(max) NULL,
            provider_media_id       varchar(255) NULL,
            mime_type               nvarchar(255) NULL,
            file_name               nvarchar(512) NULL,
            template_name           nvarchar(512) NULL,
            template_language       varchar(20) NULL,
            template_params_json    nvarchar(max) NULL,
            campaign_id             bigint NULL,
            status                  varchar(30) NOT NULL CONSTRAINT DF_jje_messages_status DEFAULT 'queued',
            error_code              varchar(100) NULL,
            error_message           nvarchar(2000) NULL,
            provider_timestamp      datetime2(3) NULL,
            sent_at                 datetime2(3) NULL,
            delivered_at            datetime2(3) NULL,
            read_at                 datetime2(3) NULL,
            failed_at               datetime2(3) NULL,
            starred_at              datetime2(3) NULL,
            deleted_at              datetime2(3) NULL,
            created_at              datetime2(3) NOT NULL CONSTRAINT DF_jje_messages_created_at DEFAULT SYSUTCDATETIME(),
            updated_at              datetime2(3) NOT NULL CONSTRAINT DF_jje_messages_updated_at DEFAULT SYSUTCDATETIME(),
            row_version             rowversion NOT NULL,
            CONSTRAINT PK_jje_messages PRIMARY KEY CLUSTERED (message_id),
            CONSTRAINT FK_jje_messages_conversation FOREIGN KEY (conversation_id) REFERENCES jje.conversations(conversation_id),
            CONSTRAINT FK_jje_messages_number FOREIGN KEY (phone_number_id) REFERENCES jje.phone_numbers(phone_number_id),
            CONSTRAINT FK_jje_messages_contact FOREIGN KEY (contact_id) REFERENCES jje.contacts(contact_id),
            CONSTRAINT FK_jje_messages_parent FOREIGN KEY (parent_message_id) REFERENCES jje.messages(message_id),
            CONSTRAINT FK_jje_messages_campaign FOREIGN KEY (campaign_id) REFERENCES jje.campaigns(campaign_id),
            CONSTRAINT CK_jje_messages_direction CHECK (direction IN ('inbound','outbound')),
            CONSTRAINT CK_jje_messages_template_json CHECK (template_params_json IS NULL OR ISJSON(template_params_json) = 1)
        );
        CREATE UNIQUE INDEX UX_jje_messages_provider_id ON jje.messages(provider_message_id) WHERE provider_message_id IS NOT NULL;
        CREATE INDEX IX_jje_messages_conversation_created ON jje.messages(conversation_id, created_at DESC, message_id DESC) INCLUDE (status, message_type, deleted_at);
        CREATE INDEX IX_jje_messages_starred ON jje.messages(phone_number_id, starred_at DESC) WHERE starred_at IS NOT NULL;
        CREATE INDEX IX_jje_messages_campaign ON jje.messages(campaign_id) WHERE campaign_id IS NOT NULL;

        ALTER TABLE jje.conversations ADD CONSTRAINT FK_jje_conversations_last_message FOREIGN KEY (last_message_id) REFERENCES jje.messages(message_id);

        CREATE TABLE jje.message_status_history (
            message_status_id      bigint IDENTITY(1,1) NOT NULL,
            message_id             bigint NOT NULL,
            status                 varchar(30) NOT NULL,
            error_code             varchar(100) NULL,
            error_message          nvarchar(2000) NULL,
            provider_timestamp     datetime2(3) NULL,
            created_at             datetime2(3) NOT NULL CONSTRAINT DF_jje_message_status_created_at DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_jje_message_status PRIMARY KEY CLUSTERED (message_status_id),
            CONSTRAINT FK_jje_message_status_message FOREIGN KEY (message_id) REFERENCES jje.messages(message_id)
        );
        CREATE INDEX IX_jje_message_status_message ON jje.message_status_history(message_id, created_at DESC);

        CREATE TABLE jje.media_assets (
            media_asset_id         bigint IDENTITY(1,1) NOT NULL,
            message_id             bigint NULL,
            provider_media_id      varchar(255) NULL,
            storage_provider       varchar(30) NOT NULL,
            storage_key            nvarchar(1000) NOT NULL,
            original_file_name     nvarchar(512) NULL,
            mime_type              nvarchar(255) NOT NULL,
            size_bytes             bigint NOT NULL,
            sha256_hash            binary(32) NULL,
            created_at             datetime2(3) NOT NULL CONSTRAINT DF_jje_media_assets_created_at DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_jje_media_assets PRIMARY KEY CLUSTERED (media_asset_id),
            CONSTRAINT FK_jje_media_assets_message FOREIGN KEY (message_id) REFERENCES jje.messages(message_id),
            CONSTRAINT CK_jje_media_assets_size CHECK (size_bytes >= 0),
            CONSTRAINT CK_jje_media_assets_provider CHECK (storage_provider IN ('local','azure','s3','meta'))
        );
        CREATE UNIQUE INDEX UX_jje_media_assets_message ON jje.media_assets(message_id) WHERE message_id IS NOT NULL;
        CREATE INDEX IX_jje_media_assets_provider_media ON jje.media_assets(provider_media_id) WHERE provider_media_id IS NOT NULL;

        ALTER TABLE jje.campaigns ADD CONSTRAINT FK_jje_campaigns_media FOREIGN KEY (media_asset_id) REFERENCES jje.media_assets(media_asset_id);

        CREATE TABLE jje.templates (
            template_id            bigint IDENTITY(1,1) NOT NULL,
            phone_number_id        bigint NOT NULL,
            template_name          nvarchar(512) NOT NULL,
            category               varchar(50) NULL,
            language               varchar(20) NOT NULL,
            status                 varchar(30) NULL,
            header_format          varchar(30) NULL,
            body_text              nvarchar(max) NULL,
            footer_text            nvarchar(1000) NULL,
            buttons_json           nvarchar(max) NULL,
            meta_template_id       varchar(255) NULL,
            last_synced_at         datetime2(3) NULL,
            created_at             datetime2(3) NOT NULL CONSTRAINT DF_jje_templates_created_at DEFAULT SYSUTCDATETIME(),
            updated_at             datetime2(3) NOT NULL CONSTRAINT DF_jje_templates_updated_at DEFAULT SYSUTCDATETIME(),
            row_version            rowversion NOT NULL,
            CONSTRAINT PK_jje_templates PRIMARY KEY CLUSTERED (template_id),
            CONSTRAINT UQ_jje_templates_number_name_language UNIQUE (phone_number_id, template_name, language),
            CONSTRAINT FK_jje_templates_number FOREIGN KEY (phone_number_id) REFERENCES jje.phone_numbers(phone_number_id),
            CONSTRAINT CK_jje_templates_buttons_json CHECK (buttons_json IS NULL OR ISJSON(buttons_json) = 1)
        );

        CREATE TABLE jje.contact_lists (
            contact_list_id        bigint IDENTITY(1,1) NOT NULL,
            phone_number_id        bigint NOT NULL,
            name                   nvarchar(240) NOT NULL,
            source                 varchar(30) NOT NULL CONSTRAINT DF_jje_contact_lists_source DEFAULT 'manual',
            is_archived            bit NOT NULL CONSTRAINT DF_jje_contact_lists_archived DEFAULT 0,
            cleared_at             datetime2(3) NULL,
            created_by_user_id     bigint NULL,
            created_at             datetime2(3) NOT NULL CONSTRAINT DF_jje_contact_lists_created_at DEFAULT SYSUTCDATETIME(),
            updated_at             datetime2(3) NOT NULL CONSTRAINT DF_jje_contact_lists_updated_at DEFAULT SYSUTCDATETIME(),
            row_version            rowversion NOT NULL,
            CONSTRAINT PK_jje_contact_lists PRIMARY KEY CLUSTERED (contact_list_id),
            CONSTRAINT FK_jje_contact_lists_number FOREIGN KEY (phone_number_id) REFERENCES jje.phone_numbers(phone_number_id),
            CONSTRAINT FK_jje_contact_lists_created_by FOREIGN KEY (created_by_user_id) REFERENCES jje.users(user_id)
        );
        CREATE INDEX IX_jje_contact_lists_number ON jje.contact_lists(phone_number_id, is_archived, created_at DESC);

        ALTER TABLE jje.campaigns ADD CONSTRAINT FK_jje_campaigns_contact_list FOREIGN KEY (contact_list_id) REFERENCES jje.contact_lists(contact_list_id);

        CREATE TABLE jje.contact_list_members (
            contact_list_member_id bigint IDENTITY(1,1) NOT NULL,
            contact_list_id        bigint NOT NULL,
            contact_id             bigint NOT NULL,
            position               int NOT NULL CONSTRAINT DF_jje_contact_list_members_position DEFAULT 0,
            created_at             datetime2(3) NOT NULL CONSTRAINT DF_jje_contact_list_members_created_at DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_jje_contact_list_members PRIMARY KEY CLUSTERED (contact_list_member_id),
            CONSTRAINT UQ_jje_contact_list_members UNIQUE (contact_list_id, contact_id),
            CONSTRAINT FK_jje_contact_list_members_list FOREIGN KEY (contact_list_id) REFERENCES jje.contact_lists(contact_list_id) ON DELETE CASCADE,
            CONSTRAINT FK_jje_contact_list_members_contact FOREIGN KEY (contact_id) REFERENCES jje.contacts(contact_id)
        );
        CREATE INDEX IX_jje_contact_list_members_order ON jje.contact_list_members(contact_list_id, position, contact_list_member_id);

        CREATE TABLE jje.campaign_recipients (
            campaign_recipient_id  bigint IDENTITY(1,1) NOT NULL,
            campaign_id            bigint NOT NULL,
            recipient_wa_id        varchar(64) NOT NULL,
            recipient_name         nvarchar(240) NULL,
            contact_list_member_id bigint NULL,
            contact_id             bigint NULL,
            conversation_id        bigint NULL,
            message_id             bigint NULL,
            pending_text_body      nvarchar(max) NULL,
            prompt_template_name   nvarchar(512) NULL,
            status                 varchar(30) NOT NULL CONSTRAINT DF_jje_campaign_recipients_status DEFAULT 'queued',
            attempt_count          int NOT NULL CONSTRAINT DF_jje_campaign_recipients_attempts DEFAULT 0,
            next_attempt_at        datetime2(3) NULL,
            locked_at              datetime2(3) NULL,
            locked_by              varchar(100) NULL,
            error_message          nvarchar(2000) NULL,
            opt_in_requested_at    datetime2(3) NULL,
            opted_in_at            datetime2(3) NULL,
            sent_at                datetime2(3) NULL,
            delivered_at           datetime2(3) NULL,
            read_at                datetime2(3) NULL,
            failed_at              datetime2(3) NULL,
            created_at             datetime2(3) NOT NULL CONSTRAINT DF_jje_campaign_recipients_created_at DEFAULT SYSUTCDATETIME(),
            updated_at             datetime2(3) NOT NULL CONSTRAINT DF_jje_campaign_recipients_updated_at DEFAULT SYSUTCDATETIME(),
            row_version            rowversion NOT NULL,
            CONSTRAINT PK_jje_campaign_recipients PRIMARY KEY CLUSTERED (campaign_recipient_id),
            CONSTRAINT UQ_jje_campaign_recipient UNIQUE (campaign_id, recipient_wa_id),
            CONSTRAINT FK_jje_campaign_recipients_campaign FOREIGN KEY (campaign_id) REFERENCES jje.campaigns(campaign_id) ON DELETE CASCADE,
            CONSTRAINT FK_jje_campaign_recipients_member FOREIGN KEY (contact_list_member_id) REFERENCES jje.contact_list_members(contact_list_member_id),
            CONSTRAINT FK_jje_campaign_recipients_contact FOREIGN KEY (contact_id) REFERENCES jje.contacts(contact_id),
            CONSTRAINT FK_jje_campaign_recipients_conversation FOREIGN KEY (conversation_id) REFERENCES jje.conversations(conversation_id),
            CONSTRAINT FK_jje_campaign_recipients_message FOREIGN KEY (message_id) REFERENCES jje.messages(message_id),
            CONSTRAINT CK_jje_campaign_recipients_attempts CHECK (attempt_count >= 0)
        );
        CREATE INDEX IX_jje_campaign_recipients_claim ON jje.campaign_recipients(status, next_attempt_at, campaign_recipient_id) INCLUDE (campaign_id, attempt_count);

        CREATE TABLE jje.chat_filter_settings (
            phone_number_id        bigint NOT NULL,
            favorite_keys_json     nvarchar(max) NOT NULL CONSTRAINT DF_jje_chat_filters_favorites DEFAULT '[]',
            custom_filters_json    nvarchar(max) NOT NULL CONSTRAINT DF_jje_chat_filters_custom DEFAULT '[]',
            created_at             datetime2(3) NOT NULL CONSTRAINT DF_jje_chat_filters_created_at DEFAULT SYSUTCDATETIME(),
            updated_at             datetime2(3) NOT NULL CONSTRAINT DF_jje_chat_filters_updated_at DEFAULT SYSUTCDATETIME(),
            row_version            rowversion NOT NULL,
            CONSTRAINT PK_jje_chat_filter_settings PRIMARY KEY CLUSTERED (phone_number_id),
            CONSTRAINT FK_jje_chat_filters_number FOREIGN KEY (phone_number_id) REFERENCES jje.phone_numbers(phone_number_id),
            CONSTRAINT CK_jje_chat_filters_favorites_json CHECK (ISJSON(favorite_keys_json) = 1),
            CONSTRAINT CK_jje_chat_filters_custom_json CHECK (ISJSON(custom_filters_json) = 1)
        );

        CREATE TABLE jje.background_jobs (
            job_id                 bigint IDENTITY(1,1) NOT NULL,
            job_type               varchar(60) NOT NULL,
            aggregate_type         varchar(60) NULL,
            aggregate_id           bigint NULL,
            deduplication_key       varchar(255) NULL,
            payload_json            nvarchar(max) NOT NULL,
            status                  varchar(20) NOT NULL CONSTRAINT DF_jje_background_jobs_status DEFAULT 'queued',
            priority                tinyint NOT NULL CONSTRAINT DF_jje_background_jobs_priority DEFAULT 5,
            attempt_count           int NOT NULL CONSTRAINT DF_jje_background_jobs_attempts DEFAULT 0,
            max_attempts            int NOT NULL CONSTRAINT DF_jje_background_jobs_max_attempts DEFAULT 5,
            available_at            datetime2(3) NOT NULL CONSTRAINT DF_jje_background_jobs_available DEFAULT SYSUTCDATETIME(),
            locked_at               datetime2(3) NULL,
            locked_by               varchar(100) NULL,
            last_error              nvarchar(2000) NULL,
            completed_at            datetime2(3) NULL,
            created_at              datetime2(3) NOT NULL CONSTRAINT DF_jje_background_jobs_created_at DEFAULT SYSUTCDATETIME(),
            updated_at              datetime2(3) NOT NULL CONSTRAINT DF_jje_background_jobs_updated_at DEFAULT SYSUTCDATETIME(),
            row_version              rowversion NOT NULL,
            CONSTRAINT PK_jje_background_jobs PRIMARY KEY CLUSTERED (job_id),
            CONSTRAINT CK_jje_background_jobs_payload CHECK (ISJSON(payload_json) = 1),
            CONSTRAINT CK_jje_background_jobs_status CHECK (status IN ('queued','processing','completed','failed','cancelled')),
            CONSTRAINT CK_jje_background_jobs_attempts CHECK (attempt_count >= 0 AND max_attempts > 0)
        );
        CREATE UNIQUE INDEX UX_jje_background_jobs_dedup ON jje.background_jobs(deduplication_key) WHERE deduplication_key IS NOT NULL;
        CREATE INDEX IX_jje_background_jobs_claim ON jje.background_jobs(status, available_at, priority, job_id) INCLUDE (job_type, attempt_count, max_attempts);

        CREATE TABLE jje.message_analysis (
            message_analysis_id    bigint IDENTITY(1,1) NOT NULL,
            message_id             bigint NOT NULL,
            analysis_version       smallint NOT NULL CONSTRAINT DF_jje_message_analysis_version DEFAULT 1,
            classification         varchar(30) NOT NULL,
            confidence             decimal(6,5) NULL,
            model_name             varchar(100) NULL,
            prompt_version         varchar(50) NULL,
            extracted_json         nvarchar(max) NULL,
            status                 varchar(20) NOT NULL CONSTRAINT DF_jje_message_analysis_status DEFAULT 'completed',
            error_message          nvarchar(2000) NULL,
            token_input            int NULL,
            token_output           int NULL,
            estimated_cost_usd     decimal(18,8) NULL,
            created_at             datetime2(3) NOT NULL CONSTRAINT DF_jje_message_analysis_created_at DEFAULT SYSUTCDATETIME(),
            updated_at             datetime2(3) NOT NULL CONSTRAINT DF_jje_message_analysis_updated_at DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_jje_message_analysis PRIMARY KEY CLUSTERED (message_analysis_id),
            CONSTRAINT UQ_jje_message_analysis_version UNIQUE (message_id, analysis_version),
            CONSTRAINT FK_jje_message_analysis_message FOREIGN KEY (message_id) REFERENCES jje.messages(message_id),
            CONSTRAINT CK_jje_message_analysis_class CHECK (classification IN ('lead','offering','ignored','reply','unknown')),
            CONSTRAINT CK_jje_message_analysis_confidence CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
            CONSTRAINT CK_jje_message_analysis_json CHECK (extracted_json IS NULL OR ISJSON(extracted_json) = 1)
        );

        CREATE TABLE jje.leads (
            lead_id                 bigint IDENTITY(1,1) NOT NULL,
            message_analysis_id     bigint NOT NULL,
            item_index              smallint NOT NULL CONSTRAINT DF_jje_leads_item_index DEFAULT 0,
            brand                   nvarchar(100) NULL,
            model                   nvarchar(160) NULL,
            variant                 nvarchar(160) NULL,
            ram_gb                  int NULL,
            storage_gb              int NULL,
            colors_json             nvarchar(max) NULL,
            quantity_min            int NULL,
            quantity_max            int NULL,
            target_price_min        decimal(19,4) NULL,
            target_price_max        decimal(19,4) NULL,
            condition               varchar(30) NULL,
            gst_included            bit NULL,
            dispatch_location       nvarchar(240) NULL,
            status                  varchar(30) NOT NULL CONSTRAINT DF_jje_leads_status DEFAULT 'open',
            created_at              datetime2(3) NOT NULL CONSTRAINT DF_jje_leads_created_at DEFAULT SYSUTCDATETIME(),
            updated_at              datetime2(3) NOT NULL CONSTRAINT DF_jje_leads_updated_at DEFAULT SYSUTCDATETIME(),
            row_version             rowversion NOT NULL,
            CONSTRAINT PK_jje_leads PRIMARY KEY CLUSTERED (lead_id),
            CONSTRAINT UQ_jje_leads_analysis_item UNIQUE (message_analysis_id, item_index),
            CONSTRAINT FK_jje_leads_analysis FOREIGN KEY (message_analysis_id) REFERENCES jje.message_analysis(message_analysis_id),
            CONSTRAINT CK_jje_leads_colors_json CHECK (colors_json IS NULL OR ISJSON(colors_json) = 1)
        );

        CREATE TABLE jje.offerings (
            offering_id             bigint IDENTITY(1,1) NOT NULL,
            message_analysis_id     bigint NOT NULL,
            item_index              smallint NOT NULL CONSTRAINT DF_jje_offerings_item_index DEFAULT 0,
            brand                   nvarchar(100) NULL,
            model                   nvarchar(160) NULL,
            variant                 nvarchar(160) NULL,
            ram_gb                  int NULL,
            storage_gb              int NULL,
            colors_json             nvarchar(max) NULL,
            quantity_min            int NULL,
            quantity_max            int NULL,
            price_min               decimal(19,4) NULL,
            price_max               decimal(19,4) NULL,
            condition               varchar(30) NULL,
            gst_included            bit NULL,
            dispatch_location       nvarchar(240) NULL,
            status                  varchar(30) NOT NULL CONSTRAINT DF_jje_offerings_status DEFAULT 'complete',
            pending_followup_count  int NOT NULL CONSTRAINT DF_jje_offerings_followups DEFAULT 0,
            price_requested_at      datetime2(3) NULL,
            price_request_message_id bigint NULL,
            price_source_message_id bigint NULL,
            created_at              datetime2(3) NOT NULL CONSTRAINT DF_jje_offerings_created_at DEFAULT SYSUTCDATETIME(),
            updated_at              datetime2(3) NOT NULL CONSTRAINT DF_jje_offerings_updated_at DEFAULT SYSUTCDATETIME(),
            row_version             rowversion NOT NULL,
            CONSTRAINT PK_jje_offerings PRIMARY KEY CLUSTERED (offering_id),
            CONSTRAINT UQ_jje_offerings_analysis_item UNIQUE (message_analysis_id, item_index),
            CONSTRAINT FK_jje_offerings_analysis FOREIGN KEY (message_analysis_id) REFERENCES jje.message_analysis(message_analysis_id),
            CONSTRAINT FK_jje_offerings_price_request FOREIGN KEY (price_request_message_id) REFERENCES jje.messages(message_id),
            CONSTRAINT FK_jje_offerings_price_source FOREIGN KEY (price_source_message_id) REFERENCES jje.messages(message_id),
            CONSTRAINT CK_jje_offerings_colors_json CHECK (colors_json IS NULL OR ISJSON(colors_json) = 1),
            CONSTRAINT CK_jje_offerings_followups CHECK (pending_followup_count >= 0)
        );

        CREATE TABLE jje.outbox_events (
            outbox_event_id         bigint IDENTITY(1,1) NOT NULL,
            event_type              varchar(100) NOT NULL,
            aggregate_type          varchar(60) NOT NULL,
            aggregate_id            bigint NOT NULL,
            payload_json            nvarchar(max) NOT NULL,
            published_at            datetime2(3) NULL,
            attempt_count           int NOT NULL CONSTRAINT DF_jje_outbox_attempts DEFAULT 0,
            next_attempt_at         datetime2(3) NULL,
            last_error              nvarchar(2000) NULL,
            created_at              datetime2(3) NOT NULL CONSTRAINT DF_jje_outbox_created_at DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_jje_outbox_events PRIMARY KEY CLUSTERED (outbox_event_id),
            CONSTRAINT CK_jje_outbox_payload CHECK (ISJSON(payload_json) = 1)
        );
        CREATE INDEX IX_jje_outbox_unpublished ON jje.outbox_events(published_at, next_attempt_at, outbox_event_id) INCLUDE (event_type, aggregate_type, aggregate_id);

        CREATE TABLE jje.system_settings (
            setting_key             varchar(150) NOT NULL,
            setting_value           nvarchar(max) NOT NULL,
            is_secret               bit NOT NULL CONSTRAINT DF_jje_system_settings_secret DEFAULT 0,
            description             nvarchar(500) NULL,
            updated_by_user_id      bigint NULL,
            updated_at              datetime2(3) NOT NULL CONSTRAINT DF_jje_system_settings_updated_at DEFAULT SYSUTCDATETIME(),
            row_version             rowversion NOT NULL,
            CONSTRAINT PK_jje_system_settings PRIMARY KEY CLUSTERED (setting_key),
            CONSTRAINT FK_jje_system_settings_user FOREIGN KEY (updated_by_user_id) REFERENCES jje.users(user_id)
        );

        CREATE TABLE jje.audit_logs (
            audit_log_id            bigint IDENTITY(1,1) NOT NULL,
            user_id                 bigint NULL,
            device_id               bigint NULL,
            action                  varchar(100) NOT NULL,
            entity_type             varchar(80) NULL,
            entity_id               bigint NULL,
            correlation_id          uniqueidentifier NULL,
            ip_address              varchar(64) NULL,
            metadata_json           nvarchar(max) NULL,
            created_at              datetime2(3) NOT NULL CONSTRAINT DF_jje_audit_logs_created_at DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_jje_audit_logs PRIMARY KEY CLUSTERED (audit_log_id),
            CONSTRAINT FK_jje_audit_logs_user FOREIGN KEY (user_id) REFERENCES jje.users(user_id),
            CONSTRAINT FK_jje_audit_logs_device FOREIGN KEY (device_id) REFERENCES jje.devices(device_id),
            CONSTRAINT CK_jje_audit_logs_json CHECK (metadata_json IS NULL OR ISJSON(metadata_json) = 1)
        );
        CREATE INDEX IX_jje_audit_logs_entity ON jje.audit_logs(entity_type, entity_id, created_at DESC);

        INSERT jje.schema_migrations(migration_id) VALUES ('001_initial_schema');
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
