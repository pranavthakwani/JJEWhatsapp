import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { input, query, sql } from '../repositories/sqlHelpers.js';

const DEVICE_STATUSES = new Set(['pending', 'approved', 'blocked', 'revoked']);
const PASSWORD_PREFIX = 'scrypt';
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function isProductionCookie() {
  if (String(process.env.AUTH_COOKIE_SECURE || '').toLowerCase() === 'false') return false;
  if (String(process.env.AUTH_COOKIE_SECURE || '').toLowerCase() === 'true') return true;
  return env.isProduction;
}

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest(); }
function hmac(value) { return crypto.createHmac('sha256', env.auth.secret).update(String(value)).digest('base64url'); }

function safeEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(String(left));
  const b = Buffer.isBuffer(right) ? right : Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function hashPassword(password) {
  const value = String(password || '');
  if (value.length < 12 || value.length > 256) throw new Error('Password must be between 12 and 256 characters.');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(value, salt, 64, SCRYPT_OPTIONS);
  return [PASSWORD_PREFIX, SCRYPT_OPTIONS.N, SCRYPT_OPTIONS.r, SCRYPT_OPTIONS.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function verifyPassword(password, encoded) {
  try {
    const [prefix, rawN, rawR, rawP, rawSalt, rawHash] = String(encoded || '').split('$');
    if (prefix !== PASSWORD_PREFIX) return false;
    const options = { N: Number(rawN), r: Number(rawR), p: Number(rawP), maxmem: SCRYPT_OPTIONS.maxmem };
    if (options.N !== SCRYPT_OPTIONS.N || options.r !== SCRYPT_OPTIONS.r || options.p !== SCRYPT_OPTIONS.p) return false;
    const expected = Buffer.from(rawHash, 'base64url');
    const actual = crypto.scryptSync(String(password || ''), Buffer.from(rawSalt, 'base64url'), expected.length, options);
    return safeEqual(actual, expected);
  } catch {
    return false;
  }
}

const DUMMY_PASSWORD_HASH = hashPassword('constant-invalid-login-password');

function parseCookies(header = '') {
  return String(header).split(';').map((part) => part.trim()).filter(Boolean).reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index < 0) return cookies;
    const key = part.slice(0, index).trim();
    try { cookies[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch { cookies[key] = part.slice(index + 1).trim(); }
    return cookies;
  }, {});
}

function serializeCookie(name, value, { maxAge } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (typeof maxAge === 'number') parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (isProductionCookie()) parts.push('Secure');
  return parts.join('; ');
}

function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', !existing ? cookie : Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
}

function setCookie(res, name, value, options) { appendCookie(res, serializeCookie(name, value, options)); }
function clearCookie(res, name) { appendCookie(res, serializeCookie(name, '', { maxAge: 0 })); }

function signedToken(kind, token) { return `v1.${token}.${hmac(`${kind}:${token}`)}`; }
function parseSignedToken(kind, value) {
  const [version, token, signature] = String(value || '').split('.');
  if (version !== 'v1' || !token || token.length < 24 || !signature) return null;
  return safeEqual(signature, hmac(`${kind}:${token}`)) ? token : null;
}

function requestIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return forwarded ? String(forwarded).split(',')[0].trim() : req.socket?.remoteAddress || '';
}

function deviceName(userAgent) {
  const text = String(userAgent || '');
  if (/android/i.test(text)) return 'Android phone';
  if (/iphone|ipad/i.test(text)) return 'iPhone/iPad';
  if (/windows/i.test(text)) return 'Windows browser';
  if (/mac os/i.test(text)) return 'Mac browser';
  return 'Browser device';
}

function deviceCode(row, baseId) {
  const base = Number.isFinite(Number(baseId)) ? Number(baseId) : Number(row.device_id);
  return `JJE-${String(Math.max(1, Number(row.device_id) - base + 1)).padStart(4, '0')}`;
}

