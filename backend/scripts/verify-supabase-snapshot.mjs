import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const MAGIC = Buffer.from('JJESUP01');

function parseEnvironment(contents) {
  return String(contents).split(/\r?\n/).reduce((result, line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) return result;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
    return result;
  }, {});
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const snapshotDirectory = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node scripts/verify-supabase-snapshot.mjs <snapshot-directory>');

const [manifest, application] = await Promise.all([
  fs.readFile(path.join(snapshotDirectory, 'manifest.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.resolve(process.cwd(), '.env'), 'utf8').then(parseEnvironment),
]);
if (manifest.format !== 'jje-supabase-snapshot-v1' || !manifest.completedAt) throw new Error('Snapshot manifest is incomplete or unsupported.');
if (!application.TOKEN_ENCRYPTION_KEY || application.TOKEN_ENCRYPTION_KEY.length < 32) throw new Error('Snapshot encryption key is unavailable.');

const key = crypto.createHash('sha256').update(application.TOKEN_ENCRYPTION_KEY).digest();
let verifiedRows = 0;
let verifiedPages = 0;

for (const table of manifest.tables) {
  let tableRows = 0;
  for (const page of table.pages) {
    const contents = await fs.readFile(path.join(snapshotDirectory, page.file));
    if (sha256(contents) !== page.encryptedSha256) throw new Error(`Encrypted checksum mismatch: ${page.file}`);
    if (!contents.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`Invalid snapshot page header: ${page.file}`);
    const iv = contents.subarray(8, 20);
    const tag = contents.subarray(20, 36);
    const ciphertext = contents.subarray(36);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = gunzipSync(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    if (sha256(plaintext) !== page.plaintextSha256) throw new Error(`Plaintext checksum mismatch: ${page.file}`);
    const rows = JSON.parse(plaintext.toString('utf8'));
    if (!Array.isArray(rows) || rows.length !== page.rows) throw new Error(`Row count mismatch: ${page.file}`);
    tableRows += rows.length;
    verifiedRows += rows.length;
    verifiedPages += 1;
  }
  if (tableRows !== table.exportedRows) throw new Error(`Table row count mismatch: ${table.name}`);
}

if (verifiedRows !== manifest.totalRows) throw new Error('Manifest total row count mismatch.');
console.log(`SNAPSHOT_VERIFIED tables=${manifest.tableCount} pages=${verifiedPages} rows=${verifiedRows}`);
