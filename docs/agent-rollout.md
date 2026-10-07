# JJE Agent implementation and safe rollout

## What is implemented

Two LangGraph workflows run inside the existing Node worker: conversation intake and interrupted action review/dispatch. SQL Server is the only durable storage. Migration `010_agent_workflow.sql` creates `jje` cases, field evidence, reviews, actions, runs, queue leases, checkpoints/pending writes and dispatch attempts. The API server publishes their outbox events to authenticated operator/admin sockets. Processing and sending default **off** independently of legacy extraction.

The shared **Agent review** tab lives in Lead operations. It shows proposals, source evidence, conflicting facts, corrections, matches, pause/takeover controls and send outcome states. Customer chat displays a pending-proposal indicator. By explicit owner choice, `AGENT_SHARED_ADMIN_ACCESS=true` grants admin-level agent access to every browser that passes the existing app-access checks. There are no account sign-ins: claims and approvals are attributed to browser device IDs, not named people. Restrict this deployment to your trusted network/VPN; anyone who can access the app can approve actions and change pilot policy. Set this flag to false to reinstate operator/admin account authorization.

Incoming messages are stored immediately. A SQL hook groups AI processing after three quiet seconds, capped at fifteen seconds. Jobs lease conversations for 120 seconds and renew every 30 seconds. Up to five failed attempts are retained for inspection. Intake checkpoints and replay-safe case/action writes survive restart. An approval wait has its own thread and never blocks conversation intake.

Case updates keep stable business record IDs. Human/approved fields are protected; contrary commercial facts become conflict evidence. Quoted provider-message IDs are resolved before product references, followed by single-case context; unclear links become internal review tasks. Matching is account-scoped and excludes explicit incompatible model, brand, variant, memory, condition, colors, quantity or budget. Unknown price/quantity and unverified/stale availability remain visibly provisional. Supplier costs are never treated as selling prices.

Every customer send rechecks exact approved content/version, recipient, opt-out, case control, context and approval age. Approvals expire at 30 minutes. At most two unanswered clarification/verification sends per case are allowed with a 24-hour minimum cooldown. A unique durable dispatch attempt prevents blind retries. Meta acceptance is separate from sent/delivered/read. Timeout/crash with uncertain acceptance becomes **unknown**, not delivered.

If the text window closes, the old text becomes blocked. For an opted-in contact the configured fixed, approved follow-up template can become a **separate** proposal requiring approval. Only text-only, parameter-free templates are supported initially. The original draft is never inserted into template parameters. Missing/changed/unapproved templates stay blocked. Template status and exact body are fetched again immediately before sending.

## Deployment

1. Preserve existing `.env`, install backend dependencies with the checked-in `pnpm-lock.yaml` (`pnpm install --frozen-lockfile`), and install/build the frontend normally.
2. From backend run `npm run db:migrate`, then `npm run check`, `npm run test:agent`, `npm run test:agent:db`, `npm run test:agent:state`, `npm run test:agent:api`; from frontend run `npm run build`.
3. Under the existing `# Toggles` heading set:

   ```dotenv
   AI_EXTRACTION_ENABLED=true
   AGENT_PROCESSING_ENABLED=false
   AGENT_SENDING_ENABLED=false
   ```

   Extraction can also be disabled independently. Outside the agent allowlist, existing extraction remains in control. Inside the allowlist, the conversation agent owns extraction when agent processing is enabled.
4. Start API (`npm start`) and a **separate worker** (`npm run worker`). Restart both after environment changes. Server/worker synchronize the processing toggle to the SQL message hook. Running only the web server does not run agent jobs.
5. In Agent review, an administrator chooses a bounded conversation-ID allowlist, shadow mode and daily budget. Empty allowlist means no agent processing. This is new-message processing, not automatic historical backfill.
6. After technical/evaluation acceptance, enable processing only and restart API/worker. Review shadow proposals against staff labels. The cost-bounded initial model is `gpt-4o-mini` or its `2024-07-18` snapshot through the existing OpenAI key/model settings. Other models deliberately require a revised cost allowance before use. Migration 011 adds browser-device audit/claim keys without creating fake user accounts.
7. After the pilot gates below, set policy to review; separately enable sending and restart. Approve a small number of proposals. Ordinary WhatsApp chat must remain usable if agent processing fails.

