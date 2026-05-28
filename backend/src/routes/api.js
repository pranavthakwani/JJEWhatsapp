import express from 'express';
import * as repo from '../services/chatRepository.js';
import { downloadMediaContent, listMessageTemplates, markMessageAsRead, sendMediaMessage, sendReactionMessage, sendTemplateMessage, sendTextMessage, uploadMedia } from '../services/metaCloudService.js';
import { parseBusinessDirectoryWorkbook, parseUploadedWorkbook } from '../services/businessContactDirectory.js';
import { handleMetaWebhook } from '../services/webhookService.js';
import { buildMessagePreview, normaliseRecipientWaId } from '../utils/messageFormat.js';
import { logger } from '../utils/logger.js';

function isApprovedTemplate(template) {
  return String(template?.status || '').toLowerCase() === 'approved';
}

function findTemplateByName(templates, name) {
  if (!name) return null;
  return templates.find((template) => template.templateName === name) || null;
}

function findTemplateByKeywords(templates, includeKeywords, excludeKeywords = []) {
  return templates.find((template) => {
    const name = String(template.templateName || '').toLowerCase();
    return includeKeywords.some((keyword) => name.includes(keyword))
      && !excludeKeywords.some((keyword) => name.includes(keyword));
  }) || null;
}

function normaliseContactInput(countryCode, phoneNumber) {
  const rawPhoneNumber = String(phoneNumber || '').trim();
  const phoneDigits = rawPhoneNumber.replace(/\D/g, '');
  const countryDigits = String(countryCode || '').replace(/\D/g, '');

  if (!phoneDigits) return null;
  if (rawPhoneNumber.startsWith('+')) return normaliseRecipientWaId(phoneDigits);
  if (phoneDigits.length === 10 && countryDigits) {
    return normaliseRecipientWaId(`${countryDigits}${phoneDigits}`);
  }

  return normaliseRecipientWaId(phoneDigits);
}

async function resolveTextBroadcastTemplates(phoneNumberId, body) {
  const templates = (await repo.listTemplates(phoneNumberId)).filter(isApprovedTemplate);
  const envInitialName = process.env.OPT_IN_INITIAL_TEMPLATE_NAME || process.env.INITIAL_OPT_IN_TEMPLATE_NAME || '';
  const envFollowupName = process.env.OPT_IN_FOLLOWUP_TEMPLATE_NAME || process.env.FOLLOWUP_OPT_IN_TEMPLATE_NAME || '';

  const initialTemplate = findTemplateByName(templates, body.initialTemplateName || envInitialName)
    || findTemplateByKeywords(templates, ['initial', 'first', 'welcome', 'start', 'opt'], ['follow'])
    || templates[0]
    || null;

  const followupTemplate = findTemplateByName(templates, body.followupTemplateName || envFollowupName)
    || findTemplateByKeywords(templates, ['follow', 'reminder', 'again'])
    || templates.find((template) => template.templateName !== initialTemplate?.templateName)
    || initialTemplate;

  return {
    initialTemplateName: body.initialTemplateName || initialTemplate?.templateName || null,
    followupTemplateName: body.followupTemplateName || followupTemplate?.templateName || null,
    initialTemplateLanguage: initialTemplate?.language || process.env.OPT_IN_TEMPLATE_LANGUAGE || 'en',
    followupTemplateLanguage: followupTemplate?.language || initialTemplate?.language || process.env.OPT_IN_TEMPLATE_LANGUAGE || 'en',
    templateLanguage: body.templateLanguage || initialTemplate?.language || process.env.OPT_IN_TEMPLATE_LANGUAGE || 'en',
  };
}

function resolveOptInTemplateKind(conversation, requestedKind) {
  if (requestedKind === 'intro' || requestedKind === 'followup') return requestedKind;

  const status = String(conversation.contactOptInStatus || '').toLowerCase();
  const hasPriorPrompt = Boolean(
    conversation.contactLastOptInPromptAt ||
    conversation.contactLastOptInTemplateName ||
    ['pending_initial', 'pending_followup', 'opted_in'].includes(status),
  );

  return hasPriorPrompt ? 'followup' : 'intro';
}

