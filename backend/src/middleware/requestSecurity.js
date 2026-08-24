import crypto from 'node:crypto';

const requestBuckets = new Map();

export function requestContext(req, res, next) {
  const correlationId = String(req.headers['x-correlation-id'] || crypto.randomUUID()).slice(0, 100);
  req.correlationId = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);
  next();
}

export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
}

export function verifyRequestOrigin(allowedOrigins) {
  const allowed = new Set((Array.isArray(allowedOrigins) ? allowedOrigins : [allowedOrigins]).filter(Boolean));
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/api/webhooks/meta')) {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (!origin && !req.headers.cookie) {
      next();
      return;
    }
    if (!origin || !allowed.has(origin)) {
      res.status(403).json({ error: 'Request origin is not allowed.', code: 'ORIGIN_NOT_ALLOWED' });
      return;
    }
    next();
  };
}

export function rateLimit({ windowMs = 60_000, max = 300, scope = 'api' } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${scope}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    const current = requestBuckets.get(key);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    bucket.count += 1;
    requestBuckets.set(key, bucket);

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      res.status(429).json({ error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' });
      return;
    }

    if (requestBuckets.size > 10_000) {
      for (const [bucketKey, value] of requestBuckets) {
        if (value.resetAt <= now) requestBuckets.delete(bucketKey);
      }
    }
    next();
  };
}
