import { closePool } from '../src/config/db.js';
import { query } from '../src/repositories/sqlHelpers.js';

try {
  const result = await query(`
    SELECT TOP (5) message.provider_message_id test_id,message.message_id,message.created_at,
      job.job_id,job.status job_status,job.attempt_count,job.max_attempts,job.available_at,job.locked_at,job.locked_by,job.last_error,
      analysis.status analysis_status,analysis.classification,analysis.model_name,analysis.error_message
    FROM jje.messages message
    LEFT JOIN jje.background_jobs job ON job.aggregate_type='message' AND job.aggregate_id=message.message_id AND job.job_type='analyze_message'
    LEFT JOIN jje.message_analysis analysis ON analysis.message_id=message.message_id AND analysis.analysis_version=1
    WHERE message.provider_message_id LIKE 'workflow-test-%'
    ORDER BY message.message_id DESC;`);
  console.log(JSON.stringify(result.recordset, null, 2));
} finally {
  await closePool();
}
