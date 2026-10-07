import os from 'node:os';
import { checkDatabase, closePool } from './config/db.js';
import { startCampaignDispatcher } from './services/campaignDispatcher.js';
import { logger } from './utils/logger.js';
import { startAiJobProcessor } from './ai/jobProcessor.js';
import { requeueExpiredJobLocks, syncAiExtractionSetting } from './repositories/jobRepository.js';
import { startAgentWorker } from './agent/worker.js';
import { syncAgentSetting } from './agent/repository.js';

const workerId = `${os.hostname()}:${process.pid}`;
let dispatcher = null;
let aiProcessor = null;
let agentProcessor = null;
let lockReaper = null;
let stopping = false;
let startupRetry = null;

async function start() {
  try {
    await checkDatabase();
    await syncAiExtractionSetting();
    await syncAgentSetting();
    await requeueExpiredJobLocks(10);
    dispatcher = startCampaignDispatcher({ emit() {} });
    aiProcessor = startAiJobProcessor(workerId);
    agentProcessor = startAgentWorker(workerId);
    lockReaper = setInterval(() => void requeueExpiredJobLocks(10).catch((error) => logger.error('Expired job lock requeue failed', { error: error.message })), 60_000);
    logger.info('JJEWA worker started', { workerId });
  } catch (error) {
    logger.warn('Worker database unavailable; retrying startup', { workerId, message: error.message });
    if (!stopping) startupRetry = setTimeout(() => void start(), 10_000);
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (dispatcher) clearInterval(dispatcher);
  if (aiProcessor) clearInterval(aiProcessor);
  if (agentProcessor) clearInterval(agentProcessor);
  if (lockReaper) clearInterval(lockReaper);
  if (startupRetry) clearTimeout(startupRetry);
  await closePool();
  logger.info('JJEWA worker stopped', { workerId, signal });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void start();
