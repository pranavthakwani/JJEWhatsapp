import { refreshConversationPreview } from './conversationRepository.js';
import { getContactById } from './contactRepository.js';
import { refreshCampaignCounts } from './campaignRepository.js';
import { clampInteger, executeProcedure, input, query, sql } from './sqlHelpers.js';
import { mapMessage } from './mappers.js';

const MESSAGE_SELECT = `
  SELECT message.message_id, message.conversation_id, message.phone_number_id, message.contact_id,
         message.direction, message.message_type, message.provider_message_id,
         message.parent_provider_message_id, message.text_body, message.caption,
         message.provider_media_id, message.mime_type, message.file_name,
         message.template_name, message.template_language, message.template_params_json,
         message.campaign_id, message.status, message.error_message, message.provider_timestamp,
         message.sent_at, message.delivered_at, message.read_at, message.failed_at,
         message.starred_at, message.deleted_at, message.created_at, message.updated_at,
         media.storage_provider, media.storage_key, media.size_bytes, media.original_file_name,
         contact.business_name, contact.profile_name, contact.phone_number AS contact_phone, contact.wa_id AS contact_wa_id
  FROM jje.messages message
  LEFT JOIN jje.media_assets media ON media.message_id = message.message_id
  INNER JOIN jje.contacts contact ON contact.contact_id = message.contact_id
`;

function parseCursor(cursor) {
  if (!cursor) return { time: null, id: null };
  const [time, rawId] = String(cursor).split('|');
  const date = new Date(time);
  const id = Number(rawId);
  return Number.isNaN(date.getTime()) ? { time: null, id: null } : { time: date, id: Number.isFinite(id) ? id : null };
}

function makeCursor(time, id) {
  return time ? `${new Date(time).toISOString()}|${id}` : null;
}

