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
  nodeEnv: process.env.NODE_ENV || 'development',
  supabase: {
    url: normaliseSupabaseUrl(process.env.SUPABASE_URL),
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  media: {
    bucket: process.env.SUPABASE_MEDIA_BUCKET || 'whatsapp-media',
  },
  auth: {
    secret: process.env.AUTH_SECRET || process.env.JWT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY,
    sessionCookieName: process.env.AUTH_SESSION_COOKIE_NAME || 'jjewa_session',
    deviceCookieName: process.env.AUTH_DEVICE_COOKIE_NAME || 'jjewa_device',
    sessionHours: Number(process.env.AUTH_SESSION_HOURS || 12),
    rememberDays: Number(process.env.AUTH_REMEMBER_DAYS || 30),
    deviceDays: Number(process.env.AUTH_DEVICE_DAYS || 365),
  },
  socketCorsOrigin,
  graphVersion: process.env.META_GRAPH_VERSION || 'v22.0',
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '91',
};
