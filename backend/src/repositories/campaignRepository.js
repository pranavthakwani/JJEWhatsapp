import { normaliseRecipientWaId } from '../utils/messageFormat.js';
import { clampInteger, input, query, sql } from './sqlHelpers.js';
import { mapCampaign } from './mappers.js';

const CAMPAIGN_SELECT = `
  SELECT campaign.*, media.provider_media_id, media.storage_provider, media.storage_key,
         media.size_bytes, media.mime_type, media.original_file_name
  FROM jje.campaigns campaign
  LEFT JOIN jje.media_assets media ON media.media_asset_id = campaign.media_asset_id
`;

function mapRecipient(row) {
  return {
    id: Number(row.campaign_recipient_id),
    recipientWaId: row.recipient_wa_id,
    recipientName: row.recipient_name,
    contactListMemberId: row.contact_list_member_id == null ? null : Number(row.contact_list_member_id),
    contactId: row.contact_id == null ? null : Number(row.contact_id),
    conversationId: row.conversation_id == null ? null : Number(row.conversation_id),
    waMessageId: row.provider_message_id || null,
    pendingTextBody: row.pending_text_body,
    promptTemplateName: row.prompt_template_name,
    status: row.status,
    errorMessage: row.error_message,
    optInRequestedAt: row.opt_in_requested_at,
    optedInAt: row.opted_in_at,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    failedAt: row.failed_at,
  };
}

function uniqueRecipients(recipients = []) {
  const seen = new Set();
  const result = [];
  for (const recipient of recipients) {
    const waId = normaliseRecipientWaId(recipient?.waId);
    if (!waId || seen.has(waId)) continue;
    seen.add(waId);
    result.push({ ...recipient, waId });
  }
  return result;
}

export async function findRecentDuplicateCampaign({
  phoneNumberId,
  contactListId = null,
  mode,
  bodyText = null,
  mediaId = null,
  templateName = null,
  templateLanguage = null,
  templateParams = [],
  windowSeconds = 20,
}) {
  const result = await query(`${CAMPAIGN_SELECT}
    WHERE campaign.phone_number_id = @phoneNumberId
      AND ISNULL(campaign.contact_list_id, 0) = ISNULL(@contactListId, 0)
      AND campaign.mode = @mode
      AND campaign.created_at >= DATEADD(second, -@windowSeconds, SYSUTCDATETIME())
      AND ISNULL(campaign.body_text, '') = ISNULL(@bodyText, '')
      AND ISNULL(media.provider_media_id, '') = ISNULL(@mediaId, '')
      AND ISNULL(campaign.template_name, '') = ISNULL(@templateName, '')
      AND ISNULL(campaign.template_language, '') = ISNULL(@templateLanguage, '')
      AND ISNULL(campaign.template_params_json, '[]') = @templateParamsJson
    ORDER BY campaign.created_at DESC
    OFFSET 0 ROWS FETCH NEXT 1 ROW ONLY;`, [
    input('phoneNumberId', sql.BigInt, phoneNumberId),
    input('contactListId', sql.BigInt, contactListId),
    input('mode', sql.VarChar(20), mode),
    input('windowSeconds', sql.Int, clampInteger(windowSeconds, 20, 1, 300)),
    input('bodyText', sql.NVarChar(sql.MAX), bodyText),
    input('mediaId', sql.VarChar(255), mediaId),
    input('templateName', sql.NVarChar(512), templateName),
    input('templateLanguage', sql.VarChar(20), templateLanguage),
    input('templateParamsJson', sql.NVarChar(sql.MAX), JSON.stringify(Array.isArray(templateParams) ? templateParams : [])),
  ]);
  return mapCampaign(result.recordset[0]);
}

