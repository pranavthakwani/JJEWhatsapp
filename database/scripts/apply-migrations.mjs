import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const sql = require('mssql');
require('dotenv').config({ path: fileURLToPath(new URL('../../backend/.env', import.meta.url)) });

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);
const migrationsDirectory = path.resolve(currentDirectory, '..', 'migrations');
const expectedDatabase = 'Kore_Demo';

function requiredEnvironmentValue(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function parsePort(value) {
  const port = Number(value || 1433);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DB_PORT must be a valid TCP port.');
  }
  return port;
}

const database = requiredEnvironmentValue('DB_DATABASE');
if (database.toLowerCase() !== expectedDatabase.toLowerCase()) {
  throw new Error(`Refusing migration: DB_DATABASE must be exactly ${expectedDatabase}.`);
}

const config = {
  server: requiredEnvironmentValue('DB_SERVER'),
  database,
  user: requiredEnvironmentValue('DB_USER'),
  password: requiredEnvironmentValue('DB_PASSWORD'),
  port: parsePort(process.env.DB_PORT),
  options: {
    encrypt: String(process.env.DB_ENCRYPT || 'false').toLowerCase() === 'true',
    trustServerCertificate: String(process.env.DB_TRUST_SERVER_CERTIFICATE || 'true').toLowerCase() === 'true',
    enableArithAbort: true,
  },
  pool: { min: 0, max: 2, idleTimeoutMillis: 10_000 },
  connectionTimeout: 15_000,
  requestTimeout: 120_000,
};

const migrationFiles = (await fs.readdir(migrationsDirectory))
  .filter((fileName) => /^\d+_.+\.sql$/i.test(fileName))
  .sort((left, right) => left.localeCompare(right));

if (migrationFiles.length === 0) {
  throw new Error(`No migrations found in ${migrationsDirectory}.`);
}

let pool;
try {
  pool = await sql.connect(config);
  const identity = await pool.request().query('SELECT DB_NAME() AS database_name;');
  const connectedDatabase = identity.recordset[0]?.database_name;
  if (String(connectedDatabase).toLowerCase() !== expectedDatabase.toLowerCase()) {
    throw new Error(`Connected to unexpected database: ${connectedDatabase || 'unknown'}.`);
  }

  for (const fileName of migrationFiles) {
    const migrationSql = await fs.readFile(path.join(migrationsDirectory, fileName), 'utf8');
    if (/\bUSE\s+\[/i.test(migrationSql) || /\bdbo\s*\./i.test(migrationSql)) {
      throw new Error(`Migration ${fileName} attempts to use a database or dbo object.`);
    }

    process.stdout.write(`Applying ${fileName}... `);
    await pool.request().batch(migrationSql);
    process.stdout.write('done\n');
  }

  const summary = await pool.request().query(`
    SELECT migration_id, applied_at
    FROM jje.schema_migrations
    ORDER BY migration_id;
  `);
  console.table(summary.recordset);
} finally {
  if (pool) await pool.close();
}
