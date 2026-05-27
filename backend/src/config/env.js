import dotenv from 'dotenv';

dotenv.config();

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

function normaliseSupabaseUrl(value) {
  return String(value).replace(/\/rest\/v1\/?$/, '');
}

function parseCorsOrigins(value) {
  const origins = String(value || 'http://localhost:5176')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length === 1 ? origins[0] : origins;
}

const socketCorsOrigin = parseCorsOrigins(process.env.SOCKET_CORS_ORIGIN);

export const env = {
  port: Number(process.env.PORT || 4500),
  supabase: {
    url: normaliseSupabaseUrl(process.env.SUPABASE_URL),
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  socketCorsOrigin,
  graphVersion: process.env.META_GRAPH_VERSION || 'v22.0',
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '91',
};
