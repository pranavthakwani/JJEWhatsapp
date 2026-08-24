import { env } from '../src/config/env.js';
import { closePool } from '../src/config/db.js';
import { input, query, sql } from '../src/repositories/sqlHelpers.js';

const requested = String(process.env.JJE_AI_ENABLED || '').toLowerCase();
if (!['true', 'false'].includes(requested)) throw new Error('Set JJE_AI_ENABLED to true or false.');
if (requested === 'true' && (!env.ai.apiKey || !env.ai.model)) {
  throw new Error('Set OPENAI_API_KEY and OPENAI_MODEL before enabling AI extraction.');
}

try {
  await query(`UPDATE jje.system_settings SET setting_value = @enabled, updated_at = SYSUTCDATETIME()
    WHERE setting_key = 'ai.extraction.enabled';
    IF @@ROWCOUNT = 0 INSERT jje.system_settings(setting_key, setting_value, is_secret, description)
      VALUES('ai.extraction.enabled', @enabled, 0, 'Optional AI lead/offering extraction. WhatsApp remains functional when disabled.');`, [
    input('enabled', sql.NVarChar(sql.MAX), requested),
  ]);
  console.log(JSON.stringify({ ok: true, enabled: requested === 'true', configured: Boolean(env.ai.apiKey && env.ai.model), model: env.ai.model || null }));
} finally {
  await closePool();
}
