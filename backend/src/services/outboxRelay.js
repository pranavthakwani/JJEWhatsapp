import { getCampaignById } from '../repositories/campaignRepository.js';
import { getConversationById } from '../repositories/conversationRepository.js';
import { getMessageById } from '../repositories/messageRepository.js';
import { listPendingOutboxEvents, markOutboxFailed, markOutboxPublished } from '../repositories/outboxRepository.js';
import { logger } from '../utils/logger.js';

async function publishEvent(io, event) {
  if (event.aggregateType === 'message') {
    const message = await getMessageById(event.aggregateId);
    if (!message) return;
    io.emit(event.eventType === 'message.status_updated' ? 'message:status' : 'message:created', message);
    const conversation = await getConversationById(message.conversationId);
    if (conversation) io.emit('conversation:updated', conversation);
    if (message.campaignId) {
      const campaign = await getCampaignById(message.campaignId);
      if (campaign) io.emit('campaign:updated', campaign);
    }
  }
}

export function startOutboxRelay(io, intervalMs = 750) {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const events = await listPendingOutboxEvents(100);
      for (const event of events) {
        try {
          await publishEvent(io, event);
          await markOutboxPublished(event.id);
        } catch (error) {
          await markOutboxFailed(event.id, error);
          logger.error('Outbox publish failed', { eventId: event.id, eventType: event.eventType, message: error.message });
        }
      }
    } catch (error) {
      logger.error('Outbox relay poll failed', { message: error.message });
    } finally {
      running = false;
    }
  }, intervalMs);
}
