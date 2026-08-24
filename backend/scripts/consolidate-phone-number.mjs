import sql from 'mssql';
import { env } from '../src/config/env.js';

const sourceId = Number(process.argv[2]);
const targetId = Number(process.argv[3]);
if (!Number.isInteger(sourceId) || !Number.isInteger(targetId) || sourceId === targetId) {
  throw new Error('Usage: node scripts/consolidate-phone-number.mjs <legacy-source-id> <active-target-id>');
}
if (String(env.database.database).toLowerCase() !== 'kore_demo') throw new Error('Refusing consolidation outside Kore_Demo.');

const pool = await new sql.ConnectionPool({
  server: env.database.server, database: env.database.database, user: env.database.user, password: env.database.password,
  port: env.database.port, options: { encrypt: env.database.encrypt, trustServerCertificate: env.database.trustServerCertificate, enableArithAbort: true },
  pool: { min: 0, max: 1, idleTimeoutMillis: 10_000 }, connectionTimeout: env.database.connectionTimeoutMs, requestTimeout: 120_000,
}).connect();

const transaction = new sql.Transaction(pool);
await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
try {
  const request = new sql.Request(transaction)
    .input('sourceId', sql.BigInt, sourceId)
    .input('targetId', sql.BigInt, targetId);
  const result = await request.query(`
    SET XACT_ABORT ON;
    DECLARE @sourcePhone varchar(32), @targetPhone varchar(32), @targetStatus varchar(20), @targetDefault bit;
    SELECT @sourcePhone=phone_number FROM jje.phone_numbers WITH (UPDLOCK,HOLDLOCK) WHERE phone_number_id=@sourceId;
    SELECT @targetPhone=phone_number,@targetStatus=status,@targetDefault=is_default FROM jje.phone_numbers WITH (UPDLOCK,HOLDLOCK) WHERE phone_number_id=@targetId;
    IF @sourcePhone IS NULL OR @targetPhone IS NULL THROW 51030, 'Source or target phone number was not found.', 1;
    IF REPLACE(REPLACE(@sourcePhone,'+',''),' ','') <> REPLACE(REPLACE(@targetPhone,'+',''),' ','')
      THROW 51031, 'Source and target do not represent the same phone number.', 1;
    IF @targetStatus <> 'active' OR @targetDefault <> 1 THROW 51032, 'Target must be the active default phone number.', 1;
    IF EXISTS(SELECT 1 FROM jje.conversations WHERE phone_number_id=@targetId)
      OR EXISTS(SELECT 1 FROM jje.contact_lists WHERE phone_number_id=@targetId)
      OR EXISTS(SELECT 1 FROM jje.campaigns WHERE phone_number_id=@targetId)
      OR EXISTS(SELECT 1 FROM jje.messages WHERE phone_number_id=@targetId)
      THROW 51033, 'Target already owns operational data; automatic consolidation is unsafe.', 1;

    UPDATE jje.conversations SET phone_number_id=@targetId,updated_at=SYSUTCDATETIME() WHERE phone_number_id=@sourceId;
    DECLARE @conversations int=@@ROWCOUNT;
    UPDATE jje.contact_lists SET phone_number_id=@targetId,updated_at=SYSUTCDATETIME() WHERE phone_number_id=@sourceId;
    DECLARE @lists int=@@ROWCOUNT;
    UPDATE jje.campaigns SET phone_number_id=@targetId,updated_at=SYSUTCDATETIME() WHERE phone_number_id=@sourceId;
    DECLARE @campaigns int=@@ROWCOUNT;
    UPDATE jje.messages SET phone_number_id=@targetId,updated_at=SYSUTCDATETIME() WHERE phone_number_id=@sourceId;
    DECLARE @messages int=@@ROWCOUNT;
    UPDATE jje.templates SET phone_number_id=@targetId,updated_at=SYSUTCDATETIME() WHERE phone_number_id=@sourceId;
    DECLARE @templates int=@@ROWCOUNT;

    IF EXISTS(SELECT 1 FROM jje.chat_filter_settings WHERE phone_number_id=@sourceId)
    BEGIN
      IF EXISTS(SELECT 1 FROM jje.chat_filter_settings WHERE phone_number_id=@targetId)
      BEGIN
        UPDATE target SET favorite_keys_json=source.favorite_keys_json,custom_filters_json=source.custom_filters_json,updated_at=SYSUTCDATETIME()
        FROM jje.chat_filter_settings target CROSS JOIN jje.chat_filter_settings source
        WHERE target.phone_number_id=@targetId AND source.phone_number_id=@sourceId;
        DELETE jje.chat_filter_settings WHERE phone_number_id=@sourceId;
      END
      ELSE UPDATE jje.chat_filter_settings SET phone_number_id=@targetId,updated_at=SYSUTCDATETIME() WHERE phone_number_id=@sourceId;
    END

    UPDATE jje.legacy_import_map SET target_id=@targetId,updated_at=SYSUTCDATETIME()
      WHERE legacy_source='jjewa-supabase' AND source_table='wa_phone_numbers' AND target_id=@sourceId;
    UPDATE jje.phone_numbers SET status='inactive',is_default=0,updated_at=SYSUTCDATETIME() WHERE phone_number_id=@sourceId;

    SELECT @conversations conversations,@messages messages,@lists contact_lists,@campaigns campaigns,@templates templates;
  `);
  await transaction.commit();
  const row = result.recordset[0];
  console.log(`PHONE_NUMBER_CONSOLIDATED source=${sourceId} target=${targetId} conversations=${row.conversations} messages=${row.messages} contactLists=${row.contact_lists} campaigns=${row.campaigns} templates=${row.templates}`);
} catch (error) {
  await transaction.rollback().catch(() => {});
  throw error;
} finally {
  await pool.close();
}
