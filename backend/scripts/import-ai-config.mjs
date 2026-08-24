import fs from 'node:fs';
import path from 'node:path';

const sourcePath = process.argv[2];
const targetPath = process.argv[3] || path.resolve(process.cwd(), '.env');
const allowedKeys = ['OPENAI_API_KEY', 'OPENAI_MODEL'];

if (!sourcePath) throw new Error('Pass the source .env path as the first argument.');

function parseEnv(contents) {
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

const source = parseEnv(fs.readFileSync(sourcePath, 'utf8'));
const missing = allowedKeys.filter((key) => !source.get(key));
if (missing.length) throw new Error(`Source configuration is missing: ${missing.join(', ')}.`);

let target = fs.readFileSync(targetPath, 'utf8');
for (const key of allowedKeys) {
  const line = `${key}=${source.get(key)}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  target = pattern.test(target) ? target.replace(pattern, line) : `${target.trimEnd()}\n${line}\n`;
}

fs.writeFileSync(targetPath, target, 'utf8');
console.log(JSON.stringify({ ok: true, imported: allowedKeys, target: path.basename(targetPath) }));
