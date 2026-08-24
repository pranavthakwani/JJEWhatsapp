import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const sql = require('mssql');
require('dotenv').config({ path: fileURLToPath(new URL('../../backend/.env', import.meta.url)) });

const expectedDatabase = 'Kore_Demo';
const database = String(process.env.DB_DATABASE || '').trim();
if (database.toLowerCase() !== expectedDatabase.toLowerCase()) {
  throw new Error(`DB_DATABASE must be exactly ${expectedDatabase}.`);
}

const pool = await sql.connect({
  server: String(process.env.DB_SERVER || '').trim(),
  database,
  user: String(process.env.DB_USER || '').trim(),
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT || 1433),
  options: {
    encrypt: String(process.env.DB_ENCRYPT || 'false').toLowerCase() === 'true',
    trustServerCertificate: String(process.env.DB_TRUST_SERVER_CERTIFICATE || 'true').toLowerCase() === 'true',
  },
});

try {
  const result = await pool.request().query(`
    SELECT
      DB_NAME() AS database_name,
      (SELECT COUNT(*) FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = 'jje') AS table_count,
      (SELECT COUNT(*) FROM sys.procedures p JOIN sys.schemas s ON s.schema_id = p.schema_id WHERE s.name = 'jje') AS procedure_count,
      (SELECT COUNT(*) FROM jje.schema_migrations) AS migration_count,
      (SELECT setting_value FROM jje.system_settings WHERE setting_key = 'ai.extraction.enabled') AS ai_enabled;
  `);
  console.table(result.recordset);
} finally {
  await pool.close();
}