export function createApiRouter(io) {
  const router = express.Router();

  router.get('/health', async (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/bootstrap', async (_req, res, next) => {
    try {
      res.json(await repo.getBootstrapData());
    } catch (error) {
      next(error);
    }
  });

  router.get('/business-numbers', async (_req, res, next) => {
    try {
      res.json(await repo.listBusinessNumbers());
    } catch (error) {
      next(error);
    }
  });

  router.get('/conversations', async (req, res, next) => {
    try {
      const phoneNumberId = req.query.phoneNumberId ? Number(req.query.phoneNumberId) : null;
      const limit = req.query.limit ? Number(req.query.limit) : 40;
      const payload = await repo.listConversations({
        phoneNumberId,
        search: req.query.search?.toString() || '',
        limit,
        cursor: req.query.cursor?.toString() || null,
      });

      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get('/conversations/:conversationId', async (req, res, next) => {
    try {
      res.json(await repo.getConversationById(Number(req.params.conversationId)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/conversations/:conversationId/messages', async (req, res, next) => {
    try {
      const conversationId = Number(req.params.conversationId);
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      res.json(await repo.listMessages({
        conversationId,
        limit,
        cursor: req.query.cursor?.toString() || null,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/conversations/:conversationId/read', async (req, res, next) => {
    try {
      const conversationId = Number(req.params.conversationId);
      const conversation = await repo.getConversationById(conversationId);
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      const number = await repo.getBusinessNumberById(conversation.phoneNumberId);
      const inboundReadLimit = Math.max(1, Math.min(Number(conversation.unreadCount || 1), 20));
      const inboundMessageIds = [...new Set(await repo.listRecentInboundWaMessageIds(conversationId, inboundReadLimit))];

      if (number && inboundMessageIds.length > 0) {
        const readResults = await Promise.allSettled(
          inboundMessageIds.map((messageId) => markMessageAsRead({ number, messageId })),
        );
        const failedReads = readResults.filter((result) => result.status === 'rejected');

        if (failedReads.length > 0) {
          logger.warn('Some Meta read receipts failed', {
            conversationId,
            failedCount: failedReads.length,
          });
        }
      }

      await repo.markConversationRead(conversationId);
      const updatedConversation = await repo.getConversationById(conversationId);
      io.emit('conversation:updated', updatedConversation);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/conversations/:conversationId/clear', async (req, res, next) => {
    try {
      const conversation = await repo.clearConversation(Number(req.params.conversationId));
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      io.emit('conversation:updated', conversation);
      res.json(conversation);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/conversations/:conversationId', async (req, res, next) => {
    try {
      const conversation = await repo.getConversationById(Number(req.params.conversationId));
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      await repo.archiveConversation(Number(req.params.conversationId));
      io.emit('conversation:deleted', { id: conversation.id, phoneNumberId: conversation.phoneNumberId });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/conversations/start', async (req, res, next) => {
    try {
      const body = req.body || {};
      const phoneNumberId = Number(body.phoneNumberId);
      const contactId = Number(body.contactId);

      if (!phoneNumberId || !contactId) {
        res.status(400).json({ error: 'phoneNumberId and contactId are required' });
        return;
      }

      const conversationId = await repo.ensureConversation(phoneNumberId, contactId);
      res.status(201).json(await repo.getConversationById(conversationId));
    } catch (error) {
      next(error);
    }
  });

  router.post('/conversations/:conversationId/opt-in', async (req, res, next) => {
    try {
      const conversation = await repo.getConversationById(Number(req.params.conversationId));
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      const number = await repo.getBusinessNumberById(conversation.phoneNumberId);
      if (!number) {
        res.status(404).json({ error: 'Business number not found' });
        return;
      }

      const templates = await resolveTextBroadcastTemplates(conversation.phoneNumberId, req.body || {});
      const templateKind = resolveOptInTemplateKind(conversation, req.body?.templateKind);
      const selectedTemplateName = templateKind === 'followup'
        ? templates.followupTemplateName
        : templates.initialTemplateName;
      const selectedTemplateLanguage = templateKind === 'followup'
        ? templates.followupTemplateLanguage
        : templates.initialTemplateLanguage;
      const pendingStatus = templateKind === 'followup' ? 'pending_followup' : 'pending_initial';

      if (!selectedTemplateName) {
        res.status(400).json({
          error: 'No approved opt-in template found. Sync approved templates or set OPT_IN_INITIAL_TEMPLATE_NAME / OPT_IN_FOLLOWUP_TEMPLATE_NAME in backend env.',
        });
        return;
      }

      const sendResult = await sendTemplateMessage({
        number,
        to: conversation.contactWaId,
        templateName: selectedTemplateName,
        languageCode: req.body?.templateLanguage || selectedTemplateLanguage,
        components: [],
      });

      const message = await repo.createConversationMessageFromSend({
        conversationId: conversation.id,
        phoneNumberId: conversation.phoneNumberId,
        contactId: conversation.contactId,
        responseMessageId: sendResult.messageId,
        payload: {
          messageType: 'template',
          templateName: selectedTemplateName,
          templateLanguage: req.body?.templateLanguage || selectedTemplateLanguage,
        },
      });

      await repo.setContactOptInState(conversation.contactId, {
        status: pendingStatus,
        templateName: selectedTemplateName,
        source: `manual-chat-${templateKind}`,
        timestamp: new Date(),
      });

      const updatedConversation = await repo.getConversationById(conversation.id);
      io.emit('message:created', message);
      io.emit('conversation:updated', updatedConversation);

      res.json({ message, conversation: updatedConversation });
    } catch (error) {
      next(error);
    }
  });

  router.post('/conversations/:conversationId/messages', async (req, res, next) => {
    try {
      const conversation = await repo.getConversationById(Number(req.params.conversationId));
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      const number = await repo.getBusinessNumberById(conversation.phoneNumberId);
      if (!number) {
        res.status(404).json({ error: 'Business number not found' });
        return;
      }

      const {
        type = 'text',
        text,
        mediaId,
        caption,
        mimeType,
        fileName,
        templateName,
        templateLanguage = 'en',
        templateParams = [],
        replyToWaMessageId = null,
        emoji = null,
      } = req.body || {};

      let sendResult;
      if (type === 'template') {
        sendResult = await sendTemplateMessage({
          number,
          to: conversation.contactWaId,
          templateName,
          languageCode: templateLanguage,
          components: templateParams.length > 0
            ? [
                {
                  type: 'body',
                  parameters: templateParams.map((value) => ({
                    type: 'text',
                    text: String(value),
                  })),
                },
              ]
            : [],
        });
      } else if (type === 'image' || type === 'document' || type === 'video' || type === 'audio') {
        sendResult = await sendMediaMessage({
          number,
          to: conversation.contactWaId,
          mediaType: type,
          mediaId,
          caption,
          fileName,
          replyToWaMessageId,
        });
      } else if (type === 'reaction') {
        if (!replyToWaMessageId || !emoji) {
          res.status(400).json({ error: 'replyToWaMessageId and emoji are required for reactions' });
          return;
        }

        sendResult = await sendReactionMessage({
          number,
          to: conversation.contactWaId,
          emoji,
          replyToWaMessageId,
        });
      } else {
        sendResult = await sendTextMessage({
          number,
          to: conversation.contactWaId,
          body: text,
          replyToWaMessageId,
        });
      }

      const message = await repo.createConversationMessageFromSend({
        conversationId: conversation.id,
        phoneNumberId: conversation.phoneNumberId,
        contactId: conversation.contactId,
        responseMessageId: sendResult.messageId,
        payload: {
          messageType: type,
          textBody: text,
          caption,
          mediaId,
          mimeType,
          fileName,
          replyToWaMessageId,
          textBody: type === 'reaction' ? emoji : text,
          templateName,
          templateLanguage,
          templateParams,
        },
      });

      const updatedConversation = await repo.getConversationById(conversation.id);
      io.emit('message:created', message);
      io.emit('conversation:updated', updatedConversation);

      res.json(message);
    } catch (error) {
      next(error);
    }
  });

  router.post('/media/upload/:phoneNumberId', express.raw({ type: '*/*', limit: '32mb' }), async (req, res, next) => {
    try {
      const number = await repo.getBusinessNumberById(Number(req.params.phoneNumberId));
      if (!number) {
        res.status(404).json({ error: 'Business number not found' });
        return;
      }

      const mimeType = req.headers['x-mime-type']?.toString() || 'application/octet-stream';
      const fileName = req.headers['x-file-name']?.toString() || 'upload.bin';

      const mediaId = await uploadMedia({
        number,
        buffer: req.body,
        mimeType,
        fileName,
      });

      res.json({ mediaId });
    } catch (error) {
      next(error);
    }
  });

  router.get('/contacts/search', async (req, res, next) => {
    try {
      const query = req.query.q?.toString() || '';
      res.json(await repo.searchContacts(query));
    } catch (error) {
      next(error);
    }
  });

  router.get('/contacts/page', async (req, res, next) => {
    try {
      const search = req.query.q?.toString() || '';
      const limit = req.query.limit ? Number(req.query.limit) : 300;
      const cursor = req.query.cursor?.toString() || null;
      res.json(await repo.listContactsPage({ search, limit, cursor }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/contacts', async (req, res, next) => {
    try {
      const search = req.query.q?.toString() || '';
      const limit = req.query.limit ? Number(req.query.limit) : 250;
      res.json(await repo.listContacts({ search, limit }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/contacts', async (req, res, next) => {
    try {
      const body = req.body || {};
      const waId = body.waId
        ? normaliseRecipientWaId(body.waId)
        : normaliseContactInput(body.countryCode, body.phoneNumber);
      const name = String(body.name || '').trim();

      if (!waId) {
        res.status(400).json({ error: 'Valid phone number is required' });
        return;
      }

      const contact = await repo.upsertContact({
        waId,
        phoneNumber: waId,
        profileName: name || waId,
        businessDirectoryName: name || null,
      });

      res.status(201).json(contact);
    } catch (error) {
      next(error);
    }
  });

  router.post('/contacts/import/business-directory', async (_req, res, next) => {
    try {
      const { workbookPath, contacts } = parseBusinessDirectoryWorkbook();
      const imported = await repo.bulkUpsertContacts(contacts.map((contact) => ({
        ...contact,
        businessDirectoryName: contact.profileName,
      })));

      res.json({
        workbookPath,
        importedCount: imported.length,
        contacts: imported,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/contacts/parse-spreadsheet', express.raw({ type: '*/*', limit: '16mb' }), async (req, res, next) => {
    try {
      const sheetName = req.headers['x-sheet-name']?.toString() || null;
      res.json(parseUploadedWorkbook(Buffer.from(req.body), { sheetName }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/contact-lists', async (req, res, next) => {
    try {
      const phoneNumberId = req.query.phoneNumberId ? Number(req.query.phoneNumberId) : null;
      res.json(await repo.listContactLists(phoneNumberId));
    } catch (error) {
      next(error);
    }
  });

  router.get('/contact-lists/:listId', async (req, res, next) => {
    try {
      res.json(await repo.getContactListById(Number(req.params.listId)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/contact-lists', async (req, res, next) => {
    try {
      const body = req.body || {};
      const list = await repo.createContactList({
        phoneNumberId: Number(body.phoneNumberId),
        name: String(body.name || '').trim(),
        source: body.source || 'manual',
        contacts: Array.isArray(body.contacts) ? body.contacts : [],
      });

      res.status(201).json(list);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/contact-lists/:listId/members', async (req, res, next) => {
    try {
      const body = req.body || {};
      const contacts = Array.isArray(body.contacts) ? body.contacts : [];
      res.json(await repo.replaceContactListMembers({
        listId: Number(req.params.listId),
        contacts,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/contact-lists/:listId/clear', async (req, res, next) => {
    try {
      const list = await repo.clearContactList(Number(req.params.listId));
      if (!list) {
        res.status(404).json({ error: 'Broadcast list not found' });
        return;
      }

      io.emit('contact-list:updated', list);
      res.json(list);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/contact-lists/:listId', async (req, res, next) => {
    try {
      const list = await repo.getContactListById(Number(req.params.listId));
      if (!list) {
        res.status(404).json({ error: 'Broadcast list not found' });
        return;
      }

      await repo.archiveContactList(Number(req.params.listId));
      io.emit('contact-list:deleted', { id: list.id, phoneNumberId: list.phoneNumberId });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/templates', async (req, res, next) => {
    try {
      const phoneNumberId = req.query.phoneNumberId ? Number(req.query.phoneNumberId) : null;
      res.json(await repo.listTemplates(phoneNumberId));
    } catch (error) {
      next(error);
    }
  });

  router.get('/messages/:messageId/media', async (req, res, next) => {
    try {
      const message = await repo.getMessageById(Number(req.params.messageId));
      if (!message?.mediaId) {
        res.status(404).json({ error: 'Media not found' });
        return;
      }

      const number = await repo.getBusinessNumberById(message.phoneNumberId);
      if (!number) {
        res.status(404).json({ error: 'Business number not found' });
        return;
      }

      const media = await downloadMediaContent({
        number,
        mediaId: message.mediaId,
      });

      res.setHeader('Content-Type', media.mimeType);
      if (message.fileName) {
        res.setHeader('Content-Disposition', `inline; filename="${message.fileName}"`);
      }
      res.send(Buffer.from(media.buffer));
    } catch (error) {
      next(error);
    }
  });

  router.post('/templates/sync', async (req, res, next) => {
    try {
      const phoneNumberId = Number(req.body.phoneNumberId);
      const number = await repo.getBusinessNumberById(phoneNumberId);
      if (!number) {
        res.status(404).json({ error: 'Business number not found' });
        return;
      }

      const templates = await listMessageTemplates(number);
      const mapped = templates.map((template) => ({
        id: template.id,
        name: template.name,
        category: template.category,
        language: template.language,
        status: template.status,
        headerFormat: template.components?.find((component) => component.type === 'HEADER')?.format || null,
        bodyText: template.components?.find((component) => component.type === 'BODY')?.text || null,
        footerText: template.components?.find((component) => component.type === 'FOOTER')?.text || null,
        buttons: template.components?.filter((component) => component.type === 'BUTTONS') || [],
      }));

      await repo.replaceTemplates(phoneNumberId, mapped);
      res.json(await repo.listTemplates(phoneNumberId));
    } catch (error) {
      next(error);
    }
  });

  router.get('/campaigns', async (_req, res, next) => {
    try {
      const contactListId = _req.query.contactListId ? Number(_req.query.contactListId) : null;
      if (contactListId) {
        res.json(await repo.listCampaignsByContactList(contactListId, 50, {
          includeRecipients: _req.query.includeRecipients === 'true',
        }));
        return;
      }

      res.json(await repo.listCampaigns());
    } catch (error) {
      next(error);
    }
  });

  router.get('/campaigns/:campaignId', async (req, res, next) => {
    try {
      res.json(await repo.getCampaignById(Number(req.params.campaignId)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/campaigns', async (req, res, next) => {
    try {
      const body = req.body || {};
      const mode = body.mode || 'text';
      let recipients = Array.isArray(body.recipients)
        ? body.recipients
            .map((recipient) => ({
              waId: normaliseRecipientWaId(recipient.waId || recipient.phoneNumber || recipient.number || recipient),
              name: recipient.name || null,
              contactId: recipient.contactId || null,
              contactListMemberId: recipient.contactListMemberId || null,
            }))
            .filter((recipient) => recipient.waId)
        : [];

      const contactListId = body.contactListId ? Number(body.contactListId) : null;
      if (contactListId) {
        const contactList = await repo.getContactListById(contactListId);
        if (!contactList) {
          res.status(404).json({ error: 'Contact list not found' });
          return;
        }

        recipients = contactList.members.map((member) => ({
          waId: normaliseRecipientWaId(member.contact?.waId || member.contact?.phoneNumber),
          name: member.contact?.profileName || member.contact?.businessDirectoryName || null,
          contactId: member.contact?.id || null,
          contactListMemberId: member.id,
        })).filter((recipient) => recipient.waId);
      }

      if (recipients.length === 0) {
        res.status(400).json({ error: 'At least one recipient is required' });
        return;
      }

      if (mode === 'text' && !String(body.bodyText || '').trim()) {
        res.status(400).json({ error: 'bodyText is required for text campaigns' });
        return;
      }

      if (mode === 'template' && !String(body.templateName || '').trim()) {
        res.status(400).json({ error: 'templateName is required for template campaigns' });
        return;
      }

      const textBroadcastTemplates = mode === 'text'
        ? await resolveTextBroadcastTemplates(Number(body.phoneNumberId), body)
        : {
            initialTemplateName: body.initialTemplateName || null,
            followupTemplateName: body.followupTemplateName || null,
            templateLanguage: body.templateLanguage || 'en',
          };

      if (mode === 'text' && !textBroadcastTemplates.initialTemplateName) {
        res.status(400).json({
          error: 'No approved opt-in template found. Sync approved templates or set OPT_IN_INITIAL_TEMPLATE_NAME in backend env.',
        });
        return;
      }

      const campaign = await repo.createCampaign({
        phoneNumberId: Number(body.phoneNumberId),
        contactListId,
        title: body.title || `Campaign ${new Date().toLocaleString('en-IN')}`,
        mode,
        bodyText: body.bodyText || null,
        templateName: body.templateName || null,
        initialTemplateName: textBroadcastTemplates.initialTemplateName,
        followupTemplateName: textBroadcastTemplates.followupTemplateName,
        templateLanguage: textBroadcastTemplates.templateLanguage,
        templateParams: Array.isArray(body.templateParams) ? body.templateParams : [],
        recipients,
      });

      const detail = await repo.getCampaignById(campaign.id);
      io.emit('campaign:updated', detail);
      res.status(201).json(detail);
    } catch (error) {
      next(error);
    }
  });

  router.get('/webhooks/meta', async (req, res, next) => {
    try {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      const number = token ? await repo.getBusinessNumberByVerifyToken(String(token)) : null;

      if (mode === 'subscribe' && number && token === number.verifyToken) {
        res.status(200).send(challenge);
        return;
      }

      res.status(403).send('Forbidden');
    } catch (error) {
      next(error);
    }
  });

  router.post('/webhooks/meta', async (req, res, next) => {
    try {
      const result = await handleMetaWebhook(req.body, io);
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
