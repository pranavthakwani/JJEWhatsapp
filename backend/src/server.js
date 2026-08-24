import http from 'http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { authenticateSocket } from './services/authService.js';
import { logger } from './utils/logger.js';
import { checkDatabase, closePool } from './config/db.js';
import { startOutboxRelay } from './services/outboxRelay.js';

const io = new Server({
  cors: {
    origin: env.socketCorsOrigin,
    credentials: true,
  },
});

const app = createApp(io);
const httpServer = http.createServer(app);
io.attach(httpServer);
let outboxRelay = null;

io.use(async (socket, next) => {
  try {
    socket.auth = await authenticateSocket(socket);
    next();
  } catch (error) {
    next(error);
  }
});

io.on('connection', (socket) => {
  logger.info('Socket connected', { socketId: socket.id });

  socket.on('disconnect', () => {
    logger.info('Socket disconnected', { socketId: socket.id });
  });
});

async function start() {
  await checkDatabase();
  outboxRelay = startOutboxRelay(io);
  httpServer.listen(env.port, () => {
    logger.info(`JJEWA backend listening on port ${env.port}`);
  });
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (outboxRelay) clearInterval(outboxRelay);
  logger.info('Graceful shutdown started', { signal });
  await new Promise((resolve) => httpServer.close(resolve));
  await closePool();
  logger.info('Graceful shutdown completed', { signal });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => logger.error('Unhandled promise rejection', { message: error?.message || String(error) }));
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { message: error.message });
  void shutdown('uncaughtException').finally(() => { process.exitCode = 1; });
});

start().catch((error) => {
  logger.error('Backend startup failed', { message: error.message });
  process.exitCode = 1;
});
