import { decryptSecret } from '../security/secretCipher.js';
import { parseJson } from './sqlHelpers.js';

function id(value) {
  return value === null || value === undefined ? null : Number(value);
}

export function mapBusinessNumber(row) {
  if (!row) return null;
  return {
    id: id(row.phone_number_id),
    businessAccountId: id(row.business_account_id),
    businessAccountName: row.business_account_name || null,
    wabaId: row.meta_waba_id || null,
    displayName: row.display_name,
    phoneNumber: row.phone_number,
    phoneNumberId: row.meta_phone_number_id,
    accessToken: decryptSecret(row.access_token_cipher),
    verifyToken: null,
    apiVersion: row.api_version,
    isDefault: Boolean(row.is_default),
    status: row.status,
  };
}

export function mapContact(row) {
  if (!row) return null;
  return {
    id: id(row.contact_id),
    waId: row.wa_id,
    phoneNumber: row.phone_number,
    profileName: row.profile_name,
    businessDirectoryName: row.business_name,
    notes: row.notes,
    optInStatus: row.opt_in_status,
    optInKeyword: row.opt_in_keyword,
    optInSource: row.opt_in_source,
    optInUpdatedAt: row.opt_in_updated_at,
    lastOptInTemplateName: row.last_opt_in_template,
    lastOptInPromptAt: row.last_opt_in_prompt_at,
    lastInboundAt: row.last_inbound_at,
    lastOutboundAt: row.last_outbound_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapConversation(row) {
  if (!row) return null;
  return {
    id: id(row.conversation_id),
    phoneNumberId: id(row.phone_number_id),
    phoneNumberLabel: row.phone_number_label || null,
    contactId: id(row.contact_id),
    contactName: row.contact_name || row.contact_phone || row.contact_wa_id || 'Unknown',
    contactPhone: row.contact_phone || null,
    contactWaId: row.contact_wa_id || '',
    contactOptInStatus: row.contact_opt_in_status || 'unknown',
    contactOptInUpdatedAt: row.contact_opt_in_updated_at || null,
    contactLastOptInTemplateName: row.contact_last_opt_in_template || null,
    contactLastOptInPromptAt: row.contact_last_opt_in_prompt_at || null,
    contactLastInboundAt: row.contact_last_inbound_at || null,
    contactLastOutboundAt: row.contact_last_outbound_at || null,
    lastMessageId: id(row.last_message_id),
    lastMessagePreview: row.last_message_preview,
    lastMessageAt: row.last_message_at,
    unreadCount: row.unread_count,
    isArchived: Boolean(row.is_archived),
    clearedAt: row.cleared_at,
  };
}

export function mapMessage(row) {
  if (!row) return null;
  return {
    id: id(row.message_id),
    conversationId: id(row.conversation_id),
    phoneNumberId: id(row.phone_number_id),
    contactId: id(row.contact_id),
    direction: row.direction,
    messageType: row.message_type,
    waMessageId: row.provider_message_id,
    parentWaMessageId: row.parent_provider_message_id,
    textBody: row.text_body,
    caption: row.caption,
    mediaId: row.provider_media_id,
    mediaUrl: null,
    storageBucket: row.storage_provider || null,
    storagePath: row.storage_key || null,
    mediaSize: row.size_bytes || null,
    mimeType: row.mime_type,
    fileName: row.file_name || row.original_file_name,
    templateName: row.template_name,
    templateLanguage: row.template_language,
    templateParams: parseJson(row.template_params_json, null),
    campaignId: id(row.campaign_id),
    status: row.status,
    errorMessage: row.error_message,
    waTimestamp: row.provider_timestamp,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    failedAt: row.failed_at,
    starredAt: row.starred_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapTemplate(row) {
  if (!row) return null;
  return {
    id: id(row.template_id),
    phoneNumberId: id(row.phone_number_id),
    templateName: row.template_name,
    category: row.category,
    language: row.language,
    status: row.status,
    headerFormat: row.header_format,
    bodyText: row.body_text,
    footerText: row.footer_text,
    buttons: parseJson(row.buttons_json, []),
    metaTemplateId: row.meta_template_id,
    lastSyncedAt: row.last_synced_at,
  };
}

export function mapCampaign(row) {
  if (!row) return null;
  return {
    id: id(row.campaign_id),
    phoneNumberId: id(row.phone_number_id),
    contactListId: id(row.contact_list_id),
    title: row.title,
    mode: row.mode,
    bodyText: row.body_text,
    mediaId: row.provider_media_id || null,
    storageBucket: row.storage_provider || null,
    storagePath: row.storage_key || null,
    mediaSize: row.size_bytes || null,
    mimeType: row.mime_type || null,
    fileName: row.original_file_name || null,
    templateName: row.template_name,
    initialTemplateName: row.initial_template_name,
    followupTemplateName: row.followup_template_name,
    templateLanguage: row.template_language,
    templateParams: parseJson(row.template_params_json, []),
    status: row.status,
    totalRecipients: row.total_recipients,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function mapContactList(row, members = [], memberCount = null) {
  if (!row) return null;
  return {
    id: id(row.contact_list_id),
    phoneNumberId: id(row.phone_number_id),
    name: row.name,
    source: row.source,
    isArchived: Boolean(row.is_archived),
    clearedAt: row.cleared_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    memberCount: memberCount ?? members.length,
    members,
  };
}
