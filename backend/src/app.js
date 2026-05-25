import cors from 'cors';
import express from 'express';
import { createApiRouter } from './routes/api.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

export function createApp(io) {
  const app = express();

  app.use(cors({
    origin: env.socketCorsOrigin,
    credentials: true,
  }));

  app.use('/api/webhooks/meta', express.json({ limit: '10mb' }));
  app.use(express.json({ limit: '10mb' }));

  app.use('/api', createApiRouter(io));

  app.use((error, _req, res, _next) => {
    logger.error('Unhandled request error', {
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      error: error.message || 'Internal server error',
    });
  });

  return app;
}
