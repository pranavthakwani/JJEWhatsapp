import { getPool, sql } from '../config/db.js';

export async function query(text, parameters = []) {
  const pool = await getPool();
  const request = pool.request();
  for (const parameter of parameters) {
    request.input(parameter.name, parameter.type, parameter.value ?? null);
  }
  return request.query(text);
}

export async function executeProcedure(name, parameters = []) {
  const pool = await getPool();
  const request = pool.request();
  for (const parameter of parameters) {
    request.input(parameter.name, parameter.type, parameter.value ?? null);
  }
  return request.execute(name);
}

export function input(name, type, value) {
  return { name, type, value };
}

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function clampInteger(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export { sql };
