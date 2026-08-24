# JJE WhatsApp SQL Server database

The combined application owns only the `[jje]` schema inside `Kore_Demo`.
It must not create, alter, or delete objects in `dbo` or any other schema.

Apply migrations in numeric order using a deployment login that can create
objects in `Kore_Demo`:

1. `migrations/001_initial_schema.sql`
2. `migrations/002_worker_procedures.sql`
3. `migrations/003_seed_configuration.sql`
4. `migrations/004_campaign_status_and_message_status.sql`
5. `migrations/005_legacy_import_tracking.sql`

All migrations are idempotent. Database permissions for the application login
are intentionally managed separately by the server administrator; migrations
do not grant access or modify unrelated principals.

AI extraction is optional and defaults to disabled through the
`ai.extraction.enabled` setting. WhatsApp inbox, contacts, templates, and
campaigns do not depend on AI tables or workers.