function mapDevice(row, currentHash, baseId) {
  if (!row) return null;
  return {
    id: Number(row.device_id),
    deviceCode: deviceCode(row, baseId),
    deviceName: row.device_name,
    browserInfo: row.user_agent,
    ipAddress: row.ip_address,
    status: row.status,
    approvedBy: row.approved_by_name || null,
    approvedAt: row.approved_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    isCurrent: Boolean(currentHash && row.device_token_hash && safeEqual(currentHash, row.device_token_hash)),
  };
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: Number(row.user_id),
    displayName: row.display_name,
    email: row.email,
    roles: String(row.role_keys || '').split(',').filter(Boolean),
  };
}

async function getBaseDeviceId() {
  const result = await query('SELECT MIN(device_id) AS base_id FROM jje.devices;');
  return result.recordset[0]?.base_id || null;
}

async function ensureDevice(req, res = null) {
  const cookies = parseCookies(req.headers.cookie || '');
  let token = parseSignedToken('device', cookies[env.auth.deviceCookieName]);
  if (!token) {
    token = randomToken();
    if (res) setCookie(res, env.auth.deviceCookieName, signedToken('device', token), { maxAge: env.auth.deviceDays * 86400 });
  }
  const tokenHash = sha256(token);
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 1000);
  const ipAddress = requestIp(req).slice(0, 64);
  const result = await query(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @deviceId bigint;
    SELECT @deviceId = device_id FROM jje.devices WITH (UPDLOCK, HOLDLOCK) WHERE device_token_hash = @tokenHash;
    IF @deviceId IS NULL
    BEGIN
      INSERT jje.devices(device_token_hash, device_name, user_agent, ip_address, last_seen_at)
      VALUES(@tokenHash, @deviceName, @userAgent, @ipAddress, SYSUTCDATETIME());
      SET @deviceId = SCOPE_IDENTITY();
    END
    ELSE UPDATE jje.devices SET user_agent = @userAgent, ip_address = @ipAddress,
      last_seen_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() WHERE device_id = @deviceId;
    COMMIT TRANSACTION;
    SELECT device.*, approver.display_name AS approved_by_name FROM jje.devices device
      LEFT JOIN jje.users approver ON approver.user_id = device.approved_by_user_id WHERE device.device_id = @deviceId;`, [
    input('tokenHash', sql.Binary(32), tokenHash),
    input('deviceName', sql.NVarChar(160), deviceName(userAgent)),
    input('userAgent', sql.NVarChar(1000), userAgent),
    input('ipAddress', sql.VarChar(64), ipAddress),
  ]);
  return { row: result.recordset[0], tokenHash, baseId: await getBaseDeviceId() };
}

async function loadSession(req) {
  const cookie = parseCookies(req.headers.cookie || '')[env.auth.sessionCookieName];
  const token = parseSignedToken('session', cookie);
  if (!token) return null;
  const result = await query(`
    SELECT session.session_id, session.user_id, session.device_id,
      usr.display_name, usr.email, usr.status,
      roles.role_keys
    FROM jje.sessions session
    INNER JOIN jje.users usr ON usr.user_id = session.user_id
    OUTER APPLY (
      SELECT STRING_AGG(role.role_key, ',') AS role_keys
      FROM jje.user_roles user_role INNER JOIN jje.roles role ON role.role_id = user_role.role_id
      WHERE user_role.user_id = usr.user_id
    ) roles
    WHERE session.session_token_hash = @tokenHash AND session.revoked_at IS NULL
      AND session.expires_at > SYSUTCDATETIME() AND usr.status = 'active';`, [
    input('tokenHash', sql.Binary(32), sha256(token)),
  ]);
  if (!result.recordset[0]) return null;
  await query('UPDATE jje.sessions SET last_seen_at = SYSUTCDATETIME() WHERE session_id = @sessionId;', [
    input('sessionId', sql.BigInt, result.recordset[0].session_id),
  ]);
  return { sessionId: Number(result.recordset[0].session_id), user: mapUser(result.recordset[0]) };
}

async function buildContext(req, res = null) {
  const [device, session] = await Promise.all([ensureDevice(req, res), loadSession(req)]);
  return { ...device, session, user: session?.user || null };
}

function authStatus(context) {
  const device = mapDevice(context.row, context.tokenHash, context.baseId);
  const hasUserAccess = !env.auth.requireUser || Boolean(context.user);
  const hasDeviceAccess = !env.auth.requireDeviceApproval || device?.status === 'approved';
  return {
    authenticated: env.auth.requireUser ? Boolean(context.user) : Boolean(device),
    loginRequired: env.auth.requireUser && !context.user,
    deviceApprovalRequired: env.auth.requireDeviceApproval,
    canUseApp: Boolean(hasDeviceAccess && hasUserAccess),
    user: context.user,
    device,
  };
}

export async function getAuthStatus(req, res) { return authStatus(await buildContext(req, res)); }

export async function loginUser(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password || email.length > 320 || password.length > 256) {
    res.status(400);
    return { error: 'Email and password are required.' };
  }
  const result = await query(`
    SELECT usr.user_id, usr.display_name, usr.email, usr.password_hash, usr.status, roles.role_keys
    FROM jje.users usr
    OUTER APPLY (
      SELECT STRING_AGG(role.role_key, ',') AS role_keys
      FROM jje.user_roles user_role INNER JOIN jje.roles role ON role.role_id = user_role.role_id
      WHERE user_role.user_id = usr.user_id
    ) roles
    WHERE LOWER(usr.email) = @email;`, [input('email', sql.NVarChar(320), email)]);
  const row = result.recordset[0];
  const passwordMatches = verifyPassword(password, row?.password_hash || DUMMY_PASSWORD_HASH);
  if (!row || row.status !== 'active' || !passwordMatches) {
    res.status(401);
    return { error: 'Invalid email or password.', code: 'INVALID_CREDENTIALS' };
  }

  const device = await ensureDevice(req, res);
  const user = mapUser(row);
  const isAdmin = user.roles.includes('admin');
  if (isAdmin && device.row.status === 'pending') {
    await query(`UPDATE jje.devices SET status = 'approved', user_id = @userId,
      approved_by_user_id = @userId, approved_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
      WHERE device_id = @deviceId;`, [input('userId', sql.BigInt, user.id), input('deviceId', sql.BigInt, device.row.device_id)]);
    device.row.status = 'approved';
  }

  const remember = Boolean(req.body?.remember);
  const maxAge = (remember ? env.auth.rememberDays * 24 : env.auth.sessionHours) * 3600;
  const sessionToken = randomToken();
  await query(`
    INSERT jje.sessions(session_token_hash, user_id, device_id, expires_at, last_seen_at)
    VALUES(@tokenHash, @userId, @deviceId, DATEADD(second, @maxAge, SYSUTCDATETIME()), SYSUTCDATETIME());
    UPDATE jje.users SET last_login_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() WHERE user_id = @userId;
    UPDATE jje.devices SET user_id = @userId, updated_at = SYSUTCDATETIME() WHERE device_id = @deviceId;`, [
    input('tokenHash', sql.Binary(32), sha256(sessionToken)), input('userId', sql.BigInt, user.id),
    input('deviceId', sql.BigInt, device.row.device_id), input('maxAge', sql.Int, maxAge),
  ]);
  setCookie(res, env.auth.sessionCookieName, signedToken('session', sessionToken), { maxAge });
  return {
    authenticated: true,
    loginRequired: false,
    deviceApprovalRequired: env.auth.requireDeviceApproval,
    canUseApp: !env.auth.requireDeviceApproval || device.row.status === 'approved',
    user,
    device: mapDevice(device.row, device.tokenHash, device.baseId),
  };
}

export async function logoutUser(req, res) {
  const cookie = parseCookies(req.headers.cookie || '')[env.auth.sessionCookieName];
  const token = parseSignedToken('session', cookie);
  if (token) await query('UPDATE jje.sessions SET revoked_at = SYSUTCDATETIME() WHERE session_token_hash = @tokenHash;', [input('tokenHash', sql.Binary(32), sha256(token))]);
  clearCookie(res, env.auth.sessionCookieName);
  return { ok: true };
}

export async function resetCurrentDevice(req, res) {
  const context = await buildContext(req, res);
  await query(`
    UPDATE jje.devices SET status = 'revoked', updated_at = SYSUTCDATETIME() WHERE device_id = @deviceId;
    UPDATE jje.sessions SET revoked_at = COALESCE(revoked_at, SYSUTCDATETIME()) WHERE device_id = @deviceId;`, [
    input('deviceId', sql.BigInt, context.row.device_id),
  ]);
  clearCookie(res, env.auth.sessionCookieName);
  clearCookie(res, env.auth.deviceCookieName);
  return { ok: true };
}

export async function requireAppAccess(req, res, next) {
  try {
    const context = await buildContext(req, res);
    const status = authStatus(context);
    if (!status.canUseApp) {
      res.status(403).json({ error: status.loginRequired ? 'Sign in is required.' : 'This device is waiting for admin approval.', code: status.loginRequired ? 'LOGIN_REQUIRED' : 'DEVICE_NOT_APPROVED', auth: status });
      return;
    }
    req.auth = { user: context.user, device: status.device };
    next();
  } catch (error) { next(error); }
}

async function managementContext(req, res) {
  const context = await buildContext(req, res);
  if (env.auth.requireDeviceApproval && context.row?.status !== 'approved') {
    res.status(403).json({ error: 'This device is waiting for admin approval.', code: 'DEVICE_NOT_APPROVED' });
    return null;
  }
  if (env.auth.requireUser && !context.user?.roles.includes('admin')) {
    res.status(403).json({ error: 'Administrator access is required.', code: 'ADMIN_REQUIRED' });
    return null;
  }
  return context;
}

export async function listDevices(req, res) {
  const context = await managementContext(req, res);
  if (!context) return null;
  const result = await query(`SELECT device.*, approver.display_name AS approved_by_name FROM jje.devices device
    LEFT JOIN jje.users approver ON approver.user_id = device.approved_by_user_id
    ORDER BY device.last_seen_at DESC, device.device_id DESC;`);
  const baseId = result.recordset.reduce((lowest, row) => Math.min(lowest, Number(row.device_id)), Number.POSITIVE_INFINITY);
  return { devices: result.recordset.map((row) => mapDevice(row, context.tokenHash, Number.isFinite(baseId) ? baseId : context.baseId)) };
}

export async function updateDevice(req, res) {
  const context = await managementContext(req, res);
  if (!context) return null;
  const targetId = Number(req.params.deviceId);
  const status = req.body.status ? String(req.body.status).toLowerCase() : null;
  const requestedName = typeof req.body.deviceName === 'string' ? req.body.deviceName.trim().slice(0, 160) : null;
  if (!Number.isInteger(targetId)) { res.status(400).json({ error: 'Invalid device id.' }); return null; }
  if (status && !DEVICE_STATUSES.has(status)) { res.status(400).json({ error: 'Invalid device status.' }); return null; }
  if (!status && !requestedName) { res.status(400).json({ error: 'Nothing to update.' }); return null; }
  const result = await query(`
    UPDATE jje.devices SET status = COALESCE(@status, status), device_name = COALESCE(@deviceName, device_name),
      approved_by_user_id = CASE WHEN @status = 'approved' THEN @approverId ELSE approved_by_user_id END,
      approved_at = CASE WHEN @status = 'approved' THEN SYSUTCDATETIME() ELSE approved_at END,
      updated_at = SYSUTCDATETIME() WHERE device_id = @deviceId;
    SELECT device.*, approver.display_name AS approved_by_name FROM jje.devices device
      LEFT JOIN jje.users approver ON approver.user_id = device.approved_by_user_id WHERE device.device_id = @deviceId;`, [
    input('status', sql.VarChar(20), status), input('deviceName', sql.NVarChar(160), requestedName),
    input('approverId', sql.BigInt, context.user?.id || null), input('deviceId', sql.BigInt, targetId),
  ]);
  if (!result.recordset[0]) { res.status(404).json({ error: 'Device not found.' }); return null; }
  return { device: mapDevice(result.recordset[0], context.tokenHash, context.baseId) };
}

export async function authenticateSocket(socket) {
  const context = await buildContext({
    headers: { cookie: socket.handshake.headers.cookie || '', 'user-agent': socket.handshake.headers['user-agent'] || '', 'x-forwarded-for': socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '' },
    socket: { remoteAddress: socket.handshake.address || '' },
  });
  const status = authStatus(context);
  if (!status.canUseApp) throw new Error(status.loginRequired ? 'LOGIN_REQUIRED' : 'DEVICE_NOT_APPROVED');
  return { user: context.user, device: status.device };
}