export async function createCampaign({
  phoneNumberId,
  contactListId = null,
  title,
  mode,
  bodyText,
  mediaId = null,
  storageBucket = null,
  storagePath = null,
  mediaSize = null,
  mimeType = null,
  fileName = null,
  templateName,
  initialTemplateName = null,
  followupTemplateName = null,
  templateLanguage,
  templateParams,
  recipients,
}) {
  const normalizedRecipients = uniqueRecipients(recipients);
  const recipientsJson = JSON.stringify(normalizedRecipients.map((recipient) => ({
    waId: recipient.waId,
    name: recipient.name || null,
    contactId: recipient.contactId || null,
    contactListMemberId: recipient.contactListMemberId || null,
  })));
  const result = await query(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @mediaAssetId bigint;
    IF @storagePath IS NOT NULL OR @providerMediaId IS NOT NULL
    BEGIN
      INSERT jje.media_assets(provider_media_id, storage_provider, storage_key,
        original_file_name, mime_type, size_bytes)
      VALUES(@providerMediaId, COALESCE(@storageProvider, CASE WHEN @storagePath IS NULL THEN 'meta' ELSE 'local' END), COALESCE(@storagePath, CONCAT('meta/', @providerMediaId)),
        @fileName, COALESCE(@mimeType, 'application/octet-stream'), COALESCE(@mediaSize, 0));
      SET @mediaAssetId = SCOPE_IDENTITY();
    END;

    INSERT jje.campaigns(phone_number_id, contact_list_id, title, mode, body_text,
      template_name, initial_template_name, followup_template_name, template_language,
      template_params_json, media_asset_id, status, total_recipients)
    VALUES(@phoneNumberId, @contactListId, @title, @mode, @bodyText,
      @templateName, @initialTemplateName, @followupTemplateName, @templateLanguage,
      @templateParamsJson, @mediaAssetId, 'pending', @recipientCount);
    DECLARE @campaignId bigint = SCOPE_IDENTITY();

    INSERT jje.campaign_recipients(campaign_id, recipient_wa_id, recipient_name,
      contact_id, contact_list_member_id, pending_text_body)
    SELECT @campaignId, source.wa_id, source.name, source.contact_id,
      source.member_id, @bodyText
    FROM OPENJSON(@recipientsJson) WITH (
      wa_id varchar(64) '$.waId', name nvarchar(240) '$.name',
      contact_id bigint '$.contactId', member_id bigint '$.contactListMemberId'
    ) source;

    IF @contactListId IS NOT NULL
      UPDATE jje.contact_lists SET is_archived = 0, updated_at = SYSUTCDATETIME() WHERE contact_list_id = @contactListId;
    COMMIT TRANSACTION;
    SELECT @campaignId AS campaign_id;`, [
    input('phoneNumberId', sql.BigInt, phoneNumberId),
    input('contactListId', sql.BigInt, contactListId),
    input('title', sql.NVarChar(240), title),
    input('mode', sql.VarChar(20), mode),
    input('bodyText', sql.NVarChar(sql.MAX), bodyText || null),
    input('providerMediaId', sql.VarChar(255), mediaId),
    input('storageProvider', sql.VarChar(30), storageBucket || null),
    input('storagePath', sql.NVarChar(1000), storagePath),
    input('mediaSize', sql.BigInt, mediaSize),
    input('mimeType', sql.NVarChar(255), mimeType),
    input('fileName', sql.NVarChar(512), fileName),
    input('templateName', sql.NVarChar(512), templateName || null),
    input('initialTemplateName', sql.NVarChar(512), initialTemplateName),
    input('followupTemplateName', sql.NVarChar(512), followupTemplateName),
    input('templateLanguage', sql.VarChar(20), templateLanguage || null),
    input('templateParamsJson', sql.NVarChar(sql.MAX), JSON.stringify(templateParams || [])),
    input('recipientCount', sql.Int, normalizedRecipients.length),
    input('recipientsJson', sql.NVarChar(sql.MAX), recipientsJson),
  ]);
  return getCampaignById(result.recordset[0].campaign_id);
}

export async function listCampaigns(limit = 20) {
  const result = await query(`${CAMPAIGN_SELECT}
    ORDER BY campaign.created_at DESC
    OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY;`, [input('limit', sql.Int, clampInteger(limit, 20, 1, 100))]);
  return result.recordset.map(mapCampaign);
}

export async function listCampaignsByContactList(contactListId, limit = 50, { includeRecipients = false } = {}) {
  const result = await query(`${CAMPAIGN_SELECT}
    INNER JOIN jje.contact_lists list ON list.contact_list_id = campaign.contact_list_id
    WHERE campaign.contact_list_id = @contactListId
      AND (list.cleared_at IS NULL OR campaign.created_at > list.cleared_at)
    ORDER BY campaign.created_at ASC
    OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY;`, [
    input('contactListId', sql.BigInt, contactListId),
    input('limit', sql.Int, clampInteger(limit, 50, 1, 100)),
  ]);
  if (!includeRecipients) return result.recordset.map(mapCampaign);
  return Promise.all(result.recordset.map((row) => getCampaignById(row.campaign_id)));
}

export async function getCampaignById(id) {
  const result = await query(`${CAMPAIGN_SELECT} WHERE campaign.campaign_id = @id;`, [input('id', sql.BigInt, id)]);
  const campaign = mapCampaign(result.recordset[0]);
  if (!campaign) return null;
  const recipients = await query(`
    SELECT recipient.*, message.provider_message_id
    FROM jje.campaign_recipients recipient
    LEFT JOIN jje.messages message ON message.message_id = recipient.message_id
    WHERE recipient.campaign_id = @id
    ORDER BY recipient.campaign_recipient_id;`, [input('id', sql.BigInt, id)]);
  return { ...campaign, recipients: recipients.recordset.map(mapRecipient) };
}

export async function updateCampaignMediaStorage(campaignId, { storageBucket, storagePath, mediaSize, mimeType, fileName }) {
  await query(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @mediaAssetId bigint;
    SELECT @mediaAssetId = media_asset_id FROM jje.campaigns WITH (UPDLOCK) WHERE campaign_id = @campaignId;
    IF @mediaAssetId IS NULL
    BEGIN
      INSERT jje.media_assets(storage_provider, storage_key, original_file_name, mime_type, size_bytes)
      VALUES(COALESCE(@storageProvider, 'local'), @storagePath, @fileName, COALESCE(@mimeType, 'application/octet-stream'), COALESCE(@mediaSize, 0));
      SET @mediaAssetId = SCOPE_IDENTITY();
      UPDATE jje.campaigns SET media_asset_id = @mediaAssetId, updated_at = SYSUTCDATETIME() WHERE campaign_id = @campaignId;
    END
    ELSE
      UPDATE jje.media_assets SET storage_provider = COALESCE(@storageProvider, storage_provider),
        storage_key = @storagePath, size_bytes = COALESCE(@mediaSize, size_bytes),
        mime_type = COALESCE(@mimeType, mime_type), original_file_name = COALESCE(@fileName, original_file_name)
      WHERE media_asset_id = @mediaAssetId;
    COMMIT TRANSACTION;`, [
    input('campaignId', sql.BigInt, campaignId),
    input('storageProvider', sql.VarChar(30), storageBucket || 'local'),
    input('storagePath', sql.NVarChar(1000), storagePath),
    input('mediaSize', sql.BigInt, mediaSize),
    input('mimeType', sql.NVarChar(255), mimeType || null),
    input('fileName', sql.NVarChar(512), fileName || null),
  ]);
  return getCampaignById(campaignId);
}

