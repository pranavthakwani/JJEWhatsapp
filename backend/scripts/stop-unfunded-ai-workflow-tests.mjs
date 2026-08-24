import { closePool } from '../src/config/db.js';
import { query } from '../src/repositories/sqlHelpers.js';

try {
  const result = await query(`
    UPDATE job SET status='failed',locked_at=NULL,locked_by=NULL,updated_at=SYSUTCDATETIME()
    OUTPUT inserted.job_id
    FROM jje.background_jobs job
    INNER JOIN jje.messages message ON message.message_id=job.aggregate_id AND job.aggregate_type='message'
    WHERE message.provider_message_id LIKE 'workflow-test-%' AND job.job_type='analyze_message'
      AND job.status='queued' AND (job.last_error LIKE '%credit_balance_exhausted%' OR job.last_error LIKE '%no credits remaining%');`);
  console.log(JSON.stringify({ ok: true, stopped: result.recordset.length }));
} finally {
  await closePool();
}
