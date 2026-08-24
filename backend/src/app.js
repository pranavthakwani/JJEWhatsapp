import cors from 'cors';
import express from 'express';
import { createApiRouter } from './routes/api.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { requestContext, rateLimit, securityHeaders, verifyRequestOrigin } from './middleware/requestSecurity.js';

export function createApp(io) {
  const app = express();
  app.disable('etag');
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestContext);
  app.use(securityHeaders);

  app.use(cors({
    origin: env.socketCorsOrigin,
    credentials: true,
  }));

  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });

  app.use('/api/webhooks/meta', express.json({
    limit: '10mb',
    verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); },
  }));
  app.use(verifyRequestOrigin(env.socketCorsOrigin));
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', rateLimit({ windowMs: 60_000, max: 10, scope: 'auth' }));
  app.use('/api', rateLimit({ windowMs: 60_000, max: 600, scope: 'api' }));

  app.use('/api', createApiRouter(io));

  app.use((error, req, res, _next) => {
    const databaseUnavailable = error?.name === 'ConnectionError'
      || ['ESOCKET', 'ECONNCLOSED', 'ETIMEOUT', 'ELOGIN'].includes(error?.code);
    const statusCode = databaseUnavailable ? 503 : (error.statusCode || 500);
    logger.error('Unhandled request error', {
      message: error.message,
      correlationId: req.correlationId,
    });

    res.status(statusCode).json({
      error: databaseUnavailable
        ? 'The application database is unavailable. Check the SQL Server network connection.'
        : statusCode < 500 ? error.message : 'Internal server error',
      code: databaseUnavailable ? 'DATABASE_UNAVAILABLE' : error.code,
      correlationId: req.correlationId,
    });
  });

  return app;
}
