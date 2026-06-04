import http from 'http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { authenticateSocket } from './services/authService.js';
import { startCampaignDispatcher } from './services/campaignDispatcher.js';
import { logger } from './utils/logger.js';

const io = new Server({
  cors: {
    origin: env.socketCorsOrigin,
    credentials: true,
  },
});

const app = createApp(io);
const httpServer = http.createServer(app);
io.attach(httpServer);

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

startCampaignDispatcher(io);

httpServer.listen(env.port, () => {
  logger.info(`JJEWA backend listening on port ${env.port}`);
});