export async function insertMessage(message) {
  const result = await query(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @parentMessageId bigint;
    IF @parentProviderMessageId IS NOT NULL
      SELECT @parentMessageId = message_id FROM jje.messages WHERE provider_message_id = @parentProviderMessageId;

    INSERT jje.messages(
      conversation_id, phone_number_id, contact_id, direction, message_type,
      provider_message_id, parent_message_id, parent_provider_message_id,
      text_body, caption, provider_media_id, mime_type, file_name,
      template_name, template_language, template_params_json, campaign_id,
      status, error_message, provider_timestamp, sent_at, delivered_at, read_at, failed_at
    ) VALUES(
      @conversationId, @phoneNumberId, @contactId, @direction, @messageType,
      @providerMessageId, @parentMessageId, @parentProviderMessageId,
      @textBody, @caption, @providerMediaId, @mimeType, @fileName,
      @templateName, @templateLanguage, @templateParamsJson, @campaignId,
      @status, @errorMessage, @providerTimestamp, @sentAt, @deliveredAt, @readAt, @failedAt
    );
    DECLARE @messageId bigint = SCOPE_IDENTITY();

    IF @storageKey IS NOT NULL
      INSERT jje.media_assets(message_id, provider_media_id, storage_provider, storage_key,
        original_file_name, mime_type, size_bytes)
      VALUES(@messageId, @providerMediaId, COALESCE(@storageProvider, 'local'), @storageKey,
        @fileName, COALESCE(@mimeType, 'application/octet-stream'), COALESCE(@mediaSize, 0));

    UPDATE jje.conversations SET
      last_message_id = @messageId,
      last_message_preview = LEFT(COALESCE(NULLIF(@textBody, ''), NULLIF(@caption, ''), CONCAT('[', @messageType, ']')), 500),
      last_message_at = COALESCE(@providerTimestamp, @sentAt, SYSUTCDATETIME()),
      is_archived = 0,
      updated_at = SYSUTCDATETIME()
    WHERE conversation_id = @conversationId;

    IF @direction = 'outbound'
      UPDATE jje.contacts SET last_outbound_at = COALESCE(@sentAt, SYSUTCDATETIME()),
        updated_at = SYSUTCDATETIME() WHERE contact_id = @contactId;

    DECLARE @eventPayload nvarchar(max) = (
      SELECT @messageId AS messageId, @conversationId AS conversationId,
        @phoneNumberId AS phoneNumberId, @contactId AS contactId
      FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
    );
    INSERT jje.outbox_events(event_type, aggregate_type, aggregate_id, payload_json)
    VALUES('message.created', 'message', @messageId, @eventPayload);

    COMMIT TRANSACTION;
    ${MESSAGE_SELECT} WHERE message.message_id = @messageId;`, [
    input('conversationId', sql.BigInt, message.conversationId),
    input('phoneNumberId', sql.BigInt, message.phoneNumberId),
    input('contactId', sql.BigInt, message.contactId),
    input('direction', sql.VarChar(10), message.direction),
    input('messageType', sql.VarChar(30), message.messageType),
    input('providerMessageId', sql.VarChar(255), message.waMessageId || null),
    input('parentProviderMessageId', sql.VarChar(255), message.parentWaMessageId || null),
    input('textBody', sql.NVarChar(sql.MAX), message.textBody || null),
    input('caption', sql.NVarChar(sql.MAX), message.caption || null),
    input('providerMediaId', sql.VarChar(255), message.mediaId || null),
    input('mimeType', sql.NVarChar(255), message.mimeType || null),
    input('fileName', sql.NVarChar(512), message.fileName || null),
    input('templateName', sql.NVarChar(512), message.templateName || null),
    input('templateLanguage', sql.VarChar(20), message.templateLanguage || null),
    input('templateParamsJson', sql.NVarChar(sql.MAX), message.templateParams ? JSON.stringify(message.templateParams) : null),
    input('campaignId', sql.BigInt, message.campaignId || null),
    input('status', sql.VarChar(30), message.status || 'queued'),
    input('errorMessage', sql.NVarChar(2000), message.errorMessage || null),
    input('providerTimestamp', sql.DateTime2(3), message.waTimestamp ? new Date(message.waTimestamp) : null),
    input('sentAt', sql.DateTime2(3), message.sentAt ? new Date(message.sentAt) : null),
    input('deliveredAt', sql.DateTime2(3), message.deliveredAt ? new Date(message.deliveredAt) : null),
    input('readAt', sql.DateTime2(3), message.readAt ? new Date(message.readAt) : null),
    input('failedAt', sql.DateTime2(3), message.failedAt ? new Date(message.failedAt) : null),
    input('storageProvider', sql.VarChar(30), message.storageBucket || null),
    input('storageKey', sql.NVarChar(1000), message.storagePath || null),
    input('mediaSize', sql.BigInt, message.mediaSize || null),
  ]);
  return mapMessage(result.recordset[0]);
}

export async function storeInboundMessage({
  metaPhoneNumberId,
  waId,
  phoneNumber = null,
  profileName = null,
  providerMessageId,
  parentProviderMessageId = null,
  messageType,
  textBody = null,
  caption = null,
  mediaId = null,
  mimeType = null,
  fileName = null,
  providerTimestamp = null,
}) {
  const result = await executeProcedure('jje.usp_InboundMessage_Store', [
    input('MetaPhoneNumberId', sql.VarChar(100), metaPhoneNumberId),
    input('ContactWaId', sql.VarChar(64), waId),
    input('ContactPhoneNumber', sql.VarChar(32), phoneNumber || waId),
    input('ProfileName', sql.NVarChar(240), profileName),
    input('ProviderMessageId', sql.VarChar(255), providerMessageId),
    input('ParentProviderMessageId', sql.VarChar(255), parentProviderMessageId),
    input('MessageType', sql.VarChar(30), messageType),
    input('TextBody', sql.NVarChar(sql.MAX), textBody),
    input('Caption', sql.NVarChar(sql.MAX), caption),
    input('ProviderMediaId', sql.VarChar(255), mediaId),
    input('MimeType', sql.NVarChar(255), mimeType),
    input('FileName', sql.NVarChar(512), fileName),
    input('ProviderTimestamp', sql.DateTime2(3), providerTimestamp ? new Date(providerTimestamp) : new Date()),
  ]);
  const outcome = result.recordset[0];
  const message = await getMessageById(outcome.message_id);
  return {
    message,
    contact: await getContactById(message.contactId),
    wasInserted: Boolean(outcome.was_inserted),
  };
}

export async function listMessages({ conversationId, limit = 50, cursor }) {
  const requestedLimit = clampInteger(limit, 50, 1, 100);
  const parsedCursor = parseCursor(cursor);
  const result = await query(`${MESSAGE_SELECT}
    INNER JOIN jje.conversations selected_conversation ON selected_conversation.conversation_id = message.conversation_id
    WHERE message.conversation_id = @conversationId AND message.deleted_at IS NULL
      AND (selected_conversation.cleared_at IS NULL OR message.created_at > selected_conversation.cleared_at)
      AND (@cursorTime IS NULL OR message.created_at < @cursorTime
           OR (message.created_at = @cursorTime AND message.message_id < @cursorId))
    ORDER BY message.created_at DESC, message.message_id DESC
    OFFSET 0 ROWS FETCH NEXT @take ROWS ONLY;`, [
    input('conversationId', sql.BigInt, conversationId),
    input('cursorTime', sql.DateTime2(3), parsedCursor.time),
    input('cursorId', sql.BigInt, parsedCursor.id),
    input('take', sql.Int, requestedLimit + 1),
  ]);
  const hasMore = result.recordset.length > requestedLimit;
  const rows = result.recordset.slice(0, requestedLimit);
  return {
    items: rows.map(mapMessage).reverse(),
    nextCursor: hasMore && rows.length ? makeCursor(rows.at(-1).created_at, rows.at(-1).message_id) : null,
  };
}

export async function findRecentDuplicateConversationMessage({
  conversationId,
  messageType,
  textBody = null,
  caption = null,
  mediaId = null,
  templateName = null,
  templateLanguage = null,
  replyToWaMessageId = null,
  windowSeconds = 6,
}) {
  const result = await query(`${MESSAGE_SELECT}
    WHERE message.conversation_id = @conversationId
      AND message.direction = 'outbound' AND message.message_type = @messageType
      AND message.deleted_at IS NULL AND message.status <> 'failed'
      AND message.created_at >= DATEADD(second, -@windowSeconds, SYSUTCDATETIME())
      AND ISNULL(message.parent_provider_message_id, '') = ISNULL(@replyToWaMessageId, '')
      AND ISNULL(message.text_body, '') = ISNULL(@textBody, '')
      AND ISNULL(message.caption, '') = ISNULL(@caption, '')
      AND ISNULL(message.provider_media_id, '') = ISNULL(@mediaId, '')
      AND ISNULL(message.template_name, '') = ISNULL(@templateName, '')
      AND ISNULL(message.template_language, '') = ISNULL(@templateLanguage, '')
    ORDER BY message.created_at DESC, message.message_id DESC
    OFFSET 0 ROWS FETCH NEXT 1 ROW ONLY;`, [
    input('conversationId', sql.BigInt, conversationId),
    input('messageType', sql.VarChar(30), messageType),
    input('windowSeconds', sql.Int, clampInteger(windowSeconds, 6, 1, 300)),
    input('replyToWaMessageId', sql.VarChar(255), replyToWaMessageId),
    input('textBody', sql.NVarChar(sql.MAX), textBody),
    input('caption', sql.NVarChar(sql.MAX), caption),
    input('mediaId', sql.VarChar(255), mediaId),
    input('templateName', sql.NVarChar(512), templateName),
    input('templateLanguage', sql.VarChar(20), templateLanguage),
  ]);
  return mapMessage(result.recordset[0]);
}

export async function getMessageById(id) {
  const result = await query(`${MESSAGE_SELECT} WHERE message.message_id = @id;`, [input('id', sql.BigInt, id)]);
  return mapMessage(result.recordset[0]);
}

export async function getMessageByWaMessageId(waMessageId) {
  if (!waMessageId) return null;
  const result = await query(`${MESSAGE_SELECT} WHERE message.provider_message_id = @waMessageId;`, [
    input('waMessageId', sql.VarChar(255), waMessageId),
  ]);
  return mapMessage(result.recordset[0]);
}

export async function updateMessageMediaStorage(messageId, { storageBucket, storagePath, mediaSize, mimeType, fileName }) {
  await query(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    UPDATE jje.messages SET mime_type = COALESCE(@mimeType, mime_type), file_name = COALESCE(@fileName, file_name),
      updated_at = SYSUTCDATETIME() WHERE message_id = @messageId;
    UPDATE jje.media_assets SET storage_provider = @storageProvider, storage_key = @storageKey,
      size_bytes = COALESCE(@mediaSize, size_bytes), mime_type = COALESCE(@mimeType, mime_type),
      original_file_name = COALESCE(@fileName, original_file_name)
    WHERE message_id = @messageId;
    IF @@ROWCOUNT = 0
      INSERT jje.media_assets(message_id, storage_provider, storage_key, original_file_name, mime_type, size_bytes)
      VALUES(@messageId, @storageProvider, @storageKey, @fileName, COALESCE(@mimeType, 'application/octet-stream'), COALESCE(@mediaSize, 0));
    COMMIT TRANSACTION;`, [
    input('messageId', sql.BigInt, messageId),
    input('storageProvider', sql.VarChar(30), storageBucket || 'local'),
    input('storageKey', sql.NVarChar(1000), storagePath),
    input('mediaSize', sql.BigInt, mediaSize || null),
    input('mimeType', sql.NVarChar(255), mimeType || null),
    input('fileName', sql.NVarChar(512), fileName || null),
  ]);
  return getMessageById(messageId);
}