export async function getDispatchableCampaigns(limit = 3) {
  const result = await query(`${CAMPAIGN_SELECT}
    WHERE campaign.status IN ('pending','sending') ORDER BY campaign.created_at
    OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY;`, [input('limit', sql.Int, clampInteger(limit, 3, 1, 20))]);
  return result.recordset.map(mapCampaign);
}

export async function markCampaignSending(id) {
  await query(`UPDATE jje.campaigns SET status = 'sending', started_at = COALESCE(started_at, SYSUTCDATETIME()), updated_at = SYSUTCDATETIME() WHERE campaign_id = @id;`, [input('id', sql.BigInt, id)]);
}

export async function getQueuedCampaignRecipients(campaignId, limit = 15) {
  const result = await query(`
    SELECT TOP (@limit) recipient.*, message.provider_message_id
    FROM jje.campaign_recipients recipient
    LEFT JOIN jje.messages message ON message.message_id = recipient.message_id
    WHERE recipient.campaign_id = @campaignId AND recipient.status = 'queued'
      AND (recipient.next_attempt_at IS NULL OR recipient.next_attempt_at <= SYSUTCDATETIME())
    ORDER BY recipient.campaign_recipient_id;`, [
    input('limit', sql.Int, clampInteger(limit, 15, 1, 100)),
    input('campaignId', sql.BigInt, campaignId),
  ]);
  return result.recordset.map(mapRecipient);
}

