import assert from 'node:assert/strict';
import test from 'node:test';
import { closePool, getPool } from '../src/config/db.js';
import { resolvePendingOfferingPrices } from '../src/repositories/analysisRepository.js';

test('price resolver safely ignores a conversation with no pending offering', async (context) => {
  const pool = await getPool();
  const candidate = await pool.request().query('SELECT TOP (1) message_id FROM jje.messages ORDER BY message_id;');
  const messageId = candidate.recordset[0]?.message_id;
  if (!messageId) {
    context.skip('No messages exist for the SQL integration test.');
    return;
  }

  const result = await resolvePendingOfferingPrices({
    messageId: Number(messageId),
    conversationId: -1,
    parentProviderMessageId: null,
    prices: [12_345],
  });
  assert.deepEqual(result, { pendingCount: 0, priceCount: 1, updatedCount: 0 });
});

test.after(async () => {
  await closePool();
});
