import crypto from 'crypto';
import { getAdminClient } from '../config/db.js';
import { env } from '../config/env.js';

const supabase = getAdminClient();
const DEVICE_STATUSES = new Set(['pending', 'approved', 'blocked']);

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
    'SameSite=Strict',
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

function signDeviceToken(token) {
  return hmac(`device:${token}`);
}

function buildDeviceCookieValue(token) {
  return `v1.${token}.${signDeviceToken(token)}`;
}

function parseDeviceCookie(value) {
  const cookieValue = String(value || '').trim();
  if (!cookieValue) return { token: null, needsRefresh: false };

  if (!cookieValue.startsWith('v1.')) {
    return cookieValue.length >= 24
      ? { token: cookieValue, needsRefresh: true }
      : { token: null, needsRefresh: false };
  }

  const [, token, signature] = cookieValue.split('.');
  if (!token || token.length < 24 || !signature) {
    return { token: null, needsRefresh: false };
  }

  return safeEqual(signature, signDeviceToken(token))
    ? { token, needsRefresh: false }
    : { token: null, needsRefresh: false };
}

function setDeviceCookie(res, token) {
  setCookie(res, env.auth.deviceCookieName, buildDeviceCookieValue(token), {
    maxAge: env.auth.deviceDays * 24 * 60 * 60,
  });
}

async function ensureDevice(req, res = null) {
  const cookies = parseCookies(req.headers.cookie || '');
  const parsedCookie = parseDeviceCookie(cookies[env.auth.deviceCookieName]);
  let deviceToken = parsedCookie.token;
  if (!deviceToken) {
    deviceToken = randomToken(32);
    if (res) {
      setDeviceCookie(res, deviceToken);
    }
  } else if (res && parsedCookie.needsRefresh) {
    setDeviceCookie(res, deviceToken);
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

async function getAuthContext(req, res = null) {
  const device = await ensureDevice(req, res);
  const deviceCodeBaseId = await getDeviceCodeBaseId();

  return {
    device: device.row,
    deviceTokenHash: device.tokenHash,
    deviceCodeBaseId,
  };
}

function buildAuthStatus(context) {
  const device = mapDevice(context.device, context.deviceTokenHash, context.deviceCodeBaseId);
  return {
    authenticated: Boolean(device),
    canUseApp: Boolean(device?.status === 'approved'),
    user: null,
    device,
  };
}

export async function getAuthStatus(req, res) {
  return buildAuthStatus(await getAuthContext(req, res));
}

export function logoutUser(_req, res) {
  clearCookie(res, env.auth.sessionCookieName);
  clearCookie(res, env.auth.deviceCookieName);
  return { ok: true };
}

export async function requireAppAccess(req, res, next) {
  try {
    const context = await getAuthContext(req, res);
    if (context.device?.status !== 'approved') {
      res.status(403).json({
        error: 'This device is waiting for admin approval.',
        code: 'DEVICE_NOT_APPROVED',
        auth: buildAuthStatus(context),
      });
      return;
    }

    req.auth = {
      user: null,
      device: mapDevice(context.device, context.deviceTokenHash, context.deviceCodeBaseId),
    };
    next();
  } catch (error) {
    next(error);
  }
}

async function requireApprovedDeviceContext(req, res) {
  const context = await getAuthContext(req, res);
  if (context.device?.status !== 'approved') {
    res.status(403).json({ error: 'This device is waiting for admin approval.', code: 'DEVICE_NOT_APPROVED' });
    return null;
  }

  return context;
}

export async function listDevices(req, res) {
  const context = await requireApprovedDeviceContext(req, res);
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
  const context = await requireApprovedDeviceContext(req, res);
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
      updates.approved_by = makeDeviceCode(context.device, context.deviceCodeBaseId);
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
  if (context.device?.status !== 'approved') {
    throw new Error('DEVICE_NOT_APPROVED');
  }

  return {
    user: null,
    device: mapDevice(context.device, context.deviceTokenHash, context.deviceCodeBaseId),
  };
}
