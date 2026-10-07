import sql from 'mssql';
import { env } from './env.js';

let poolPromise = null;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
    poolPromise = (async () => {
      let lastError;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const pool = createPool();
        pool.on('error', () => { poolPromise = null; });
        try {
          return await pool.connect();
        } catch (error) {
          lastError = error;
          await pool.close().catch(() => undefined);
          if (attempt < 3) await wait(250 * (2 ** attempt));
        }
      }
      throw lastError;
    })().catch((error) => {
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
