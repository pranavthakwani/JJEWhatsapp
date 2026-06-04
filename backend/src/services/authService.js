import crypto from 'crypto';
import { promisify } from 'util';
import { getAdminClient } from '../config/db.js';
import { env } from '../config/env.js';

const pbkdf2 = promisify(crypto.pbkdf2);
const supabase = getAdminClient();
const DEVICE_STATUSES = new Set(['pending', 'approved', 'blocked']);
const USER_STATUSES = new Set(['active', 'disabled']);

function nowIso() {
  return new Date().toISOString();
}

function isProductionCookie() {
  if (String(process.env.AUTH_COOKIE_SECURE || '').toLowerCase() === 'false') return false;
  if (String(process.env.AUTH_COOKIE_SECURE || '').toLowerCase() === 'true') return true;
  const nodeEnv = String(env.nodeEnv || '').toLowerCase();
  return nodeEnv === 'production' || nodeEnv === 'live';
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hmac(value) {
  return crypto.createHmac('sha256', env.auth.secret).update(String(value)).digest('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(cookieHeader = '') {
  return String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) return cookies;

      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
      return cookies;
    }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (typeof options.maxAge === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }

  if (isProductionCookie()) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }

  res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
}

function setCookie(res, name, value, options = {}) {
  appendCookie(res, serializeCookie(name, value, options));
}

function clearCookie(res, name) {
  appendCookie(res, serializeCookie(name, '', { maxAge: 0 }));
}

function getRequestIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

