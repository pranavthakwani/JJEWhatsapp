# JJEWA

JJEWA is a separate WhatsApp Cloud API chat application built for Jay Jalaram Enterprise.

Scope:

- single-admin operation
- WhatsApp-web style inbox
- Cloud API webhook ingestion
- fast conversation list and message pagination
- broadcast-style campaigns that send one message to many recipients as individual 1:1 chats
- no approval workflow
- no LeadOps AI extraction dependency

Folder layout:

- [backend](C:/Users/prana/OneDrive/Desktop/LeadOps/JJEWA/backend)
- [frontend](C:/Users/prana/OneDrive/Desktop/LeadOps/JJEWA/frontend)

The database model intentionally stays close to the existing `rushitWA` system:

- `wa_business_accounts`
- `wa_phone_numbers`
- `wa_contacts`
- `wa_messages`

Additional tables are added for performance and product fit:

- `wa_conversations`
- `wa_templates`
- `wa_campaigns`
- `wa_campaign_recipients`

Start here:

1. Apply [schema.sql](C:/Users/prana/OneDrive/Desktop/LeadOps/JJEWA/backend/sql/schema.sql) in Supabase SQL Editor.
2. Copy [backend/.env.example](C:/Users/prana/OneDrive/Desktop/LeadOps/JJEWA/backend/.env.example) to `backend/.env`.
3. Configure Meta webhook callback URL as:
   `https://YOUR-PUBLIC-URL/api/webhooks/meta`
4. Use the verify token stored in `wa_phone_numbers.verify_token`.
5. Start the backend.
6. Start the frontend.
