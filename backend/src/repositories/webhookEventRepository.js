import { input, query, sql } from './sqlHelpers.js';

export async function enqueueWebhookEvent(eventKey, payload) {
  const result = await query(`
    IF NOT EXISTS (SELECT 1 FROM jje.webhook_events WITH (UPDLOCK, HOLDLOCK) WHERE event_key = @eventKey)
      INSERT jje.webhook_events(event_key, payload_json) VALUES(@eventKey, @payloadJson);
    SELECT webhook_event_id, status FROM jje.webhook_events WHERE event_key = @eventKey;`, [
    input('eventKey', sql.VarChar(64), eventKey),
    input('payloadJson', sql.NVarChar(sql.MAX), JSON.stringify(payload)),
  ]);
  return result.recordset[0];
}

export async function claimNextWebhookEvent() {
  const result = await query(`
    UPDATE jje.webhook_events SET status = 'pending', locked_at = NULL, updated_at = SYSUTCDATETIME()
    WHERE status = 'processing' AND locked_at < DATEADD(minute, -5, SYSUTCDATETIME());

    ;WITH candidate AS (
      SELECT TOP (1) * FROM jje.webhook_events WITH (UPDLOCK, READPAST, ROWLOCK)
      WHERE status = 'pending' AND available_at <= SYSUTCDATETIME()
      ORDER BY webhook_event_id
    )
    UPDATE candidate SET status = 'processing', attempts = attempts + 1,
      locked_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
    OUTPUT inserted.webhook_event_id, inserted.payload_json, inserted.attempts;`);
  return result.recordset[0] || null;
}

export async function completeWebhookEvent(id) {
  await query(`UPDATE jje.webhook_events SET status='completed', completed_at=SYSUTCDATETIME(),
    locked_at=NULL, last_error=NULL, updated_at=SYSUTCDATETIME() WHERE webhook_event_id=@id;`, [
    input('id', sql.BigInt, id),
  ]);
}

export async function retryWebhookEvent(id, attempts, error) {
  const terminal = attempts >= 20;
  const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
  await query(`UPDATE jje.webhook_events SET status=@status, locked_at=NULL,
    available_at=DATEADD(second,@delaySeconds,SYSUTCDATETIME()), last_error=@error,
    updated_at=SYSUTCDATETIME() WHERE webhook_event_id=@id;`, [
    input('id', sql.BigInt, id),
    input('status', sql.VarChar(20), terminal ? 'failed' : 'pending'),
    input('delaySeconds', sql.Int, delaySeconds),
    input('error', sql.NVarChar(2000), String(error?.message || error).slice(0, 2000)),
  ]);
}
