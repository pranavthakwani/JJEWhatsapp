import { executeProcedure, input, query, sql } from './sqlHelpers.js';
import { env } from '../config/env.js';

export function isAiExtractionEnabled() {
  return env.features.aiExtraction;
}

export async function syncAiExtractionSetting() {
  const enabled = env.features.aiExtraction ? 'true' : 'false';
  await query(`
    UPDATE jje.system_settings
    SET setting_value = @enabled, updated_at = SYSUTCDATETIME()
    WHERE setting_key = 'ai.extraction.enabled';
    IF @@ROWCOUNT = 0
      INSERT jje.system_settings(setting_key, setting_value, is_secret, description)
      VALUES('ai.extraction.enabled', @enabled, 0, 'Controlled by AI_EXTRACTION_ENABLED in the backend environment.');`, [
    input('enabled', sql.NVarChar(sql.MAX), enabled),
  ]);
}

export async function claimBackgroundJobs({ workerId, jobType, batchSize = 5 }) {
  const result = await executeProcedure('jje.usp_BackgroundJob_ClaimBatch', [
    input('WorkerId', sql.VarChar(100), workerId),
    input('JobType', sql.VarChar(60), jobType || null),
    input('BatchSize', sql.Int, batchSize),
  ]);
  return result.recordset.map((row) => ({
    id: Number(row.job_id),
    type: row.job_type,
    aggregateId: row.aggregate_id == null ? null : Number(row.aggregate_id),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
  }));
}

export async function completeBackgroundJob(jobId) {
  await query(`UPDATE jje.background_jobs SET status = 'completed', completed_at = SYSUTCDATETIME(),
    locked_at = NULL, locked_by = NULL, last_error = NULL, updated_at = SYSUTCDATETIME()
    WHERE job_id = @jobId AND status = 'processing';`, [input('jobId', sql.BigInt, jobId)]);
}

export async function failBackgroundJob(job, error) {
  await query(`UPDATE jje.background_jobs SET
    status = CASE WHEN @terminal = 1 OR attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
    available_at = CASE WHEN @terminal = 1 OR attempt_count >= max_attempts THEN available_at
      ELSE DATEADD(second, POWER(2, CASE WHEN attempt_count > 8 THEN 8 ELSE attempt_count END) * 15, SYSUTCDATETIME()) END,
    locked_at = NULL, locked_by = NULL, last_error = @error, updated_at = SYSUTCDATETIME()
    WHERE job_id = @jobId AND status = 'processing';`, [
    input('jobId', sql.BigInt, job.id),
    input('terminal', sql.Bit, error?.retryable === false),
    input('error', sql.NVarChar(2000), String(error?.message || error || 'Unknown job error').slice(0, 2000)),
  ]);
}

export async function requeueExpiredJobLocks(timeoutMinutes = 10) {
  await executeProcedure('jje.usp_Job_RequeueExpiredLocks', [input('LockTimeoutMinutes', sql.Int, timeoutMinutes)]);
}
