# JJE WhatsApp

Production-oriented WhatsApp Cloud API inbox and broadcast application for Jay Jalaram Enterprise.
It is a modular monolith with two Node.js processes and one React frontend:

- **API process** — authenticated HTTP/socket API, Meta webhook receiver, SQL outbox relay.
- **Worker process** — durable campaign dispatch and optional AI extraction jobs.
- **Frontend** — WhatsApp-style inbox, contacts, device administration, and broadcasts.

WhatsApp is fully standalone. AI extraction is an optional internal module, disabled by default,
and never runs in the webhook request path.

## Data ownership

The application owns only the `[jje]` schema in SQL Server database `Kore_Demo`.
It does not use Supabase and migrations do not alter `dbo` or unrelated schemas.

Apply and verify migrations from `backend`:

```powershell
node ..\database\scripts\apply-migrations.mjs
node ..\database\scripts\verify-schema.mjs
```

## Local development

Copy the example environment files to `.env`, populate secrets, install dependencies, then run:

```powershell
.\start-dev.ps1
```

Or start each process separately:

```powershell
cd backend
node src\server.js
node src\worker.js

cd ..\frontend
node node_modules\vite\bin\vite.js --host 0.0.0.0 --port 5176
```

## Production preparation

1. Copy `backend/.env.production.example` to `backend/.env` and supply server secrets.
2. Copy `frontend/.env.production.example` to `frontend/.env` before building.
3. Install backend/frontend dependencies on a machine with a trusted npm registry connection.
4. Apply and verify database migrations.
5. Bootstrap the first administrator:

```powershell
$env:JJE_ADMIN_EMAIL = 'admin@example.com'
$env:JJE_ADMIN_DISPLAY_NAME = 'JJE Administrator'
$env:JJE_ADMIN_PASSWORD = 'use-a-long-unique-password'
node backend\scripts\bootstrap-admin.mjs
Remove-Item Env:JJE_ADMIN_PASSWORD
```

6. Build and validate:

```powershell
node frontend\node_modules\typescript\bin\tsc -b --pretty false
node frontend\node_modules\vite\bin\vite.js build
node backend\test\security.test.js
node backend\test\database.integration.test.js
```

Device approval is controlled by `AUTH_DEVICE_APPROVAL_REQUIRED`. Set it to `false` to let
registered browsers use the application without admin approval, or `true` to enforce the
stored pending/approved/blocked device statuses. Restart the API service after changing it.

## Optional AI extraction

Keep `ai.extraction.enabled=false` for standalone WhatsApp. To enable later, configure
`OPENAI_API_KEY` and `OPENAI_MODEL` in the worker environment, then run from `backend`:

```powershell
$env:JJE_AI_ENABLED = 'true'
node scripts\configure-ai.mjs
Remove-Item Env:JJE_AI_ENABLED
```

The extractor uses the OpenAI Responses API with strict structured output and `store: false`.
Failures are retried by SQL jobs and cannot interrupt WhatsApp ingestion.
Price-only inbound replies are resolved deterministically against recent pending offerings before
an AI request is considered, avoiding unnecessary model calls and accidental duplicate offerings.

Historical messages are never queued automatically. Preview or deliberately queue a bounded backfill:

```powershell
node scripts\backfill-ai-jobs.mjs --limit=100
node scripts\backfill-ai-jobs.mjs --limit=100 --apply
```

The apply command refuses to run unless AI is enabled and both provider settings are present.

## Integrated LeadOps workspace

LeadOps is part of the same JJE CRM and uses the normalized `jje.messages`,
`jje.message_analysis`, `jje.leads`, and `jje.offerings` tables. The unified frontend provides
WhatsApp, Contacts, optional Lead Intelligence, and System workspaces. Lead Intelligence includes
operational KPIs, activity trends, a dense lead/offering/ignored inbox, market search, raw-message
versus structured-intelligence investigation, status workflows, and scored offering matches.

Contacts, System, and Lead Intelligence are lazy-loaded frontend bundles. The Lead Intelligence
navigation item is fetched from `/api/ai/status` and is not rendered when extraction is disabled;
WhatsApp has no runtime or bundle dependency on the AI worker.

There is intentionally no reply or auto-send action in LeadOps. WhatsApp remains usable when
AI is disabled, while the extraction worker can be enabled independently later. Future reply
automation should consume reviewed LeadOps records through a separate policy-controlled service;
it must not be embedded in message ingestion or the LeadOps read APIs.

After database connectivity is available, apply the LeadOps query indexes and validate its read models:

```powershell
node database\scripts\apply-migrations.mjs
node backend\test\leadops.database.integration.test.js
```

## One-time Supabase migration

Legacy snapshots are encrypted with `TOKEN_ENCRYPTION_KEY`, excluded from Git, and verified before import.
Keep that key unchanged until the import completes. From `backend`:

```powershell
node scripts\verify-supabase-snapshot.mjs "..\data\legacy-supabase-snapshot\2026-08-24\jjewa"
node scripts\import-supabase-snapshot.mjs "..\data\legacy-supabase-snapshot\2026-08-24\jjewa"
node scripts\import-supabase-snapshot.mjs "..\data\legacy-supabase-snapshot\2026-08-24\jjewa" --apply
```

The first import command is a read-only dry run. The applied import runs in one SQL transaction,
tracks source IDs in `jje.legacy_import_map`, and is safe to rerun without creating duplicates.
Legacy authentication/device rows stay archived in the encrypted snapshot and do not replace the new auth model.

## NSSM on the Windows server

The recommended deployment uses two services. From an elevated PowerShell window:

```powershell
$nssm = 'C:\nssm\win64\nssm.exe'
$node = (Get-Command node).Source
$backend = 'D:\kore-projects\JJE-Whstapp-API\JJEWhatsapp\backend'

& $nssm install JJEWhatsapp-API $node "$backend\src\server.js"
& $nssm set JJEWhatsapp-API AppDirectory $backend
& $nssm set JJEWhatsapp-API Start SERVICE_AUTO_START

& $nssm install JJEWhatsapp-Worker $node "$backend\src\worker.js"
& $nssm set JJEWhatsapp-Worker AppDirectory $backend
& $nssm set JJEWhatsapp-Worker Start SERVICE_AUTO_START
```

To discover an existing forgotten service name without changing anything:

```powershell
Get-CimInstance Win32_Service |
  Where-Object { $_.Name -match 'JJE|WhatsApp' -or $_.PathName -match 'JJEWhatsapp|JJE-Whstapp' } |
  Select-Object Name, DisplayName, State, PathName
```

Then start it with either command:

```powershell
Start-Service -Name '<service-name>'
# or
& 'C:\nssm\win64\nssm.exe' start '<service-name>'
```

Do not install a second service until the discovery command confirms the old names and paths.
