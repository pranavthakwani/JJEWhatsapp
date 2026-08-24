import os from 'node:os';
import { checkDatabase, closePool } from './config/db.js';
import { startCampaignDispatcher } from './services/campaignDispatcher.js';
import { logger } from './utils/logger.js';
import { startAiJobProcessor } from './ai/jobProcessor.js';
import { requeueExpiredJobLocks } from './repositories/jobRepository.js';

const workerId = `${os.hostname()}:${process.pid}`;
let dispatcher = null;
let aiProcessor = null;
let lockReaper = null;
let stopping = false;

async function start() {
  await checkDatabase();
  await requeueExpiredJobLocks(10);
  dispatcher = startCampaignDispatcher({ emit() {} });
  aiProcessor = startAiJobProcessor(workerId);
  lockReaper = setInterval(() => void requeueExpiredJobLocks(10).catch((error) => logger.error('Expired job lock requeue failed', { error: error.message })), 60_000);
  logger.info('JJEWA worker started', { workerId });
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (dispatcher) clearInterval(dispatcher);
  if (aiProcessor) clearInterval(aiProcessor);
  if (lockReaper) clearInterval(lockReaper);
  await closePool();
  logger.info('JJEWA worker stopped', { workerId, signal });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

start().catch((error) => {
  logger.error('Worker startup failed', { workerId, message: error.message });
  process.exitCode = 1;
});
