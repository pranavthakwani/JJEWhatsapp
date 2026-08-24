import { env } from '../config/env.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = LEVELS[String(env.logLevel).toLowerCase()] || LEVELS.info;
const SENSITIVE_KEY = /token|password|secret|authorization|cookie|cipher/i;

function redact(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value instanceof Error) return { name: value.name, message: value.message, stack: env.isProduction ? undefined : value.stack };
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[redacted]' : redact(item, depth + 1)]));
}

function write(level, message, meta = {}) {
  if (LEVELS[level] < configuredLevel) return;
  const record = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...redact(meta) });
  if (level === 'error') console.error(record);
  else if (level === 'warn') console.warn(record);
  else console.log(record);
}

export const logger = {
  debug: (message, meta) => write('debug', message, meta),
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};
