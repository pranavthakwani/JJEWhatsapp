import { clampInteger, input, query, sql } from './sqlHelpers.js';

export async function listPendingOutboxEvents(limit = 50) {
  const result = await query(`
    SELECT TOP (@limit) outbox_event_id, event_type, aggregate_type, aggregate_id,
      payload_json, attempt_count, created_at
    FROM jje.outbox_events WITH (READPAST)
    WHERE published_at IS NULL
      AND (next_attempt_at IS NULL OR next_attempt_at <= SYSUTCDATETIME())
    ORDER BY outbox_event_id;`, [
    input('limit', sql.Int, clampInteger(limit, 50, 1, 200)),
  ]);
  return result.recordset.map((row) => ({
    id: Number(row.outbox_event_id),
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: Number(row.aggregate_id),
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
  }));
}

export async function markOutboxPublished(eventId) {
  await query(`
    UPDATE jje.outbox_events SET published_at = SYSUTCDATETIME(), attempt_count = attempt_count + 1,
      last_error = NULL WHERE outbox_event_id = @eventId AND published_at IS NULL;`, [
    input('eventId', sql.BigInt, eventId),
  ]);
}

export async function markOutboxFailed(eventId, error) {
  await query(`
    UPDATE jje.outbox_events SET attempt_count = attempt_count + 1,
      next_attempt_at = DATEADD(second, CASE WHEN attempt_count > 5 THEN 300 ELSE POWER(2, attempt_count) END, SYSUTCDATETIME()),
      last_error = @error WHERE outbox_event_id = @eventId AND published_at IS NULL;`, [
    input('eventId', sql.BigInt, eventId),
    input('error', sql.NVarChar(2000), String(error?.message || error || 'Unknown event error').slice(0, 2000)),
  ]);
}