export async function claimCampaignRecipientForDispatch({ recipientId, expectedStatuses, nextStatus }) {
  const statusJson = JSON.stringify(expectedStatuses || []);
  const result = await query(`
    UPDATE recipient WITH (ROWLOCK, UPDLOCK)
    SET status = @nextStatus, locked_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
    OUTPUT inserted.campaign_recipient_id
    FROM jje.campaign_recipients recipient
    WHERE recipient.campaign_recipient_id = @recipientId
      AND recipient.status IN (SELECT value FROM OPENJSON(@statuses));`, [
    input('recipientId', sql.BigInt, recipientId),
    input('nextStatus', sql.VarChar(30), nextStatus),
    input('statuses', sql.NVarChar(sql.MAX), statusJson),
  ]);
  return Boolean(result.recordset[0]);
}

export async function markCampaignRecipientSent({ recipientId, contactId, conversationId, waMessageId, optedInAt = null }) {
  await query(`
    UPDATE recipient SET contact_id = @contactId, conversation_id = @conversationId,
      message_id = message.message_id, status = 'sent', sent_at = SYSUTCDATETIME(),
      opted_in_at = COALESCE(@optedInAt, opted_in_at), locked_at = NULL, locked_by = NULL,
      updated_at = SYSUTCDATETIME()
    FROM jje.campaign_recipients recipient
    LEFT JOIN jje.messages message ON message.provider_message_id = @waMessageId
    WHERE recipient.campaign_recipient_id = @recipientId;`, [
    input('recipientId', sql.BigInt, recipientId), input('contactId', sql.BigInt, contactId),
    input('conversationId', sql.BigInt, conversationId), input('waMessageId', sql.VarChar(255), waMessageId),
    input('optedInAt', sql.DateTime2(3), optedInAt ? new Date(optedInAt) : null),
  ]);
}

export async function markCampaignRecipientFailed({ recipientId, errorMessage }) {
  await query(`UPDATE jje.campaign_recipients SET status = 'failed', error_message = @errorMessage,
    failed_at = SYSUTCDATETIME(), locked_at = NULL, locked_by = NULL, updated_at = SYSUTCDATETIME()
    WHERE campaign_recipient_id = @recipientId;`, [
    input('recipientId', sql.BigInt, recipientId), input('errorMessage', sql.NVarChar(2000), String(errorMessage || '').slice(0, 2000)),
  ]);
}

export async function markCampaignRecipientAwaitingOptIn({ recipientId, contactId, conversationId, waMessageId = null, promptTemplateName, nextStatus, requestedAt }) {
  await query(`
    UPDATE recipient SET contact_id = @contactId, conversation_id = @conversationId,
      message_id = message.message_id, prompt_template_name = @promptTemplateName,
      status = @nextStatus, opt_in_requested_at = @requestedAt,
      locked_at = NULL, locked_by = NULL, updated_at = SYSUTCDATETIME()
    FROM jje.campaign_recipients recipient
    LEFT JOIN jje.messages message ON message.provider_message_id = @waMessageId
    WHERE recipient.campaign_recipient_id = @recipientId;`, [
    input('recipientId', sql.BigInt, recipientId), input('contactId', sql.BigInt, contactId),
    input('conversationId', sql.BigInt, conversationId), input('waMessageId', sql.VarChar(255), waMessageId),
    input('promptTemplateName', sql.NVarChar(512), promptTemplateName), input('nextStatus', sql.VarChar(30), nextStatus),
    input('requestedAt', sql.DateTime2(3), requestedAt ? new Date(requestedAt) : new Date()),
  ]);
}