export async function setMessageStarred(messageId, starred) {
  await query(`UPDATE jje.messages SET starred_at = @starredAt, updated_at = SYSUTCDATETIME() WHERE message_id = @messageId;`, [
    input('messageId', sql.BigInt, messageId),
    input('starredAt', sql.DateTime2(3), starred ? new Date() : null),
  ]);
  return getMessageById(messageId);
}

export async function softDeleteMessage(messageId) {
  const existing = await getMessageById(messageId);
  if (!existing) return null;
  await query(`UPDATE jje.messages SET deleted_at = SYSUTCDATETIME(), starred_at = NULL, updated_at = SYSUTCDATETIME() WHERE message_id = @messageId;`, [
    input('messageId', sql.BigInt, messageId),
  ]);
  const message = await getMessageById(messageId);
  const conversation = await refreshConversationPreview(existing.conversationId);
  return { message, conversation };
}

export async function listStarredMessages({ phoneNumberId = null, limit = 100 } = {}) {
  const result = await query(`${MESSAGE_SELECT}
    INNER JOIN jje.conversations conversation ON conversation.conversation_id = message.conversation_id
    WHERE message.starred_at IS NOT NULL AND message.deleted_at IS NULL
      AND (@phoneNumberId IS NULL OR message.phone_number_id = @phoneNumberId)
    ORDER BY message.starred_at DESC
    OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY;`, [
    input('phoneNumberId', sql.BigInt, phoneNumberId || null),
    input('limit', sql.Int, clampInteger(limit, 100, 1, 200)),
  ]);
  return result.recordset.map((row) => ({
    ...mapMessage(row),
    contactName: row.business_name || row.profile_name || row.contact_phone || row.contact_wa_id || 'Unknown',
    contactPhone: row.contact_phone || null,
    contactWaId: row.contact_wa_id || '',
  }));
}

