import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import axios from 'axios';

const TABLES = [
  'wa_business_accounts',
  'wa_phone_numbers',
  'wa_contacts',
  'wa_conversations',
  'wa_messages',
  'wa_templates',
  'wa_contact_lists',
  'wa_contact_list_members',
  'wa_campaigns',
  'wa_campaign_recipients',
  'wa_chat_filter_settings',
  'contacts',
  'conversations',
  'chat_messages',
  'dealer_leads',
  'distributor_offerings',
  'ignored_messages',
];

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

const envPath = path.resolve(process.argv[2] || process.env.LEGACY_SUPABASE_ENV || '');
if (!process.argv[2] && !process.env.LEGACY_SUPABASE_ENV) {
  throw new Error('Pass the legacy backend .env path or set LEGACY_SUPABASE_ENV.');
}

const legacy = parseEnvironment(await fs.readFile(envPath, 'utf8'));
if (!legacy.SUPABASE_URL || !legacy.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('The legacy environment is missing Supabase connection values.');
}

const sourceUrl = new URL(legacy.SUPABASE_URL);
const allowInsecureTls = process.argv.includes('--allow-insecure-tls');
if (allowInsecureTls && !sourceUrl.hostname.endsWith('.supabase.co')) {
  throw new Error('Insecure TLS is permitted only for a verified *.supabase.co migration source.');
}

const client = axios.create({
  baseURL: `${legacy.SUPABASE_URL.replace(/\/$/, '')}/rest/v1`,
  timeout: 30_000,
  httpsAgent: allowInsecureTls ? new https.Agent({ rejectUnauthorized: false }) : undefined,
  headers: {
    apikey: legacy.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${legacy.SUPABASE_SERVICE_ROLE_KEY}`,
  },
});

const inventory = [];
for (const table of TABLES) {
  try {
    const response = await client.get(`/${table}`, {
      params: { select: '*', limit: 1 },
      headers: { Prefer: 'count=exact' },
    });
    const contentRange = String(response.headers['content-range'] || '*/0');
    inventory.push({
      table,
      rows: Number(contentRange.split('/')[1] || 0),
      columns: Object.keys(response.data?.[0] || {}).sort(),
    });
  } catch (error) {
    const responseMessage = typeof error.response?.data === 'string'
      ? error.response.data.slice(0, 500)
      : error.response?.data?.message || error.response?.data?.error;
    inventory.push({ table, status: error.response?.status || null, error: responseMessage || error.message });
  }
}

console.log(JSON.stringify({ source: sourceUrl.hostname, tlsVerification: !allowInsecureTls, tables: inventory }, null, 2));
