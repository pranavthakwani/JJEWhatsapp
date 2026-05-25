import * as repo from './chatRepository.js';
import { sendTemplateMessage, sendTextMessage } from './metaCloudService.js';
import { logger } from '../utils/logger.js';

function hasOpenCustomerWindow(contact) {
  if (!contact?.lastInboundAt) return false;
  const lastInboundAt = new Date(contact.lastInboundAt).getTime();
  return Number.isFinite(lastInboundAt) && (Date.now() - lastInboundAt) <= 24 * 60 * 60 * 1000;
}

function shouldSendFollowupOptInTemplate(contact) {
  return ['pending_initial', 'pending_followup', 'opted_in'].includes(contact?.optInStatus);
}

async function processRecipient(number, campaign, recipient, io) {
  const contact = await repo.upsertContact({
    waId: recipient.recipientWaId,
    phoneNumber: recipient.recipientWaId,
    profileName: recipient.recipientName,
    outboundAt: new Date(),
  });

  const conversationId = await repo.ensureConversation(number.id, contact.id);

  let sendResult;
  if (campaign.mode === 'template') {
    const components = Array.isArray(campaign.templateParams) && campaign.templateParams.length > 0
      ? [
          {
            type: 'body',
            parameters: campaign.templateParams.map((value) => ({
              type: 'text',
              text: String(value),
            })),
          },
        ]
      : [];

    sendResult = await sendTemplateMessage({
      number,
      to: recipient.recipientWaId,
      templateName: campaign.templateName,
      languageCode: campaign.templateLanguage || 'en',
      components,
    });
  } else {
    if (contact.optInStatus === 'opted_in' && hasOpenCustomerWindow(contact)) {
      sendResult = await sendTextMessage({
        number,
        to: recipient.recipientWaId,
        body: campaign.bodyText,
      });
    } else {
      const shouldUseFollowup = shouldSendFollowupOptInTemplate(contact);
      const templateName = shouldUseFollowup
        ? (campaign.followupTemplateName || campaign.initialTemplateName)
        : campaign.initialTemplateName;

      if (!templateName) {
        throw new Error('No opt-in template configured for this broadcast.');
      }

      sendResult = await sendTemplateMessage({
        number,
        to: recipient.recipientWaId,
        templateName,
        languageCode: campaign.templateLanguage || 'en',
        components: [],
      });

      const promptMessage = await repo.createConversationMessageFromSend({
        conversationId,
        phoneNumberId: number.id,
        contactId: contact.id,
        responseMessageId: sendResult.messageId,
        payload: {
          messageType: 'template',
          templateName,
          templateLanguage: campaign.templateLanguage,
          campaignId: campaign.id,
        },
      });

      const nextStatus = shouldUseFollowup ? 'optin_followup_sent' : 'optin_initial_sent';

      await repo.markCampaignRecipientAwaitingOptIn({
        recipientId: recipient.id,
        contactId: contact.id,
        conversationId,
        promptTemplateName: templateName,
        nextStatus,
        requestedAt: new Date(),
      });

      await repo.setContactOptInState(contact.id, {
        status: shouldUseFollowup ? 'pending_followup' : 'pending_initial',
        templateName,
        source: 'campaign',
        timestamp: new Date(),
      });

      const conversation = await repo.getConversationById(conversationId);
      io.emit('message:created', promptMessage);
      io.emit('conversation:updated', conversation);
      return;
    }
  }

  const message = await repo.createConversationMessageFromSend({
    conversationId,
    phoneNumberId: number.id,
    contactId: contact.id,
    responseMessageId: sendResult.messageId,
    payload: {
      messageType: campaign.mode === 'template' ? 'template' : 'text',
      textBody: campaign.bodyText,
      templateName: campaign.templateName,
      templateLanguage: campaign.templateLanguage,
      templateParams: campaign.templateParams,
      campaignId: campaign.id,
    },
  });

  await repo.markCampaignRecipientSent({
    recipientId: recipient.id,
    contactId: contact.id,
    conversationId,
    waMessageId: message.waMessageId,
  });

  const conversation = await repo.getConversationById(conversationId);
  io.emit('message:created', message);
  io.emit('conversation:updated', conversation);
}

export function startCampaignDispatcher(io, intervalMs = 3000) {
  let running = false;

  return setInterval(async () => {
    if (running) return;
    running = true;

    try {
      const campaigns = await repo.getDispatchableCampaigns(3);

      for (const campaign of campaigns) {
        const number = await repo.getBusinessNumberById(campaign.phoneNumberId);
        if (!number) continue;

        await repo.markCampaignSending(campaign.id);
        const recipients = await repo.getQueuedCampaignRecipients(campaign.id, 12);

        for (const recipient of recipients) {
          try {
            await processRecipient(number, campaign, recipient, io);
          } catch (error) {
            logger.error('Campaign recipient send failed', {
              campaignId: campaign.id,
              recipientId: recipient.id,
              error: error.message,
            });

            await repo.markCampaignRecipientFailed({
              recipientId: recipient.id,
              errorMessage: error.message,
            });
          }
        }

        await repo.refreshCampaignCounts(campaign.id);
        await repo.completeCampaignIfFinished(campaign.id);

        const updated = await repo.getCampaignById(campaign.id);
        io.emit('campaign:updated', updated);
      }
    } catch (error) {
      logger.error('Campaign dispatcher tick failed', { error: error.message });
    } finally {
      running = false;
    }
  }, intervalMs);
}