export async function getPendingOptInRecipientsForContact({ phoneNumberId, contactId }) {
  const result = await query(`
    SELECT campaign.*, media.provider_media_id, media.storage_provider, media.storage_key,
      media.size_bytes, media.mime_type, media.original_file_name,
      recipient.*, message.provider_message_id AS recipient_provider_message_id
    FROM jje.campaigns campaign
    LEFT JOIN jje.media_assets media ON media.media_asset_id = campaign.media_asset_id
    INNER JOIN jje.campaign_recipients recipient ON recipient.campaign_id = campaign.campaign_id
    LEFT JOIN jje.messages message ON message.message_id = recipient.message_id
    WHERE recipient.contact_id = @contactId AND campaign.phone_number_id = @phoneNumberId
      AND recipient.status IN ('optin_initial_sent','optin_followup_sent')
    ORDER BY recipient.campaign_recipient_id;`, [
    input('contactId', sql.BigInt, contactId), input('phoneNumberId', sql.BigInt, phoneNumberId),
  ]);
  return result.recordset.map((row) => ({
    recipient: mapRecipient({ ...row, provider_message_id: row.recipient_provider_message_id }),
    campaign: mapCampaign(row),
  }));
}

export async function refreshCampaignCounts(campaignId) {
  await query(`
    UPDATE campaign SET
      sent_count = counts.sent_count,
      failed_count = counts.failed_count,
      updated_at = SYSUTCDATETIME()
    FROM jje.campaigns campaign
    CROSS APPLY (
      SELECT SUM(CASE WHEN status IN ('sent','delivered','read') THEN 1 ELSE 0 END) sent_count,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) failed_count
      FROM jje.campaign_recipients WHERE campaign_id = campaign.campaign_id
    ) counts
    WHERE campaign.campaign_id = @campaignId;`, [input('campaignId', sql.BigInt, campaignId)]);
}

export async function completeCampaignIfFinished(campaignId) {
  const result = await query(`
    DECLARE @inFlight int, @waiting int, @failed int, @sent int;
    SELECT @inFlight = SUM(CASE WHEN status IN ('queued','dispatching','dispatching_after_optin') THEN 1 ELSE 0 END),
      @waiting = SUM(CASE WHEN status IN ('optin_initial_sent','optin_followup_sent') THEN 1 ELSE 0 END),
      @failed = SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),
      @sent = SUM(CASE WHEN status IN ('sent','delivered','read') THEN 1 ELSE 0 END)
    FROM jje.campaign_recipients WHERE campaign_id = @campaignId;
    IF COALESCE(@inFlight, 0) = 0
    BEGIN
      UPDATE jje.campaigns SET status = CASE WHEN COALESCE(@waiting, 0) > 0 THEN 'awaiting_opt_in'
        WHEN COALESCE(@sent, 0) = 0 AND COALESCE(@failed, 0) > 0 THEN 'failed' ELSE 'completed' END,
        completed_at = CASE WHEN COALESCE(@waiting, 0) = 0 THEN SYSUTCDATETIME() ELSE completed_at END,
        updated_at = SYSUTCDATETIME()
      WHERE campaign_id = @campaignId;
      SELECT CAST(1 AS bit) AS completed;
    END
    ELSE SELECT CAST(0 AS bit) AS completed;`, [input('campaignId', sql.BigInt, campaignId)]);
  return Boolean(result.recordset[0]?.completed);
}