Each model attempt reserves $0.25 before the request; retries also reserve, with a five-attempt ceiling, text-only prompt <=100 KB and output <=6,000 tokens. Reservations conservatively overcount costs, including failed requests; they are not OpenAI invoices. Recheck model pricing before upgrades. An exhausted budget fails/pauses AI work without disabling chat. Health shows queue failures, run errors, reservations and unresolved sends. Shadow/review policies are administrator-controlled; runtime master switches remain environment-controlled.

## Review workflow

Claim a pending proposal, inspect evidence/recipient and edit if necessary. Save the edit before approving its new version. Competing claims or stale versions return 409. Rejecting a proposal suppresses equivalent wording until relevant facts change. Case corrections supersede old approvals. Pause/take over prevents unsolicited drafts; resume/correct refreshes qualification and matches without another model call. Staff can explicitly regenerate when needed through `POST /api/agent/cases/:id/regenerate` with the current version. Internal match/review/handover tasks cannot be approved as customer messages.

For **unknown** sends, inspect the recorded provider ID, local `agent:<actionId>` request ID and webhook/provider evidence. Do not send again merely because no local bubble appeared. Reconciliation never retries the customer message. Staff can mark the task reviewed after investigation; this does not change provider delivery evidence.

Ambiguous replies can be linked to a staff-selected case in the same conversation/type, with both case versions checked. Contradictory fields must be corrected before linking. Evidence moves to the target; the original case and review links remain as closed history. Legacy LeadOps status edits also update case state and supersede approvals, preventing sold/archived records from being reused.

Explicit historical selection is available to administrators only: `POST /api/agent/backfill` with `{"records":[{"kind":"offering","recordId":123}]}` (1–100 IDs). This imports existing stable IDs as unverified evidence; it makes **no model calls, proposals or sends**. Never select a whole history implicitly. Previous extraction snapshots are retained in `jje.analysis_revisions` when a message is reanalyzed.

## Acceptance and evaluation

The automated tests exercise normalization, missing facts, protected fields, matching exclusions/staleness, quoted linking, approval expiry, opt-out/window checks, roles, fixed-template eligibility, graph interruption, durable SQL restart, stable projections, competing approvals, and stale-draft invalidation. SQL integration fixtures are uniquely named, use locked non-login test users, perform no provider calls and clean up their own rows.

Live multilingual accuracy, provider delivery/failure behavior and staff-time savings are **not established by these tests**. No representative, anonymized held-out trader corpus or timed staff baseline is bundled. Obtain at least 150 staff-labelled held-out cases across en/hi/gu/hi-Latn/gu-Latn, run in shadow, and export staff-reviewed predictions. Do not substitute generated examples for real evaluation data.

Run `node backend/scripts/evaluate-agent.mjs <heldout.json>`. Each JSON-array sample has:

```json
{
  "id": "heldout-case-001", "heldOut": true, "reviewedBy": "staff-id",
  "language": "en",
  "expected": {"intent": "offering", "caseId": "supplier-A16", "fields": {"model": "A16", "quantityMin": 20}},
  "actual": {"intent": "offering", "caseId": "supplier-A16", "fields": {"model": "A16", "quantityMin": 20}},
  "unsupportedCommitments": 0, "duplicateSends": 0,
  "baselineSeconds": 90, "staffSeconds": 60
}
```

Pilot gate: >=95% intent/link accuracy, >=95% populated-field precision, zero unsupported commitments and duplicate sends. Expansion additionally requires >=30% measured staff-time reduction. Commitment/duplicate-send counts require staff grading and failure/restart tests, not a model judging itself. Record approval/edit/rejection counts and review reasons, correction reasons, qualification latency, useful matches, unanswered sends, worker failures and cost per qualified case.

Remaining operational work: collect the held-out corpus and timings, run selected-conversation shadow tests, then perform staged Meta integration/failure testing before enabling real sending. Historical backfill must explicitly select bounded record IDs; it creates internal cases and evidence only, never outbound proposals. Voice/OCR, ERP, autonomous negotiation, orders and payments remain out of scope.

References: [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts), [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
