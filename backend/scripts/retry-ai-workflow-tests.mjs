import { closePool } from '../src/config/db.js';
import { query } from '../src/repositories/sqlHelpers.js';

try {
  const result = await query(`
    ;WITH target AS (
      SELECT TOP (1) job.*
      FROM jje.background_jobs job
      INNER JOIN jje.messages message ON message.message_id=job.aggregate_id AND job.aggregate_type='message'
      LEFT JOIN jje.message_analysis analysis ON analysis.message_id=message.message_id AND analysis.analysis_version=1
      WHERE message.provider_message_id LIKE 'workflow-test-%' AND analysis.message_analysis_id IS NULL
        AND job.job_type='analyze_message' AND job.status IN ('queued','failed')
      ORDER BY message.message_id DESC
    )
    UPDATE target SET status='queued',attempt_count=0,available_at=SYSUTCDATETIME(),locked_at=NULL,locked_by=NULL,last_error=NULL,updated_at=SYSUTCDATETIME()
    OUTPUT inserted.job_id
    ;`);
  console.log(JSON.stringify({ ok: true, requeued: result.recordset.length }));
} finally {
  await closePool();
}
