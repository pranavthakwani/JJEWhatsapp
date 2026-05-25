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

export const env = {
  port: Number(process.env.PORT || 4500),
  supabase: {
    url: normaliseSupabaseUrl(process.env.SUPABASE_URL),
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  socketCorsOrigin: process.env.SOCKET_CORS_ORIGIN || 'http://localhost:5176',
  graphVersion: process.env.META_GRAPH_VERSION || 'v22.0',
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '91',
};
