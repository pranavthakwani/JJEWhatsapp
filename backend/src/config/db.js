import sql from 'mssql';
import { env } from './env.js';

let poolPromise = null;

function createPool() {
  return new sql.ConnectionPool({
    server: env.database.server,
    database: env.database.database,
    user: env.database.user,
    password: env.database.password,
    port: env.database.port,
    options: {
      encrypt: env.database.encrypt,
      trustServerCertificate: env.database.trustServerCertificate,
      enableArithAbort: true,
    },
    pool: {
      min: env.database.poolMin,
      max: env.database.poolMax,
      idleTimeoutMillis: 30_000,
    },
    connectionTimeout: env.database.connectionTimeoutMs,
    requestTimeout: env.database.requestTimeoutMs,
  });
}

export async function getPool() {
  if (!poolPromise) {
    const pool = createPool();
    pool.on('error', () => {
      poolPromise = null;
    });
    poolPromise = pool.connect().catch((error) => {
      poolPromise = null;
      throw error;
    });
  }

  return poolPromise;
}

export async function closePool() {
  if (!poolPromise) return;
  const pool = await poolPromise;
  poolPromise = null;
  await pool.close();
}

export async function checkDatabase() {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT DB_NAME() AS database_name,
           CASE WHEN OBJECT_ID(N'jje.schema_migrations', N'U') IS NULL THEN 0 ELSE 1 END AS schema_ready;
  `);
  const state = result.recordset[0];
  if (state.database_name !== 'Kore_Demo' || !state.schema_ready) {
    throw new Error('The Kore_Demo jje schema is not ready. Apply database migrations first.');
  }
  return state;
}

export { sql };
