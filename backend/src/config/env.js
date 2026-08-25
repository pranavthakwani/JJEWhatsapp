import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

const required = ['DB_SERVER', 'DB_DATABASE', 'DB_USER', 'DB_PASSWORD'];

const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

function integer(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid numeric environment value: ${value}`);
  }
  return parsed;
}

function boolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (String(value).toLowerCase() === 'true') return true;
  if (String(value).toLowerCase() === 'false') return false;
  throw new Error(`Invalid boolean environment value: ${value}`);
}

function parseCorsOrigins(value) {
  const origins = String(value || 'http://localhost:5176')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length === 1 ? origins[0] : origins;
}

const socketCorsOrigin = parseCorsOrigins(process.env.SOCKET_CORS_ORIGIN);
const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = ['production', 'live'].includes(nodeEnv.toLowerCase());
const authSecret = process.env.AUTH_SECRET || process.env.JWT_SECRET || '';
const tokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY || '';

if (String(process.env.DB_DATABASE).toLowerCase() !== 'kore_demo') {
  throw new Error('DB_DATABASE must be Kore_Demo for this application.');
}

if (isProduction && authSecret.length < 32) {
  throw new Error('AUTH_SECRET must be at least 32 characters in production.');
}

if (isProduction && tokenEncryptionKey.length < 32) {
  throw new Error('TOKEN_ENCRYPTION_KEY must be at least 32 characters in production.');
}

if (isProduction && !process.env.META_APP_SECRET) {
  throw new Error('META_APP_SECRET is required in production.');
}

export const env = {
  port: integer(process.env.PORT, 4500, { min: 1, max: 65535 }),
  nodeEnv,
  isProduction,
  logLevel: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  database: {
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port: integer(process.env.DB_PORT, 1433, { min: 1, max: 65535 }),
    encrypt: boolean(process.env.DB_ENCRYPT, false),
    trustServerCertificate: boolean(process.env.DB_TRUST_SERVER_CERTIFICATE, true),
    poolMin: integer(process.env.DB_POOL_MIN, 1, { min: 0, max: 100 }),
    poolMax: integer(process.env.DB_POOL_MAX, 10, { min: 1, max: 100 }),
    connectionTimeoutMs: integer(process.env.DB_CONNECTION_TIMEOUT_MS, 15000, { min: 1000 }),
    requestTimeoutMs: integer(process.env.DB_REQUEST_TIMEOUT_MS, 30000, { min: 1000 }),
  },
  media: {
    root: path.resolve(process.cwd(), process.env.MEDIA_STORAGE_ROOT || './data/media'),
    maxBytes: integer(process.env.MEDIA_MAX_BYTES, 64 * 1024 * 1024, { min: 1024 }),
  },
  ai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || '',
    timeoutMs: integer(process.env.OPENAI_TIMEOUT_MS, 45_000, { min: 5_000, max: 180_000 }),
    maxOutputTokens: integer(process.env.OPENAI_MAX_OUTPUT_TOKENS, 1800, { min: 200, max: 10_000 }),
    useEnvProxy: boolean(process.env.OPENAI_USE_ENV_PROXY, false),
  },
  features: {
    contacts: boolean(process.env.FEATURE_CONTACTS_ENABLED, true),
    broadcasts: boolean(process.env.FEATURE_BROADCASTS_ENABLED, true),
    system: boolean(process.env.FEATURE_SYSTEM_ENABLED, true),
    aiExtraction: boolean(process.env.AI_EXTRACTION_ENABLED, false),
    aiWorkflowTest: boolean(process.env.AI_WORKFLOW_TEST_ENABLED, false),
  },
  auth: {
    secret: authSecret || 'development-only-auth-secret-change-me',
    tokenEncryptionKey: tokenEncryptionKey || 'development-only-token-key-change-me',
    sessionCookieName: process.env.AUTH_SESSION_COOKIE_NAME || 'jjewa_session',
    deviceCookieName: process.env.AUTH_DEVICE_COOKIE_NAME || 'jjewa_device',
    sessionHours: integer(process.env.AUTH_SESSION_HOURS, 12, { min: 1, max: 168 }),
    rememberDays: integer(process.env.AUTH_REMEMBER_DAYS, 30, { min: 1, max: 365 }),
    deviceDays: integer(process.env.AUTH_DEVICE_DAYS, 365, { min: 1, max: 730 }),
    requireUser: boolean(process.env.AUTH_REQUIRE_USER, isProduction),
    requireDeviceApproval: boolean(process.env.AUTH_DEVICE_APPROVAL_REQUIRED, true),
  },
  socketCorsOrigin,
  graphVersion: process.env.META_GRAPH_VERSION || 'v22.0',
  metaAppSecret: process.env.META_APP_SECRET || '',
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '91',
};
