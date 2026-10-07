import { createHash } from 'node:crypto';
import { claimNextWebhookEvent, completeWebhookEvent, enqueueWebhookEvent, retryWebhookEvent } from '../repositories/webhookEventRepository.js';
import { logger } from '../utils/logger.js';
import { handleMetaWebhook } from './webhookService.js';

export function webhookEventKey(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export async function enqueueMetaWebhook(payload) {
  return enqueueWebhookEvent(webhookEventKey(payload), payload);
}

export function startWebhookProcessor(io, intervalMs = 150) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (let count = 0; count < 50; count += 1) {
        const event = await claimNextWebhookEvent();
        if (!event) break;
        try {
          await handleMetaWebhook(JSON.parse(event.payload_json), io);
          await completeWebhookEvent(event.webhook_event_id);
        } catch (error) {
          await retryWebhookEvent(event.webhook_event_id, event.attempts, error);
          logger.error('Webhook event processing failed', { eventId: event.webhook_event_id, attempts: event.attempts, message: error.message });
        }
      }
    } catch (error) {
      logger.error('Webhook processor poll failed', { message: error.message });
    } finally {
      running = false;
    }
  };
  void tick();
  return setInterval(tick, intervalMs);
}
