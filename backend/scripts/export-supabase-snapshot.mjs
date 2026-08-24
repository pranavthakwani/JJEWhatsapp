import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import axios from 'axios';

const PAGE_SIZE = 1_000;
const MAGIC = Buffer.from('JJESUP01');

function safeFailure(error) {
  const code = String(error?.code || error?.response?.status || 'UNKNOWN').replace(/[^A-Za-z0-9_-]/g, '');
  const message = String(error?.message || 'Snapshot export failed').replace(/[\r\n]+/g, ' ').slice(0, 500);
  console.error(`SNAPSHOT_FAILED code=${code} message=${message}`);
  process.exit(1);
}

process.once('uncaughtException', safeFailure);
process.once('unhandledRejection', safeFailure);

function parseEnvironment(contents) {
  return String(contents).split(/\r?\n/).reduce((result, line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) return result;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
    return result;
  }, {});
}

function safeName(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe table name: ${value}`);
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function encryptPage(rows, key) {
  const plaintext = Buffer.from(JSON.stringify(rows));
  const compressed = gzipSync(plaintext, { level: 9 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    contents: Buffer.concat([MAGIC, iv, tag, ciphertext]),
    plaintextSha256: sha256(plaintext),
    plaintextBytes: plaintext.length,
  };
}

const [legacyEnvArgument, outputArgument] = process.argv.slice(2).filter((value) => !value.startsWith('--'));
if (!legacyEnvArgument || !outputArgument) {
  throw new Error('Usage: node scripts/export-supabase-snapshot.mjs <legacy-env> <output-directory> [--allow-insecure-tls]');
}

const legacyEnvPath = path.resolve(legacyEnvArgument);
const outputDirectory = path.resolve(outputArgument);
const applicationEnvPath = path.resolve(process.cwd(), '.env');
const [legacy, application] = await Promise.all([
  fs.readFile(legacyEnvPath, 'utf8').then(parseEnvironment),
  fs.readFile(applicationEnvPath, 'utf8').then(parseEnvironment),
]);

if (!legacy.SUPABASE_URL || !legacy.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('The legacy environment is missing Supabase connection values.');
}
if (!application.TOKEN_ENCRYPTION_KEY || application.TOKEN_ENCRYPTION_KEY.length < 32) {
  throw new Error('TOKEN_ENCRYPTION_KEY (minimum 32 characters) is required to encrypt the snapshot.');
}

const sourceUrl = new URL(String(legacy.SUPABASE_URL).replace(/\/rest\/v1\/?$/, ''));
const allowInsecureTls = process.argv.includes('--allow-insecure-tls');
if (allowInsecureTls && !sourceUrl.hostname.endsWith('.supabase.co')) {
  throw new Error('Insecure TLS is permitted only for a verified *.supabase.co migration source.');
}

await fs.mkdir(outputDirectory, { recursive: true });
if ((await fs.readdir(outputDirectory)).length > 0) {
  throw new Error(`Snapshot destination must be empty: ${outputDirectory}`);
}

const key = crypto.createHash('sha256').update(application.TOKEN_ENCRYPTION_KEY).digest();
const client = axios.create({
  baseURL: `${sourceUrl.origin}/rest/v1`,
  timeout: 60_000,
  httpsAgent: allowInsecureTls ? new https.Agent({ rejectUnauthorized: false }) : undefined,
  headers: {
    apikey: legacy.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${legacy.SUPABASE_SERVICE_ROLE_KEY}`,
  },
});

const openApi = await client.get('/', { headers: { Accept: 'application/openapi+json' } });
const tables = Object.entries(openApi.data?.paths || {})
  .filter(([route, operations]) => route !== '/' && !route.startsWith('/rpc/') && operations?.get)
  .map(([route]) => safeName(decodeURIComponent(route.slice(1))))
  .sort();

if (tables.length === 0) throw new Error('Supabase OpenAPI schema did not expose any readable tables.');

const manifest = {
  format: 'jje-supabase-snapshot-v1',
  encrypted: true,
  compression: 'gzip',
  cipher: 'aes-256-gcm',
  keySource: 'backend/.env TOKEN_ENCRYPTION_KEY',
  sourceHost: sourceUrl.hostname,
  tlsVerification: !allowInsecureTls,
  startedAt: new Date().toISOString(),
  completedAt: null,
  tableCount: tables.length,
  totalRows: 0,
  tables: [],
};

async function saveManifest() {
  await fs.writeFile(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

await saveManifest();

for (const table of tables) {
  const tableDirectory = path.join(outputDirectory, table);
  await fs.mkdir(tableDirectory, { recursive: true });
  const tableManifest = { name: table, columns: [], expectedRows: null, exportedRows: 0, pages: [] };
  manifest.tables.push(tableManifest);

  for (let page = 0; ; page += 1) {
    const response = await client.get(`/${table}`, {
      params: { select: '*', limit: PAGE_SIZE, offset: page * PAGE_SIZE },
      headers: { Prefer: 'count=exact' },
    });
    const rows = Array.isArray(response.data) ? response.data : [];
    if (page === 0) {
      const contentRange = String(response.headers['content-range'] || '*/');
      const total = Number(contentRange.split('/')[1]);
      tableManifest.expectedRows = Number.isFinite(total) ? total : null;
      tableManifest.columns = Object.keys(rows[0] || {}).sort();
    }
    if (rows.length === 0) break;

    const encrypted = encryptPage(rows, key);
    const fileName = `page-${String(page + 1).padStart(6, '0')}.json.gz.enc`;
    const filePath = path.join(tableDirectory, fileName);
    await fs.writeFile(filePath, encrypted.contents);
    tableManifest.pages.push({
      file: `${table}/${fileName}`,
      rows: rows.length,
      encryptedBytes: encrypted.contents.length,
      encryptedSha256: sha256(encrypted.contents),
      plaintextBytes: encrypted.plaintextBytes,
      plaintextSha256: encrypted.plaintextSha256,
    });
    tableManifest.exportedRows += rows.length;
    manifest.totalRows += rows.length;
    await saveManifest();
    if (rows.length < PAGE_SIZE) break;
  }

  if (tableManifest.expectedRows !== null && tableManifest.expectedRows !== tableManifest.exportedRows) {
    throw new Error(`Row count changed while exporting ${table}: expected ${tableManifest.expectedRows}, exported ${tableManifest.exportedRows}`);
  }
  console.log(`${table}: ${tableManifest.exportedRows}`);
}

manifest.completedAt = new Date().toISOString();
await saveManifest();
console.log(`SNAPSHOT_COMPLETE tables=${manifest.tableCount} rows=${manifest.totalRows} destination=${outputDirectory}`);
