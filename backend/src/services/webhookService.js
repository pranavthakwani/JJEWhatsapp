import * as repo from './chatRepository.js';
import { sendMediaMessage, sendTextMessage } from './metaCloudService.js';
import { buildMessagePreview, extractInboundMessageParts, toDateFromUnixSeconds } from '../utils/messageFormat.js';
import { logger } from '../utils/logger.js';

function mapStatus(status) {
  switch (status) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
      return 'failed';
    default:
      return 'sent';
  }
}

function isPositiveOptInReply(text) {
  if (!text) return false;
  return String(text).trim().toLowerCase() === 'yes';
}

function formatStatusErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return null;

  return errors
    .map((error) => {
      const details = [
        error.title,
        error.message,
        error.error_data?.details,
        error.code ? `code ${error.code}` : null,
      ].filter(Boolean);

      return [...new Set(details)].join(' - ');
    })
    .filter(Boolean)
    .join('; ') || null;
}

function isMediaCampaign(campaign) {
  return ['image', 'video', 'audio', 'document'].includes(campaign?.mode);
}

async function sendDeferredCampaignMessage({ number, campaign, contact }) {
  if (isMediaCampaign(campaign)) {
    return sendMediaMessage({
      number,
      to: contact.waId,
      mediaType: campaign.mode,
      mediaId: campaign.mediaId,
      caption: campaign.mode === 'audio' ? null : campaign.bodyText,
      fileName: campaign.fileName,
    });
  }

  return sendTextMessage({
    number,
    to: contact.waId,
    body: campaign.bodyText,
  });
}

function buildDeferredCampaignPayload(campaign) {
  if (isMediaCampaign(campaign)) {
    return {
      messageType: campaign.mode,
      textBody: null,
      caption: campaign.bodyText || null,
      mediaId: campaign.mediaId,
      mimeType: campaign.mimeType,
      fileName: campaign.fileName,
      campaignId: campaign.id,
    };
  }

  return {
    messageType: 'text',
    textBody: campaign.bodyText,
    campaignId: campaign.id,
  };
}

export async function handleMetaWebhook(payload, io) {
  let messagesProcessed = 0;
  let statusesProcessed = 0;

  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const change of changes) {
      if (change.field !== 'messages') continue;

      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const number = await repo.getBusinessNumberByPhoneNumberId(phoneNumberId);
      if (!number) {
        logger.warn('Received webhook for unknown phone_number_id', { phoneNumberId });
        continue;
      }

      const contactsByWaId = new Map(
        (value.contacts || []).map((contact) => [
          contact.wa_id,
          {
            profileName: contact.profile?.name || null,
            waId: contact.wa_id,
          },
        ]),
      );

      for (const message of value.messages || []) {
        const waId = message.from;
        const contactMeta = contactsByWaId.get(waId) || {};
        const contact = await repo.upsertContact({
          waId,
          phoneNumber: waId,
          profileName: contactMeta.profileName,
          inboundAt: new Date(),
        });

        const conversationId = await repo.ensureConversation(number.id, contact.id);
        const parts = extractInboundMessageParts(message);
        const waTimestamp = toDateFromUnixSeconds(message.timestamp) || new Date();

        const inserted = await repo.insertMessage({
          conversationId,
          phoneNumberId: number.id,
          contactId: contact.id,
          direction: 'inbound',
          messageType: parts.messageType,
          waMessageId: message.id,
          parentWaMessageId: parts.parentWaMessageId,
          textBody: parts.textBody,
          caption: parts.caption,
          mediaId: parts.mediaId,
          mimeType: parts.mimeType,
          fileName: parts.fileName,
          status: 'received',
          waTimestamp,
        });

        await repo.touchConversation({
          conversationId,
          messageId: inserted.id,
          preview: buildMessagePreview({
            textBody: inserted.textBody,
            caption: inserted.caption,
            messageType: inserted.messageType,
          }),
          timestamp: waTimestamp,
          unreadIncrement: 1,
        });

        const conversation = await repo.getConversationById(conversationId);
        io.emit('conversation:updated', conversation);
        io.emit('message:created', inserted);

        if (isPositiveOptInReply(inserted.textBody)) {
          await repo.setContactOptInState(contact.id, {
            status: 'opted_in',
            keyword: inserted.textBody,
            source: 'user-reply',
            timestamp: waTimestamp,
          });

          const pendingRecipients = await repo.getPendingOptInRecipientsForContact({
            phoneNumberId: number.id,
            contactId: contact.id,
          });

          for (const item of pendingRecipients) {
            if (!item.campaign?.bodyText && !item.campaign?.mediaId) continue;

            try {
              const sendResult = await sendDeferredCampaignMessage({
                number,
                campaign: item.campaign,
                contact,
              });

              const outboundMessage = await repo.createConversationMessageFromSend({
                conversationId,
                phoneNumberId: number.id,
                contactId: contact.id,
                responseMessageId: sendResult.messageId,
                payload: buildDeferredCampaignPayload(item.campaign),
              });

              await repo.markCampaignRecipientSent({
                recipientId: item.recipient.id,
                contactId: contact.id,
                conversationId,
                waMessageId: outboundMessage.waMessageId,
                optedInAt: waTimestamp,
              });

              await repo.refreshCampaignCounts(item.campaign.id);
              await repo.completeCampaignIfFinished(item.campaign.id);

              const updatedCampaign = await repo.getCampaignById(item.campaign.id);
              const updatedConversation = await repo.getConversationById(conversationId);

              io.emit('message:created', outboundMessage);
              io.emit('conversation:updated', updatedConversation);
              io.emit('campaign:updated', updatedCampaign);
            } catch (error) {
              logger.error('Deferred opt-in campaign send failed', {
                campaignId: item.campaign.id,
                recipientId: item.recipient.id,
                error: error.message,
              });

              await repo.markCampaignRecipientFailed({
                recipientId: item.recipient.id,
                errorMessage: error.message,
              });
            }
          }
        }

        messagesProcessed += 1;
      }

      for (const statusEvent of value.statuses || []) {
        const mappedStatus = mapStatus(statusEvent.status);
        const errorMessage = formatStatusErrors(statusEvent.errors);

        logger.info('Meta message status received', {
          waMessageId: statusEvent.id,
          status: statusEvent.status,
          recipientId: statusEvent.recipient_id,
          errorMessage,
        });

        const updated = await repo.updateMessageStatusByWaMessageId({
          waMessageId: statusEvent.id,
          status: mappedStatus,
          statusAt: toDateFromUnixSeconds(statusEvent.timestamp) || new Date(),
          errorMessage,
        });

        if (updated) {
          io.emit('message:status', updated);
          if (mappedStatus === 'failed') {
            const conversation = await repo.getConversationById(updated.conversationId);
            io.emit('conversation:updated', conversation);
          }
          if (updated.campaignId) {
            const campaign = await repo.getCampaignById(updated.campaignId);
            io.emit('campaign:updated', campaign);
          }
        } else {
          logger.warn('Meta status did not match any stored message', {
            waMessageId: statusEvent.id,
            status: statusEvent.status,
          });
        }

        statusesProcessed += 1;
      }
    }
  }

  return {
    messagesProcessed,
    statusesProcessed,
  };
}