export async function updateMessageStatusByWaMessageId({ waMessageId, status, statusAt, errorMessage }) {
  await executeProcedure('jje.usp_MessageStatus_Apply', [
    input('ProviderMessageId', sql.VarChar(255), waMessageId),
    input('Status', sql.VarChar(30), status),
    input('ProviderTimestamp', sql.DateTime2(3), statusAt ? new Date(statusAt) : new Date()),
    input('ErrorCode', sql.VarChar(100), null),
    input('ErrorMessage', sql.NVarChar(2000), errorMessage || null),
  ]);
  const message = await getMessageByWaMessageId(waMessageId);
  if (!message) return null;

  if (message.campaignId) {
    await query(`
      UPDATE recipient SET
        status = CASE
          WHEN recipient.status IN ('optin_initial_sent','optin_followup_sent') AND @status <> 'failed' THEN recipient.status
          WHEN (CASE recipient.status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE -1 END)
             <= (CASE @status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE -1 END)
            THEN @status
          ELSE recipient.status END,
        error_message = CASE WHEN @status = 'failed' THEN @errorMessage ELSE error_message END,
        sent_at = CASE WHEN @status IN ('sent','delivered','read') THEN COALESCE(sent_at, @statusAt) ELSE sent_at END,
        delivered_at = CASE WHEN @status IN ('delivered','read') THEN COALESCE(delivered_at, @statusAt) ELSE delivered_at END,
        read_at = CASE WHEN @status = 'read' THEN COALESCE(read_at, @statusAt) ELSE read_at END,
        failed_at = CASE WHEN @status = 'failed' THEN COALESCE(failed_at, @statusAt) ELSE failed_at END,
        updated_at = SYSUTCDATETIME()
      FROM jje.campaign_recipients recipient
      WHERE recipient.campaign_id = @campaignId AND recipient.message_id = @messageId;`, [
      input('status', sql.VarChar(30), status),
      input('errorMessage', sql.NVarChar(2000), errorMessage || null),
      input('statusAt', sql.DateTime2(3), statusAt ? new Date(statusAt) : new Date()),
      input('campaignId', sql.BigInt, message.campaignId),
      input('messageId', sql.BigInt, message.id),
    ]);
    await refreshCampaignCounts(message.campaignId);
  }

  if (status === 'failed' && message.templateName) {
    await query(`
      UPDATE jje.contacts SET opt_in_status = 'unknown', opt_in_source = 'template-failed',
        opt_in_updated_at = @statusAt, updated_at = SYSUTCDATETIME()
      WHERE contact_id = @contactId
        AND opt_in_status IN ('pending_initial','pending_followup')
        AND last_opt_in_template = @templateName;`, [
      input('contactId', sql.BigInt, message.contactId),
      input('templateName', sql.NVarChar(512), message.templateName),
      input('statusAt', sql.DateTime2(3), statusAt ? new Date(statusAt) : new Date()),
    ]);
  }
  return message;
}

export async function createConversationMessageFromSend({ conversationId, phoneNumberId, contactId, responseMessageId, payload }) {
  const message = await insertMessage({
    conversationId,
    phoneNumberId,
    contactId,
    direction: 'outbound',
    messageType: payload.messageType || 'text',
    waMessageId: responseMessageId,
    parentWaMessageId: payload.replyToWaMessageId || null,
    textBody: payload.textBody || null,
    caption: payload.caption || null,
    mediaId: payload.mediaId || null,
    storageBucket: payload.storageBucket || null,
    storagePath: payload.storagePath || null,
    mediaSize: payload.mediaSize || null,
    mimeType: payload.mimeType || null,
    fileName: payload.fileName || null,
    templateName: payload.templateName || null,
    templateLanguage: payload.templateLanguage || null,
    templateParams: payload.templateParams || null,
    campaignId: payload.campaignId || null,
    status: 'sent',
    sentAt: new Date(),
    waTimestamp: new Date(),
  });
  return message;
}
