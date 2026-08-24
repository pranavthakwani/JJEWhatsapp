import sql from 'mssql';
import { env } from '../src/config/env.js';

const apply = process.argv.includes('--apply');
const rawLimit = process.argv.find((value) => value.startsWith('--limit='))?.split('=')[1];
const limit = Number(rawLimit || 100);
if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error('--limit must be between 1 and 10000.');
if (String(env.database.database).toLowerCase() !== 'kore_demo') throw new Error('Refusing backfill outside Kore_Demo.');

const pool = await new sql.ConnectionPool({
  server: env.database.server, database: env.database.database, user: env.database.user, password: env.database.password,
  port: env.database.port, options: { encrypt: env.database.encrypt, trustServerCertificate: env.database.trustServerCertificate, enableArithAbort: true },
  pool: { min: 0, max: 1, idleTimeoutMillis: 10_000 }, connectionTimeout: env.database.connectionTimeoutMs, requestTimeout: 120_000,
}).connect();

try {
  const status = await pool.request().query(`
    SELECT
      CASE WHEN EXISTS(SELECT 1 FROM jje.system_settings WHERE setting_key='ai.extraction.enabled' AND LOWER(setting_value)='true') THEN 1 ELSE 0 END enabled,
      COUNT_BIG(*) eligible
    FROM jje.messages message
    WHERE message.deleted_at IS NULL AND COALESCE(NULLIF(message.text_body,''),NULLIF(message.caption,'')) IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM jje.message_analysis analysis WHERE analysis.message_id=message.message_id AND analysis.analysis_version=1)
      AND NOT EXISTS(SELECT 1 FROM jje.background_jobs job WHERE job.deduplication_key=CONCAT('ai:message:',message.message_id,':v1'));
  `);
  const { enabled, eligible } = status.recordset[0];
  if (!apply) {
    console.log(`AI_BACKFILL_DRY_RUN eligible=${eligible} requestedLimit=${limit} aiEnabled=${Boolean(enabled)}`);
    process.exit(0);
  }
  if (!enabled) throw new Error('AI extraction must be enabled before historical jobs can be queued.');
  if (!env.ai.apiKey || !env.ai.model) throw new Error('OPENAI_API_KEY and OPENAI_MODEL are required before historical jobs can be queued.');

  const result = await pool.request().input('limit', sql.Int, limit).query(`
    INSERT jje.background_jobs(job_type,aggregate_type,aggregate_id,deduplication_key,payload_json)
    SELECT TOP (@limit) 'analyze_message','message',message.message_id,CONCAT('ai:message:',message.message_id,':v1'),
      (SELECT message.message_id messageId FOR JSON PATH,WITHOUT_ARRAY_WRAPPER)
    FROM jje.messages message WITH (UPDLOCK,READPAST)
    WHERE message.deleted_at IS NULL AND COALESCE(NULLIF(message.text_body,''),NULLIF(message.caption,'')) IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM jje.message_analysis analysis WHERE analysis.message_id=message.message_id AND analysis.analysis_version=1)
      AND NOT EXISTS(SELECT 1 FROM jje.background_jobs job WHERE job.deduplication_key=CONCAT('ai:message:',message.message_id,':v1'))
    ORDER BY message.created_at,message.message_id;
    SELECT @@ROWCOUNT queued;
  `);
  console.log(`AI_BACKFILL_QUEUED jobs=${result.recordset[0].queued}`);
} finally {
  await pool.close();
}