function getDeviceName(userAgent) {
  const text = String(userAgent || '');
  if (/android/i.test(text)) return 'Android phone';
  if (/iphone|ipad/i.test(text)) return 'iPhone/iPad';
  if (/windows/i.test(text)) return 'Windows browser';
  if (/mac os/i.test(text)) return 'Mac browser';
  return 'Browser device';
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function makeDeviceCode(row, codeBaseId = null) {
  if (!row?.id) return 'JJE-PENDING';

  const baseId = Number.isFinite(Number(codeBaseId)) ? Number(codeBaseId) : Number(row.id);
  const codeNumber = Math.max(1, Number(row.id) - baseId + 1);
  return `JJE-${String(codeNumber).padStart(4, '0')}`;
}

function mapDevice(row, currentHash = '', codeBaseId = null) {
  if (!row) return null;
  return {
    id: row.id,
    deviceCode: makeDeviceCode(row, codeBaseId),
    deviceName: row.device_name,
    browserInfo: row.browser_info,
    ipAddress: row.ip_address,
    status: row.status,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    isCurrent: Boolean(currentHash && row.device_token_hash === currentHash),
  };
}

async function getDeviceCodeBaseId() {
  const result = await supabase
    .from('app_devices')
    .select('id')
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (result.error) throw result.error;
  return result.data?.id || null;
}

function makeSession(userId, rememberMe = false) {
  const lifetimeMs = rememberMe
    ? env.auth.rememberDays * 24 * 60 * 60 * 1000
    : env.auth.sessionHours * 60 * 60 * 1000;
  const payload = {
    userId,
    exp: Date.now() + lifetimeMs,
    nonce: randomToken(12),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return {
    token: `${body}.${hmac(body)}`,
    maxAgeSeconds: Math.floor(lifetimeMs / 1000),
  };
}

function readSession(cookieValue) {
  if (!cookieValue) return null;
  const [body, signature] = String(cookieValue).split('.');
  if (!body || !signature || !safeEqual(signature, hmac(body))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload?.userId || !payload?.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function hashPassword(password) {
  const salt = randomToken(16);
  const iterations = 210000;
  const digest = await pbkdf2(String(password), salt, iterations, 32, 'sha256');
  return `pbkdf2_sha256$${iterations}$${salt}$${digest.toString('base64url')}`;
}

async function verifyPassword(password, storedHash) {
  const [scheme, iterationText, salt, hash] = String(storedHash || '').split('$');
  if (scheme !== 'pbkdf2_sha256' || !iterationText || !salt || !hash) return false;

  const digest = await pbkdf2(String(password), salt, Number(iterationText), 32, 'sha256');
  return safeEqual(digest.toString('base64url'), hash);
}

function validateAuthInput({ email, password, name }, requireName = false) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedName = String(name || '').trim();
  const normalizedPassword = String(password || '');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return { error: 'Enter a valid email address.' };
  }

  if (requireName && normalizedName.length < 2) {
    return { error: 'Enter a valid name.' };
  }

  if (normalizedPassword.length < 6) {
    return { error: 'Password must be at least 6 characters.' };
  }

  return {
    email: normalizedEmail,
    name: normalizedName,
    password: normalizedPassword,
  };
}

async function ensureDevice(req, res = null) {
  const cookies = parseCookies(req.headers.cookie || '');
  let deviceToken = cookies[env.auth.deviceCookieName];
  if (!deviceToken || deviceToken.length < 24) {
    deviceToken = randomToken(32);
    if (res) {
      setCookie(res, env.auth.deviceCookieName, deviceToken, {
        maxAge: env.auth.deviceDays * 24 * 60 * 60,
      });
    }
  }

  const deviceTokenHash = sha256(deviceToken);
  const browserInfo = String(req.headers['user-agent'] || '').slice(0, 600);
  const ipAddress = getRequestIp(req);

  const existing = await supabase
    .from('app_devices')
    .select('*')
    .eq('device_token_hash', deviceTokenHash)
    .maybeSingle();

  if (existing.error) throw existing.error;

  if (existing.data) {
    const updated = await supabase
      .from('app_devices')
      .update({
        browser_info: browserInfo,
        ip_address: ipAddress,
        last_seen_at: nowIso(),
      })
      .eq('id', existing.data.id)
      .select('*')
      .single();

    if (updated.error) throw updated.error;
    return { row: updated.data, tokenHash: deviceTokenHash };
  }

  const inserted = await supabase
    .from('app_devices')
    .insert({
      device_token_hash: deviceTokenHash,
      device_name: getDeviceName(browserInfo),
      browser_info: browserInfo,
      ip_address: ipAddress,
      status: 'pending',
      last_seen_at: nowIso(),
    })
    .select('*')
    .single();

  if (inserted.error) throw inserted.error;
  return { row: inserted.data, tokenHash: deviceTokenHash };
}

async function getUserFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const session = readSession(cookies[env.auth.sessionCookieName]);
  if (!session) return null;

  const result = await supabase
    .from('app_users')
    .select('*')
    .eq('id', session.userId)
    .maybeSingle();

  if (result.error) throw result.error;
  if (!result.data || result.data.status !== 'active') return null;
  return result.data;
}

async function getAuthContext(req, res = null) {
  const device = await ensureDevice(req, res);
  const [user, deviceCodeBaseId] = await Promise.all([
    getUserFromRequest(req),
    getDeviceCodeBaseId(),
  ]);

  return {
    user,
    device: device.row,
    deviceTokenHash: device.tokenHash,
    deviceCodeBaseId,
  };
}

function buildAuthStatus(context) {
  const user = mapUser(context.user);
  const device = mapDevice(context.device, context.deviceTokenHash, context.deviceCodeBaseId);
  return {
    authenticated: Boolean(user),
    canUseApp: Boolean(user && device?.status === 'approved'),
    user,
    device,
  };
}

export async function getAuthStatus(req, res) {
  return buildAuthStatus(await getAuthContext(req, res));
}

export async function registerUser(req, res, body) {
  const input = validateAuthInput(body, true);
  if (input.error) {
    const error = new Error(input.error);
    error.statusCode = 400;
    throw error;
  }

  const existing = await supabase
    .from('app_users')
    .select('id')
    .eq('email', input.email)
    .maybeSingle();

  if (existing.error) throw existing.error;
  if (existing.data) {
    const error = new Error('This email is already registered.');
    error.statusCode = 409;
    throw error;
  }

  const firstUserProbe = await supabase
    .from('app_users')
    .select('id', { count: 'exact', head: true });

  if (firstUserProbe.error) throw firstUserProbe.error;

  const isFirstUser = Number(firstUserProbe.count || 0) === 0;
  const passwordHash = await hashPassword(input.password);
  const inserted = await supabase
    .from('app_users')
    .insert({
      name: input.name,
      email: input.email,
      password_hash: passwordHash,
      role: isFirstUser ? 'admin' : 'user',
      status: 'active',
    })
    .select('*')
    .single();

  if (inserted.error) throw inserted.error;

  const session = makeSession(inserted.data.id, Boolean(body.rememberMe));
  setCookie(res, env.auth.sessionCookieName, session.token, { maxAge: session.maxAgeSeconds });

  const context = await getAuthContext(req, res);
  if (isFirstUser && context.device?.status !== 'approved') {
    const approved = await supabase
      .from('app_devices')
      .update({
        status: 'approved',
        approved_by: inserted.data.email,
        approved_at: nowIso(),
      })
      .eq('id', context.device.id)
      .select('*')
      .single();

    if (approved.error) throw approved.error;
    context.device = approved.data;
  }

  context.user = inserted.data;
  return buildAuthStatus(context);
}

export async function loginUser(req, res, body) {
  const input = validateAuthInput(body, false);
  if (input.error) {
    const error = new Error(input.error);
    error.statusCode = 400;
    throw error;
  }

  const result = await supabase
    .from('app_users')
    .select('*')
    .eq('email', input.email)
    .maybeSingle();

  if (result.error) throw result.error;

  const passwordMatches = result.data
    ? await verifyPassword(input.password, result.data.password_hash)
    : false;

  if (!result.data || !passwordMatches || result.data.status !== 'active') {
    const error = new Error('Invalid email or password.');
    error.statusCode = 401;
    throw error;
  }

  const session = makeSession(result.data.id, Boolean(body.rememberMe));
  setCookie(res, env.auth.sessionCookieName, session.token, { maxAge: session.maxAgeSeconds });

  const context = await getAuthContext(req, res);
  context.user = result.data;
  return buildAuthStatus(context);
}

export function logoutUser(_req, res) {
  clearCookie(res, env.auth.sessionCookieName);
  return { ok: true };
}

export async function requireAppAccess(req, res, next) {
  try {
    const context = await getAuthContext(req, res);
    if (!context.user) {
      res.status(401).json({ error: 'Login required.', code: 'AUTH_REQUIRED' });
      return;
    }

    if (context.device?.status !== 'approved') {
      res.status(403).json({
        error: 'This device is waiting for admin approval.',
        code: 'DEVICE_NOT_APPROVED',
        auth: buildAuthStatus(context),
      });
      return;
    }

    req.auth = {
      user: mapUser(context.user),
      device: mapDevice(context.device, context.deviceTokenHash, context.deviceCodeBaseId),
    };
    next();
  } catch (error) {
    next(error);
  }
}

async function requireAdminContext(req, res) {
  const context = await getAuthContext(req, res);
  if (!context.user) {
    res.status(401).json({ error: 'Login required.', code: 'AUTH_REQUIRED' });
    return null;
  }

  if (context.device?.status !== 'approved') {
    res.status(403).json({ error: 'This device is waiting for admin approval.', code: 'DEVICE_NOT_APPROVED' });
    return null;
  }

  if (context.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required.', code: 'ADMIN_REQUIRED' });
    return null;
  }

  return context;
}

export async function listDevices(req, res) {
  const context = await requireAdminContext(req, res);
  if (!context) return null;

  const result = await supabase
    .from('app_devices')
    .select('*')
    .order('last_seen_at', { ascending: false, nullsFirst: false });

  if (result.error) throw result.error;
  const deviceCodeBaseId = result.data.reduce((lowest, row) => Math.min(lowest, Number(row.id)), Number.POSITIVE_INFINITY);
  return {
    devices: result.data.map((row) => mapDevice(
      row,
      context.deviceTokenHash,
      Number.isFinite(deviceCodeBaseId) ? deviceCodeBaseId : context.deviceCodeBaseId,
    )),
  };
}

export async function updateDevice(req, res) {
  const context = await requireAdminContext(req, res);
  if (!context) return null;

  const deviceId = Number(req.params.deviceId);
  if (!Number.isInteger(deviceId)) {
    res.status(400).json({ error: 'Invalid device id.' });
    return null;
  }

  const status = req.body.status ? String(req.body.status).toLowerCase() : null;
  const updates = {};

  if (status) {
    if (!DEVICE_STATUSES.has(status)) {
      res.status(400).json({ error: 'Invalid device status.' });
      return null;
    }

    updates.status = status;
    if (status === 'approved') {
      updates.approved_by = context.user.email;
      updates.approved_at = nowIso();
    }
  }

  if (typeof req.body.deviceName === 'string') {
    updates.device_name = req.body.deviceName.trim().slice(0, 120) || 'Browser device';
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'Nothing to update.' });
    return null;
  }

  const result = await supabase
    .from('app_devices')
    .update(updates)
    .eq('id', deviceId)
    .select('*')
    .single();

  if (result.error) throw result.error;
  return { device: mapDevice(result.data, context.deviceTokenHash, context.deviceCodeBaseId) };
}

export async function authenticateSocket(socket) {
  const req = {
    headers: {
      cookie: socket.handshake.headers.cookie || '',
      'user-agent': socket.handshake.headers['user-agent'] || '',
      'x-forwarded-for': socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '',
    },
    socket: {
      remoteAddress: socket.handshake.address || '',
    },
  };

  const context = await getAuthContext(req, null);
  if (!context.user) {
    throw new Error('AUTH_REQUIRED');
  }

  if (context.device?.status !== 'approved') {
    throw new Error('DEVICE_NOT_APPROVED');
  }

  return {
    user: mapUser(context.user),
    device: mapDevice(context.device, context.deviceTokenHash, context.deviceCodeBaseId),
  };
}

export function assertValidUserStatus(status) {
  return USER_STATUSES.has(String(status || '').toLowerCase());
}
