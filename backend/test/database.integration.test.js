import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { closePool, getPool, sql } from '../src/config/db.js';

test('inbound storage is atomic, idempotent, and leaves AI disabled', async (context) => {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  context.after(async () => {
    if (transaction._aborted !== true) {
      try { await transaction.rollback(); } catch { /* already rolled back */ }
    }
    await closePool();
  });

  const numberResult = await new sql.Request(transaction).query(`
    SELECT TOP (1) meta_phone_number_id FROM jje.phone_numbers WHERE status = 'active' ORDER BY is_default DESC, phone_number_id;`);
  assert.ok(numberResult.recordset[0]?.meta_phone_number_id, 'An active WhatsApp number must be provisioned.');

  const providerMessageId = `integration-${crypto.randomUUID()}`;
  const waId = `999${Date.now()}`.slice(0, 15);
  async function executeInbound() {
    return new sql.Request(transaction)
      .input('MetaPhoneNumberId', sql.VarChar(100), numberResult.recordset[0].meta_phone_number_id)
      .input('ContactWaId', sql.VarChar(64), waId)
      .input('ContactPhoneNumber', sql.VarChar(32), waId)
      .input('ProfileName', sql.NVarChar(240), 'Integration Test')
      .input('ProviderMessageId', sql.VarChar(255), providerMessageId)
      .input('MessageType', sql.VarChar(30), 'text')
      .input('TextBody', sql.NVarChar(sql.MAX), 'test message')
      .input('ProviderTimestamp', sql.DateTime2(3), new Date())
      .execute('jje.usp_InboundMessage_Store');
  }

  const first = await executeInbound();
  const second = await executeInbound();
  assert.equal(Boolean(first.recordset[0].was_inserted), true);
  assert.equal(Boolean(second.recordset[0].was_inserted), false);
  assert.equal(Number(first.recordset[0].message_id), Number(second.recordset[0].message_id));

  const state = await new sql.Request(transaction)
    .input('messageId', sql.BigInt, first.recordset[0].message_id)
    .query(`SELECT message.status, conversation.unread_count,
      (SELECT COUNT(*) FROM jje.background_jobs WHERE aggregate_type = 'message' AND aggregate_id = message.message_id) AS ai_jobs
      FROM jje.messages message INNER JOIN jje.conversations conversation ON conversation.conversation_id = message.conversation_id
      WHERE message.message_id = @messageId;`);
  assert.equal(state.recordset[0].status, 'received');
  assert.equal(state.recordset[0].unread_count, 1);
  assert.equal(state.recordset[0].ai_jobs, 0);

  await transaction.rollback();
});
