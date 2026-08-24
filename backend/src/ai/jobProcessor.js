import { env } from '../config/env.js';
import { resolvePendingOfferingPrices, saveMessageAnalysis } from '../repositories/analysisRepository.js';
import { claimBackgroundJobs, completeBackgroundJob, failBackgroundJob, isAiExtractionEnabled } from '../repositories/jobRepository.js';
import { getMessageById } from '../repositories/messageRepository.js';
import { logger } from '../utils/logger.js';
import { extractWholesaleIntent, normalizeExtraction } from './extractionService.js';
import { extractPrices, isLikelyPriceFollowup } from './priceParser.js';

async function tryDeterministicPriceResolution(message) {
  const text = String(message?.textBody || message?.caption || '').trim();
  if (message?.direction !== 'inbound' || !isLikelyPriceFollowup(text)) return false;
  const resolution = await resolvePendingOfferingPrices({
    messageId: message.id,
    conversationId: message.conversationId,
    parentProviderMessageId: message.parentWaMessageId,
    prices: extractPrices(text),
  });
  await saveMessageAnalysis({
    messageId: message.id,
    extraction: normalizeExtraction({
      isBusinessMessage: resolution.pendingCount > 0,
      classification: resolution.pendingCount > 0 ? 'reply' : 'ignored',
      confidence: 1,
      items: [],
    }),
    model: 'deterministic-price-resolver',
    promptVersion: 'price-followup-v1',
    usage: {},
  });
  logger.info('Price follow-up handled without an AI request', { messageId: message.id, ...resolution });
  return true;
}

export function startAiJobProcessor(workerId, intervalMs = 2000) {
  let running = false;
  let configurationWarningLogged = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      if (!(await isAiExtractionEnabled())) return;
      if (!env.ai.apiKey || !env.ai.model) {
        if (!configurationWarningLogged) {
          logger.error('AI extraction is enabled but provider configuration is incomplete');
          configurationWarningLogged = true;
        }
        return;
      }
      configurationWarningLogged = false;
      const jobs = await claimBackgroundJobs({ workerId, jobType: 'analyze_message', batchSize: 5 });
      for (const job of jobs) {
        try {
          const message = await getMessageById(job.aggregateId);
          if (!message) throw new Error(`Message ${job.aggregateId} was not found.`);
          if (await tryDeterministicPriceResolution(message)) {
            await completeBackgroundJob(job.id);
            continue;
          }
          const analysis = await extractWholesaleIntent(message);
          await saveMessageAnalysis({ messageId: message.id, ...analysis });
          await completeBackgroundJob(job.id);
        } catch (error) {
          await failBackgroundJob(job, error);
          logger.error('AI extraction job failed', { jobId: job.id, messageId: job.aggregateId, error: error.message });
        }
      }
    } catch (error) {
      logger.error('AI job processor poll failed', { error: error.message });
    } finally {
      running = false;
    }
  }, intervalMs);
}
