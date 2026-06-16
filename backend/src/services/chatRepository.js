import { getAdminClient } from '../config/db.js';
import { buildMessagePreview, normaliseRecipientWaId } from '../utils/messageFormat.js';

const supabase = getAdminClient();

const MESSAGE_STATUS_RANK = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

const CONTACT_PAGE_SIZE = 1000;
const CONTACT_PICKER_PAGE_SIZE = 300;
const CONTACT_SEARCH_SCAN_LIMIT = 3000;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

function requireData(result) {
  if (result.error) {
    throw result.error;
  }

  return result.data;
}

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function shouldIgnoreMessageStatusUpdate(currentStatus, nextStatus) {
  if (!currentStatus || currentStatus === nextStatus) return false;

  if (currentStatus === 'failed' && nextStatus !== 'failed') return true;

  const currentRank = MESSAGE_STATUS_RANK[currentStatus] ?? -1;
  const nextRank = MESSAGE_STATUS_RANK[nextStatus] ?? -1;

  if (nextStatus === 'failed') {
    return currentRank >= MESSAGE_STATUS_RANK.delivered;
  }

  return currentRank > nextRank;
}

function splitCursor(cursor) {
  if (!cursor) {
    return { time: null };
  }

  const [time] = String(cursor).split('|');
  return { time: time || null };
}

function makeCursor(value, id) {
  if (!value) return null;
  return `${new Date(value).toISOString()}|${id}`;
}

function mapBusinessNumber(row, account) {
  if (!row) return null;

  return {
    id: row.id,
    businessAccountId: row.business_account_id,
    businessAccountName: account?.name || null,
    wabaId: account?.waba_id || null,
    displayName: row.display_name,
    phoneNumber: row.phone_number,
    phoneNumberId: row.phone_number_id,
    accessToken: row.access_token,
    verifyToken: row.verify_token,
    apiVersion: row.api_version,
    isDefault: Boolean(row.is_default),
    status: row.status,
  };
}

function mapContact(row) {
  if (!row) return null;

  return {
    id: row.id,
    waId: row.wa_id,
    phoneNumber: row.phone_number,
    profileName: row.profile_name,
    businessDirectoryName: row.business_directory_name,
    notes: row.notes,
    optInStatus: row.opt_in_status,
    optInKeyword: row.opt_in_keyword,
    optInSource: row.opt_in_source,
    optInUpdatedAt: row.opt_in_updated_at,
    lastOptInTemplateName: row.last_opt_in_template_name,
    lastOptInPromptAt: row.last_opt_in_prompt_at,
    lastInboundAt: row.last_inbound_at,
    lastOutboundAt: row.last_outbound_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getContactDisplayName(row) {
  return String(row?.business_directory_name || row?.profile_name || row?.phone_number || row?.wa_id || '').trim();
}

function isAlphabeticContact(row) {
  return /^[a-z]/i.test(getContactDisplayName(row));
}

function compareContactRows(left, right) {
  const leftName = getContactDisplayName(left);
  const rightName = getContactDisplayName(right);
  const leftIsAlpha = /^[a-z]/i.test(leftName);
  const rightIsAlpha = /^[a-z]/i.test(rightName);

  if (leftIsAlpha !== rightIsAlpha) {
    return leftIsAlpha ? -1 : 1;
  }

  const nameCompare = leftName.localeCompare(rightName, 'en', {
    numeric: true,
    sensitivity: 'base',
  });

  if (nameCompare !== 0) return nameCompare;
  return String(left?.wa_id || '').localeCompare(String(right?.wa_id || ''), 'en', { numeric: true });
}

function clampContactPickerLimit(limit) {
  const requested = Number(limit) || CONTACT_PICKER_PAGE_SIZE;
  return Math.min(CONTACT_PICKER_PAGE_SIZE, Math.max(1, requested));
}

function parseContactPageCursor(cursor) {
  if (!cursor) {
    return { section: 'alpha', offset: 0, skip: 0 };
  }

  const [section, rawOffset, rawSkip] = String(cursor).split(':');
  return {
    section: section === 'other' || section === 'search' ? section : 'alpha',
    offset: Math.max(0, Number(rawOffset) || 0),
    skip: Math.max(0, Number(rawSkip) || 0),
  };
}

function makeContactPageCursor(section, offset, skip = 0) {
  return `${section}:${offset}:${skip}`;
}

function buildAlphabeticContactFilter() {
  return [
    ...ALPHABET.map((letter) => `profile_name.ilike.${letter}%`),
    ...ALPHABET.map((letter) => `and(profile_name.is.null,business_directory_name.ilike.${letter}%)`),
    ...ALPHABET.map((letter) => `and(profile_name.eq.,business_directory_name.ilike.${letter}%)`),
  ].join(',');
}

function mapConversation(row, contact, number) {
  if (!row) return null;

  return {
    id: row.id,
    phoneNumberId: row.phone_number_id,
    phoneNumberLabel: number?.display_name || null,
    contactId: row.contact_id,
    contactName: contact?.business_directory_name || contact?.profile_name || contact?.phone_number || contact?.wa_id || 'Unknown',
    contactPhone: contact?.phone_number || null,
    contactWaId: contact?.wa_id || '',
    contactOptInStatus: contact?.opt_in_status || 'unknown',
    contactOptInUpdatedAt: contact?.opt_in_updated_at || null,
    contactLastOptInTemplateName: contact?.last_opt_in_template_name || null,
    contactLastOptInPromptAt: contact?.last_opt_in_prompt_at || null,
    contactLastInboundAt: contact?.last_inbound_at || null,
    contactLastOutboundAt: contact?.last_outbound_at || null,
    lastMessageId: row.last_message_id,
    lastMessagePreview: row.last_message_preview,
    lastMessageAt: row.last_message_at,
    unreadCount: row.unread_count,
    isArchived: Boolean(row.is_archived),
    clearedAt: row.cleared_at,
  };
}

function mapMessage(row) {
  if (!row) return null;

  return {
    id: row.id,
    conversationId: row.conversation_id,
    phoneNumberId: row.phone_number_id,
    contactId: row.contact_id,
    direction: row.direction,
    messageType: row.message_type,
    waMessageId: row.wa_message_id,
    parentWaMessageId: row.parent_wa_message_id,
    textBody: row.text_body,
    caption: row.caption,
    mediaId: row.media_id,
    mediaUrl: row.media_url,
    storageBucket: row.storage_bucket || null,
    storagePath: row.storage_path || null,
    mediaSize: row.media_size || null,
    mimeType: row.mime_type,
    fileName: row.file_name,
    templateName: row.template_name,
    templateLanguage: row.template_language,
    templateParams: row.template_params || null,
    campaignId: row.campaign_id,
    status: row.status,
    errorMessage: row.error_message,
    waTimestamp: row.wa_timestamp,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    failedAt: row.failed_at,
    starredAt: row.starred_at,
    deletedAt: row.deleted_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTemplate(row) {
  if (!row) return null;

  return {
    id: row.id,
    phoneNumberId: row.phone_number_id,
    templateName: row.template_name,
    category: row.category,
    language: row.language,
    status: row.status,
    headerFormat: row.header_format,
    bodyText: row.body_text,
    footerText: row.footer_text,
    buttons: row.buttons_json || [],
    metaTemplateId: row.meta_template_id,
    lastSyncedAt: row.last_synced_at,
  };
}

function normaliseChatFilterMemberKeys(value) {
  return Array.isArray(value)
    ? value
      .map((item) => String(item || '').trim())
      .filter((item) => /^(conversation|broadcast):\d+$/.test(item))
    : [];
}

function normaliseCustomChatFilters(value) {
  return Array.isArray(value)
    ? value
      .map((filter) => ({
        id: String(filter?.id || '').trim(),
        name: String(filter?.name || '').trim(),
        memberKeys: normaliseChatFilterMemberKeys(filter?.memberKeys),
        createdAt: filter?.createdAt || new Date().toISOString(),
      }))
      .filter((filter) => filter.id && filter.name)
    : [];
}

function mapChatFilterSettings(row, phoneNumberId) {
  return {
    phoneNumberId,
    favoriteKeys: normaliseChatFilterMemberKeys(row?.favorite_keys),
    customFilters: normaliseCustomChatFilters(row?.custom_filters),
    updatedAt: row?.updated_at || null,
  };
}

function mapCampaign(row) {
  if (!row) return null;

  return {
    id: row.id,
    phoneNumberId: row.phone_number_id,
    contactListId: row.contact_list_id,
    title: row.title,
    mode: row.mode,
    bodyText: row.body_text,
    mediaId: row.media_id || null,
    storageBucket: row.storage_bucket || null,
    storagePath: row.storage_path || null,
    mediaSize: row.media_size || null,
    mimeType: row.mime_type || null,
    fileName: row.file_name || null,
    templateName: row.template_name,
    initialTemplateName: row.initial_template_name,
    followupTemplateName: row.followup_template_name,
    templateLanguage: row.template_language,
    templateParams: row.template_params_json || [],
    status: row.status,
    totalRecipients: row.total_recipients,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapContactList(row, members = [], memberCount = null) {
  if (!row) return null;

  return {
    id: row.id,
    phoneNumberId: row.phone_number_id,
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

async function fetchAccountsByIds(ids) {
  if (ids.length === 0) return new Map();
  const result = await supabase
    .from('wa_business_accounts')
    .select('*')
    .in('id', ids);

  const rows = requireData(result);
  return new Map(rows.map((row) => [row.id, row]));
}

async function fetchPhoneNumbersByIds(ids) {
  if (ids.length === 0) return new Map();
  const result = await supabase
    .from('wa_phone_numbers')
    .select('*')
    .in('id', ids);

  const rows = requireData(result);
  return new Map(rows.map((row) => [row.id, row]));
}

async function fetchContactsByIds(ids) {
  if (ids.length === 0) return new Map();
  const rows = [];

  for (let index = 0; index < ids.length; index += CONTACT_PAGE_SIZE) {
    const result = await supabase
      .from('wa_contacts')
      .select('*')
      .in('id', ids.slice(index, index + CONTACT_PAGE_SIZE));

    rows.push(...requireData(result));
  }

  return new Map(rows.map((row) => [row.id, row]));
}

async function attachBusinessAccount(numberRow) {
  if (!numberRow) return null;
  const accounts = await fetchAccountsByIds([numberRow.business_account_id]);
  return mapBusinessNumber(numberRow, accounts.get(numberRow.business_account_id));
}

async function buildConversationModels(rows) {
  const contactIds = [...new Set(rows.map((row) => row.contact_id))];
  const numberIds = [...new Set(rows.map((row) => row.phone_number_id))];

  const [contacts, numbers] = await Promise.all([
    fetchContactsByIds(contactIds),
    fetchPhoneNumbersByIds(numberIds),
  ]);

  return rows.map((row) => mapConversation(row, contacts.get(row.contact_id), numbers.get(row.phone_number_id)));
}

async function getContactMatchIds(search, limit = 200) {
  const query = search?.trim();
  if (!query) return null;

  const digitOnly = query.replace(/\D/g, '');
  let matchRows = [];

  if (digitOnly) {
    const numberMatches = await supabase
      .from('wa_contacts')
      .select('id')
      .or(`phone_number.ilike.%${digitOnly}%,wa_id.ilike.%${digitOnly}%`)
      .limit(limit);

    matchRows = matchRows.concat(requireData(numberMatches));
  }

  const nameMatches = await supabase
    .from('wa_contacts')
    .select('id')
    .ilike('profile_name', `%${query}%`)
    .limit(limit);

  matchRows = matchRows.concat(requireData(nameMatches));

  const directoryNameMatches = await supabase
    .from('wa_contacts')
    .select('id')
    .ilike('business_directory_name', `%${query}%`)
    .limit(limit);

  matchRows = matchRows.concat(requireData(directoryNameMatches));

  const ids = [...new Set(matchRows.map((row) => row.id))];
  return ids;
}

export async function listBusinessNumbers() {
  const result = await supabase
    .from('wa_phone_numbers')
    .select('*')
    .eq('status', 'active')
    .order('is_default', { ascending: false })
    .order('display_name', { ascending: true });

  const rows = requireData(result);
  const accounts = await fetchAccountsByIds([...new Set(rows.map((row) => row.business_account_id))]);
  return rows.map((row) => mapBusinessNumber(row, accounts.get(row.business_account_id)));
}

export async function getBusinessNumberById(id) {
  const result = await supabase
    .from('wa_phone_numbers')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  return attachBusinessAccount(requireData(result));
}

export async function getBusinessNumberByPhoneNumberId(phoneNumberId) {
  const result = await supabase
    .from('wa_phone_numbers')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle();

  return attachBusinessAccount(requireData(result));
}

export async function getBusinessNumberByVerifyToken(verifyToken) {
  const result = await supabase
    .from('wa_phone_numbers')
    .select('*')
    .eq('verify_token', verifyToken)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  return attachBusinessAccount(requireData(result));
}

export async function getDefaultBusinessNumber() {
  const result = await supabase
    .from('wa_phone_numbers')
    .select('*')
    .eq('status', 'active')
    .order('is_default', { ascending: false })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();

  return attachBusinessAccount(requireData(result));
}

export async function searchContacts(search, limit = 15) {
  const query = search?.trim();
  if (!query) return [];

  const ids = await getContactMatchIds(query);
  if (!ids || ids.length === 0) return [];

  const result = await supabase
    .from('wa_contacts')
    .select('*')
    .in('id', ids.slice(0, 200))
    .order('updated_at', { ascending: false })
    .limit(limit);

  const rows = requireData(result);
  return rows.map((row) => ({
    id: row.id,
    waId: row.wa_id,
    phoneNumber: row.phone_number,
    profileName: row.profile_name,
  }));
}

export async function listContacts({ search = '', limit = 100 }) {
  const trimmedSearch = search.trim();
  if (trimmedSearch) {
    const ids = await getContactMatchIds(trimmedSearch);
    if (!ids || ids.length === 0) return [];
    const matchedContacts = [...(await fetchContactsByIds(ids.slice(0, limit))).values()].map(mapContact).filter(Boolean);
    return matchedContacts.sort((left, right) => (
      (left.businessDirectoryName || left.profileName || left.waId)
        .localeCompare(right.businessDirectoryName || right.profileName || right.waId)
    ));
  }

  const rows = [];
  const requestedLimit = Math.max(1, limit || CONTACT_PAGE_SIZE);

  for (let offset = 0; rows.length < requestedLimit; offset += CONTACT_PAGE_SIZE) {
    const end = Math.min(offset + CONTACT_PAGE_SIZE - 1, requestedLimit - 1);
    const result = await supabase
      .from('wa_contacts')
      .select('*')
      .order('profile_name', { ascending: true })
      .order('wa_id', { ascending: true })
      .range(offset, end);

    const page = requireData(result);
    rows.push(...page);

    if (page.length < CONTACT_PAGE_SIZE) break;
  }

  return rows.map(mapContact);
}

async function fetchAlphabeticContactRows(offset, limit) {
  const result = await supabase
    .from('wa_contacts')
    .select('*')
    .or(buildAlphabeticContactFilter())
    .order('profile_name', { ascending: true })
    .order('business_directory_name', { ascending: true })
    .order('wa_id', { ascending: true })
    .range(offset, offset + limit - 1);

  return requireData(result).sort(compareContactRows);
}

async function fetchOtherContactRows(offset, skip, limit) {
  const rows = [];
  let scanOffset = offset;
  let skipInCurrentPage = skip;

  while (rows.length < limit) {
    const result = await supabase
      .from('wa_contacts')
      .select('*')
      .order('profile_name', { ascending: true })
      .order('business_directory_name', { ascending: true })
      .order('wa_id', { ascending: true })
      .range(scanOffset, scanOffset + CONTACT_PAGE_SIZE - 1);

    const page = requireData(result);
    const otherRows = page.filter((row) => !isAlphabeticContact(row));
    const availableRows = otherRows.slice(skipInCurrentPage);
    const needed = limit - rows.length;

    rows.push(...availableRows.slice(0, needed));

    if (availableRows.length > needed) {
      return {
        rows: rows.sort(compareContactRows),
        nextCursor: makeContactPageCursor('other', scanOffset, skipInCurrentPage + needed),
      };
    }

    scanOffset += page.length;
    skipInCurrentPage = 0;

    if (page.length < CONTACT_PAGE_SIZE) {
      return {
        rows: rows.sort(compareContactRows),
        nextCursor: null,
      };
    }
  }

  return {
    rows: rows.sort(compareContactRows),
    nextCursor: makeContactPageCursor('other', scanOffset, 0),
  };
}

export async function listContactsPage({ search = '', limit = CONTACT_PICKER_PAGE_SIZE, cursor = null }) {
  const trimmedSearch = search.trim();
  const requestedLimit = clampContactPickerLimit(limit);
  const parsedCursor = parseContactPageCursor(cursor);

  if (trimmedSearch) {
    const ids = await getContactMatchIds(trimmedSearch, CONTACT_SEARCH_SCAN_LIMIT);
    if (!ids || ids.length === 0) {
      return { items: [], nextCursor: null };
    }

    const offset = parsedCursor.section === 'search' ? parsedCursor.offset : 0;
    const contacts = [...(await fetchContactsByIds(ids)).values()]
      .filter(Boolean)
      .sort(compareContactRows);
    const pageRows = contacts.slice(offset, offset + requestedLimit);
    const nextCursor = contacts.length > offset + requestedLimit
      ? makeContactPageCursor('search', offset + requestedLimit, 0)
      : null;

    return {
      items: pageRows.map(mapContact),
      nextCursor,
    };
  }

  if (parsedCursor.section === 'other') {
    const otherPage = await fetchOtherContactRows(parsedCursor.offset, parsedCursor.skip, requestedLimit);
    return {
      items: otherPage.rows.map(mapContact),
      nextCursor: otherPage.nextCursor,
    };
  }

  const alphaRows = await fetchAlphabeticContactRows(parsedCursor.offset, requestedLimit + 1);
  if (alphaRows.length > requestedLimit) {
    return {
      items: alphaRows.slice(0, requestedLimit).map(mapContact),
      nextCursor: makeContactPageCursor('alpha', parsedCursor.offset + requestedLimit, 0),
    };
  }

  const remainingLimit = requestedLimit - alphaRows.length;
  if (remainingLimit <= 0) {
    return {
      items: alphaRows.map(mapContact),
      nextCursor: null,
    };
  }

  const otherPage = await fetchOtherContactRows(0, 0, remainingLimit);
  return {
    items: [...alphaRows, ...otherPage.rows].map(mapContact),
    nextCursor: otherPage.nextCursor,
  };
}

export async function bulkUpsertContacts(contacts = []) {
  const results = [];

  for (const contact of contacts) {
    if (!contact.waId) continue;
    const upserted = await upsertContact({
      waId: contact.waId,
      phoneNumber: contact.phoneNumber || contact.waId,
      profileName: contact.profileName || contact.name || contact.waId,
      businessDirectoryName: contact.businessDirectoryName || contact.profileName || contact.name || null,
    });
    results.push(upserted);
  }

  return results;
}

export async function upsertContact({
  waId,
  phoneNumber,
  profileName,
  businessDirectoryName,
  optInStatus,
  optInKeyword,
  optInSource,
  optInUpdatedAt,
  lastOptInTemplateName,
  lastOptInPromptAt,
  inboundAt,
  outboundAt,
}) {
  const existing = await supabase
    .from('wa_contacts')
    .select('*')
    .eq('wa_id', waId)
    .maybeSingle();

  const found = requireData(existing);
  const now = new Date().toISOString();

  if (found) {
    const updatePayload = {
      updated_at: now,
      phone_number: phoneNumber || found.phone_number,
      profile_name: profileName || found.profile_name,
      business_directory_name: businessDirectoryName || found.business_directory_name,
      opt_in_status: optInStatus || found.opt_in_status,
      opt_in_keyword: optInKeyword || found.opt_in_keyword,
      opt_in_source: optInSource || found.opt_in_source,
      opt_in_updated_at: optInUpdatedAt ? toIso(optInUpdatedAt) : found.opt_in_updated_at,
      last_opt_in_template_name: lastOptInTemplateName || found.last_opt_in_template_name,
      last_opt_in_prompt_at: lastOptInPromptAt ? toIso(lastOptInPromptAt) : found.last_opt_in_prompt_at,
      last_inbound_at: inboundAt ? toIso(inboundAt) : found.last_inbound_at,
      last_outbound_at: outboundAt ? toIso(outboundAt) : found.last_outbound_at,
    };

    const updated = await supabase
      .from('wa_contacts')
      .update(updatePayload)
      .eq('id', found.id)
      .select('*')
      .single();

    const row = requireData(updated);
    return mapContact(row);
  }

  const inserted = await supabase
    .from('wa_contacts')
    .insert({
      wa_id: waId,
      phone_number: phoneNumber || null,
      profile_name: profileName || null,
      business_directory_name: businessDirectoryName || null,
      opt_in_status: optInStatus || 'unknown',
      opt_in_keyword: optInKeyword || null,
      opt_in_source: optInSource || null,
      opt_in_updated_at: optInUpdatedAt ? toIso(optInUpdatedAt) : null,
      last_opt_in_template_name: lastOptInTemplateName || null,
      last_opt_in_prompt_at: lastOptInPromptAt ? toIso(lastOptInPromptAt) : null,
      last_inbound_at: inboundAt ? toIso(inboundAt) : null,
      last_outbound_at: outboundAt ? toIso(outboundAt) : null,
    })
    .select('*')
    .single();

  return mapContact(requireData(inserted));
}

export async function renameContact({ contactId, name }) {
  const normalizedName = String(name || '').replace(/\s+/g, ' ').trim();
  if (!Number.isInteger(contactId) || contactId <= 0) {
    throw new Error('Valid contact ID is required');
  }
  if (!normalizedName) {
    throw new Error('Contact name is required');
  }

  const updated = await supabase
    .from('wa_contacts')
    .update({
      business_directory_name: normalizedName,
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId)
    .select('*')
    .maybeSingle();

  return mapContact(requireData(updated));
}

export async function ensureConversation(phoneNumberDbId, contactId) {
  const existing = await supabase
    .from('wa_conversations')
    .select('id, is_archived')
    .eq('phone_number_id', phoneNumberDbId)
    .eq('contact_id', contactId)
    .maybeSingle();

  const found = requireData(existing);
  if (found) {
    if (found.is_archived) {
      requireData(await supabase
        .from('wa_conversations')
        .update({
          is_archived: false,
          updated_at: new Date().toISOString(),
        })
        .eq('id', found.id));
    }

    return found.id;
  }

  const inserted = await supabase
    .from('wa_conversations')
    .insert({
      phone_number_id: phoneNumberDbId,
      contact_id: contactId,
    })
    .select('id')
    .single();

  return requireData(inserted).id;
}

export async function setContactOptInState(contactId, {
  status,
  keyword = null,
  source = null,
  templateName = undefined,
  timestamp = new Date(),
}) {
  const updatePayload = {
    opt_in_status: status,
    opt_in_keyword: keyword,
    opt_in_source: source,
    opt_in_updated_at: toIso(timestamp),
    updated_at: new Date().toISOString(),
  };

  if (templateName !== undefined) {
    updatePayload.last_opt_in_template_name = templateName || null;
    updatePayload.last_opt_in_prompt_at = templateName ? toIso(timestamp) : null;
  }

  requireData(await supabase
    .from('wa_contacts')
    .update(updatePayload)
    .eq('id', contactId));
}

async function clearFailedOptInPromptIfCurrent(messageRow, statusAt) {
  if (
    messageRow.direction !== 'outbound' ||
    messageRow.message_type !== 'template' ||
    !messageRow.contact_id ||
    !messageRow.template_name
  ) {
    return false;
  }

  const contact = requireData(await supabase
    .from('wa_contacts')
    .select('id,opt_in_status,last_opt_in_template_name')
    .eq('id', messageRow.contact_id)
    .maybeSingle());

  if (!contact) return false;

  const contactStatus = String(contact.opt_in_status || '').toLowerCase();
  if (contactStatus === 'opted_in') return false;

  const isPendingOptIn = ['pending_initial', 'pending_followup'].includes(contactStatus);
  const isCurrentPrompt = contact.last_opt_in_template_name === messageRow.template_name;

  if (!isPendingOptIn && !isCurrentPrompt) return false;

  await setContactOptInState(messageRow.contact_id, {
    status: 'unknown',
    source: 'template-failed',
    templateName: null,
    timestamp: statusAt,
  });

  return true;
}

export async function touchConversation({ conversationId, messageId, preview, timestamp, unreadIncrement = 0 }) {
  const existing = await supabase
    .from('wa_conversations')
    .select('unread_count')
    .eq('id', conversationId)
    .single();

  const row = requireData(existing);

  const updatePayload = {
    last_message_id: messageId,
    last_message_preview: preview,
    last_message_at: toIso(timestamp),
    updated_at: new Date().toISOString(),
    is_archived: false,
    unread_count: unreadIncrement > 0 ? Number(row.unread_count || 0) + unreadIncrement : Number(row.unread_count || 0),
  };

  const result = await supabase
    .from('wa_conversations')
    .update(updatePayload)
    .eq('id', conversationId);

  requireData(result);
}

export async function markConversationRead(conversationId) {
  const result = await supabase
    .from('wa_conversations')
    .update({
      unread_count: 0,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  requireData(result);
}

export async function refreshConversationPreview(conversationId) {
  const now = new Date().toISOString();
  const conversation = requireData(await supabase
    .from('wa_conversations')
    .select('cleared_at')
    .eq('id', conversationId)
    .maybeSingle());

  let latestQuery = supabase
    .from('wa_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (conversation?.cleared_at) {
    latestQuery = latestQuery.gt('created_at', conversation.cleared_at);
  }

  const latestRows = requireData(await latestQuery);
  const latest = latestRows[0] || null;

  requireData(await supabase
    .from('wa_conversations')
    .update({
      last_message_id: latest?.id || null,
      last_message_preview: latest ? buildMessagePreview(latest) : null,
      last_message_at: latest?.created_at || null,
      updated_at: now,
    })
    .eq('id', conversationId));

  return getConversationById(conversationId);
}

export async function clearConversation(conversationId) {
  const now = new Date().toISOString();
  requireData(await supabase
    .from('wa_conversations')
    .update({
      last_message_id: null,
      last_message_preview: null,
      last_message_at: null,
      unread_count: 0,
      cleared_at: now,
      is_archived: false,
      updated_at: now,
    })
    .eq('id', conversationId));

  return getConversationById(conversationId);
}

export async function archiveConversation(conversationId) {
  const now = new Date().toISOString();
  requireData(await supabase
    .from('wa_conversations')
    .update({
      last_message_id: null,
      last_message_preview: null,
      last_message_at: null,
      unread_count: 0,
      cleared_at: now,
      is_archived: true,
      updated_at: now,
    })
    .eq('id', conversationId));
}

export async function listRecentInboundWaMessageIds(conversationId, limit = 20) {
  const result = await supabase
    .from('wa_messages')
    .select('wa_message_id')
    .eq('conversation_id', conversationId)
    .eq('direction', 'inbound')
    .is('deleted_at', null)
    .not('wa_message_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  return requireData(result).map((row) => row.wa_message_id).filter(Boolean);
}

export async function getConversationById(id) {
  const result = await supabase
    .from('wa_conversations')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  const row = requireData(result);
  if (!row) return null;

  const [contacts, numbers] = await Promise.all([
    fetchContactsByIds([row.contact_id]),
    fetchPhoneNumbersByIds([row.phone_number_id]),
  ]);

  return mapConversation(row, contacts.get(row.contact_id), numbers.get(row.phone_number_id));
}

export async function listConversations({ phoneNumberId, search, limit = 40, cursor }) {
  const { time } = splitCursor(cursor);
  let contactIds = null;

  if (search?.trim()) {
    contactIds = await getContactMatchIds(search);
    if (!contactIds || contactIds.length === 0) {
      return { items: [], nextCursor: null };
    }
  }

  let query = supabase
    .from('wa_conversations')
    .select('*')
    .eq('is_archived', false)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(limit + 1);

  if (phoneNumberId) {
    query = query.eq('phone_number_id', phoneNumberId);
  }

  if (contactIds) {
    query = query.in('contact_id', contactIds.slice(0, 200));
  }

  if (time) {
    query = query.lt('last_message_at', time);
  }

  const rows = requireData(await query);
  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const items = await buildConversationModels(trimmed);

  return {
    items,
    nextCursor: hasMore && trimmed.length > 0 ? makeCursor(trimmed[trimmed.length - 1].last_message_at, trimmed[trimmed.length - 1].id) : null,
  };
}

export async function insertMessage(message) {
  const payload = {
    conversation_id: message.conversationId,
    phone_number_id: message.phoneNumberId,
    contact_id: message.contactId,
    direction: message.direction,
    message_type: message.messageType,
    wa_message_id: message.waMessageId || null,
    parent_wa_message_id: message.parentWaMessageId || null,
    text_body: message.textBody || null,
    caption: message.caption || null,
    media_id: message.mediaId || null,
    media_url: message.mediaUrl || null,
    storage_bucket: message.storageBucket || null,
    storage_path: message.storagePath || null,
    media_size: message.mediaSize || null,
    mime_type: message.mimeType || null,
    file_name: message.fileName || null,
    template_name: message.templateName || null,
    template_language: message.templateLanguage || null,
    template_params: message.templateParams || null,
    campaign_id: message.campaignId || null,
    status: message.status || 'queued',
    error_message: message.errorMessage || null,
    wa_timestamp: toIso(message.waTimestamp),
    sent_at: toIso(message.sentAt),
    delivered_at: toIso(message.deliveredAt),
    read_at: toIso(message.readAt),
    failed_at: toIso(message.failedAt),
  };

  const inserted = await supabase
    .from('wa_messages')
    .insert(payload)
    .select('*')
    .single();

  return mapMessage(requireData(inserted));
}

export async function listMessages({ conversationId, limit = 50, cursor }) {
  const { time } = splitCursor(cursor);
  const conversation = requireData(await supabase
    .from('wa_conversations')
    .select('cleared_at')
    .eq('id', conversationId)
    .maybeSingle());

  let query = supabase
    .from('wa_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit + 1);

  if (time) {
    query = query.lt('created_at', time);
  }

  if (conversation?.cleared_at) {
    query = query.gt('created_at', conversation.cleared_at);
  }

  const rows = requireData(await query);
  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const ascending = trimmed.map(mapMessage).reverse();

  return {
    items: ascending,
    nextCursor: hasMore && trimmed.length > 0 ? makeCursor(trimmed[trimmed.length - 1].created_at, trimmed[trimmed.length - 1].id) : null,
  };
}

function getContactIdentityKey(contact) {
  if (!contact) return null;

  const waId = normaliseRecipientWaId(contact.waId || contact.phoneNumber);
  if (waId) return `wa:${waId}`;
  if (contact.id) return `id:${contact.id}`;
  return null;
}

function dedupeContactsByIdentity(contacts = []) {
  const uniqueContacts = [];
  const seen = new Set();

  for (const contact of contacts) {
    const key = getContactIdentityKey(contact);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueContacts.push(contact);
  }

  return uniqueContacts;
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
  const windowStart = new Date(Date.now() - (windowSeconds * 1000)).toISOString();
  let query = supabase
    .from('wa_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('direction', 'outbound')
    .eq('message_type', messageType)
    .is('deleted_at', null)
    .gte('created_at', windowStart)
    .order('created_at', { ascending: false })
    .limit(5);

  query = replyToWaMessageId
    ? query.eq('parent_wa_message_id', replyToWaMessageId)
    : query.is('parent_wa_message_id', null);

  const rows = requireData(await query);
  const normalisedTextBody = normaliseRecentDuplicateValue(textBody);
  const normalisedCaption = normaliseRecentDuplicateValue(caption);
  const normalisedMediaId = normaliseRecentDuplicateValue(mediaId);
  const normalisedTemplateName = normaliseRecentDuplicateValue(templateName);
  const normalisedTemplateLanguage = normaliseRecentDuplicateValue(templateLanguage);

  const match = rows.find((row) => {
    if (row.status === 'failed') return false;
    if (normaliseRecentDuplicateValue(row.text_body) !== normalisedTextBody) return false;
    if (normaliseRecentDuplicateValue(row.caption) !== normalisedCaption) return false;
    if (normaliseRecentDuplicateValue(row.media_id) !== normalisedMediaId) return false;
    if (normaliseRecentDuplicateValue(row.template_name) !== normalisedTemplateName) return false;
    if (normaliseRecentDuplicateValue(row.template_language) !== normalisedTemplateLanguage) return false;
    return true;
  });

  return match ? mapMessage(match) : null;
}

export async function getMessageById(id) {
  const result = await supabase
    .from('wa_messages')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  return mapMessage(requireData(result));
}

export async function getMessageByWaMessageId(waMessageId) {
  if (!waMessageId) return null;

  const result = await supabase
    .from('wa_messages')
    .select('*')
    .eq('wa_message_id', waMessageId)
    .maybeSingle();

  return mapMessage(requireData(result));
}

export async function updateMessageMediaStorage(messageId, {
  storageBucket,
  storagePath,
  mediaSize,
  mimeType,
  fileName,
}) {
  const payload = {
    storage_bucket: storageBucket || null,
    storage_path: storagePath || null,
    media_size: mediaSize || null,
    updated_at: new Date().toISOString(),
  };

  if (mimeType !== undefined) payload.mime_type = mimeType || null;
  if (fileName !== undefined) payload.file_name = fileName || null;

  const updated = await supabase
    .from('wa_messages')
    .update(payload)
    .eq('id', messageId)
    .select('*')
    .maybeSingle();

  return mapMessage(requireData(updated));
}

export async function setMessageStarred(messageId, starred) {
  const updated = await supabase
    .from('wa_messages')
    .update({
      starred_at: starred ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', messageId)
    .select('*')
    .maybeSingle();

  return mapMessage(requireData(updated));
}

export async function softDeleteMessage(messageId) {
  const existing = await supabase
    .from('wa_messages')
    .select('*')
    .eq('id', messageId)
    .maybeSingle();

  const row = requireData(existing);
  if (!row) return null;

  const now = new Date().toISOString();
  const updated = await supabase
    .from('wa_messages')
    .update({
      deleted_at: now,
      starred_at: null,
      updated_at: now,
    })
    .eq('id', messageId)
    .select('*')
    .single();

  const message = mapMessage(requireData(updated));
  const conversation = await refreshConversationPreview(row.conversation_id);

  return { message, conversation };
}

export async function listStarredMessages({ phoneNumberId = null, limit = 100 } = {}) {
  let query = supabase
    .from('wa_messages')
    .select('*')
    .not('starred_at', 'is', null)
    .is('deleted_at', null)
    .order('starred_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 200));

  if (phoneNumberId) {
    query = query.eq('phone_number_id', phoneNumberId);
  }

  const rows = requireData(await query);
  const messages = rows.map(mapMessage);
  const conversationIds = [...new Set(messages.map((message) => message.conversationId))];
  const conversationRows = conversationIds.length > 0
    ? requireData(await supabase
      .from('wa_conversations')
      .select('*')
      .in('id', conversationIds))
    : [];
  const conversationById = new Map(conversationRows.map((row) => [row.id, row]));
  const contacts = await fetchContactsByIds([...new Set(conversationRows.map((row) => row.contact_id))]);

  return messages.map((message) => {
    const conversation = conversationById.get(message.conversationId);
    const contact = conversation ? contacts.get(conversation.contact_id) : null;

    return {
      ...message,
      contactName: contact?.business_directory_name || contact?.profile_name || contact?.phone_number || contact?.wa_id || 'Unknown',
      contactPhone: contact?.phone_number || null,
      contactWaId: contact?.wa_id || '',
      starredAt: message.starredAt,
    };
  });
}

export async function updateMessageStatusByWaMessageId({ waMessageId, status, statusAt, errorMessage }) {
  const existing = await supabase
    .from('wa_messages')
    .select('*')
    .eq('wa_message_id', waMessageId)
    .maybeSingle();

  const row = requireData(existing);
  if (!row) return null;

  if (shouldIgnoreMessageStatusUpdate(row.status, status)) {
    return mapMessage(row);
  }

  const statusIso = toIso(statusAt) || new Date().toISOString();
  const updatePayload = {
    status,
    updated_at: new Date().toISOString(),
    error_message: errorMessage || row.error_message,
  };

  if (status === 'sent') updatePayload.sent_at = row.sent_at || statusIso;
  if (status === 'delivered') {
    updatePayload.sent_at = row.sent_at || statusIso;
    updatePayload.delivered_at = row.delivered_at || statusIso;
  }
  if (status === 'read') {
    updatePayload.sent_at = row.sent_at || statusIso;
    updatePayload.delivered_at = row.delivered_at || statusIso;
    updatePayload.read_at = row.read_at || statusIso;
  }
  if (status === 'failed') updatePayload.failed_at = row.failed_at || statusIso;

  const updated = await supabase
    .from('wa_messages')
    .update(updatePayload)
    .eq('id', row.id)
    .select('*')
    .single();

  const message = mapMessage(requireData(updated));

  if (message?.campaignId) {
    const matchingRecipients = requireData(await supabase
      .from('wa_campaign_recipients')
      .select('id,status,prompt_template_name')
      .eq('campaign_id', message.campaignId)
      .eq('wa_message_id', waMessageId));
    const isOptInPromptStatus = message.messageType === 'template'
      && status !== 'failed'
      && matchingRecipients.some((recipient) => (
        ['optin_initial_sent', 'optin_followup_sent'].includes(recipient.status)
        && recipient.prompt_template_name === message.templateName
      ));

    if (!isOptInPromptStatus) {
      const recipientUpdate = {
        status,
        updated_at: new Date().toISOString(),
        error_message: errorMessage || null,
      };

      if (status === 'sent') recipientUpdate.sent_at = toIso(statusAt);
      if (status === 'delivered') recipientUpdate.delivered_at = toIso(statusAt);
      if (status === 'read') recipientUpdate.read_at = toIso(statusAt);
      if (status === 'failed') recipientUpdate.failed_at = toIso(statusAt);

      requireData(await supabase
        .from('wa_campaign_recipients')
        .update(recipientUpdate)
        .eq('campaign_id', message.campaignId)
        .eq('wa_message_id', waMessageId));

      await refreshCampaignCounts(message.campaignId);
    }
  }

  if (status === 'failed') {
    await clearFailedOptInPromptIfCurrent(row, statusIso);
  }

  return message;
}

export async function listTemplates(phoneNumberId = null) {
  let query = supabase
    .from('wa_templates')
    .select('*')
    .order('template_name', { ascending: true });

  if (phoneNumberId) {
    query = query.eq('phone_number_id', phoneNumberId);
  }

  const rows = requireData(await query);
  return rows.map(mapTemplate);
}

export async function getChatFilterSettings(phoneNumberId) {
  const row = requireData(await supabase
    .from('wa_chat_filter_settings')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle());

  return mapChatFilterSettings(row, phoneNumberId);
}

export async function saveChatFilterSettings(phoneNumberId, state = {}) {
  const favoriteKeys = normaliseChatFilterMemberKeys(state.favoriteKeys);
  const customFilters = normaliseCustomChatFilters(state.customFilters);
  const row = requireData(await supabase
    .from('wa_chat_filter_settings')
    .upsert({
      phone_number_id: phoneNumberId,
      favorite_keys: favoriteKeys,
      custom_filters: customFilters,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'phone_number_id',
    })
    .select('*')
    .single());

  return mapChatFilterSettings(row, phoneNumberId);
}

export async function replaceTemplates(phoneNumberId, templates) {
  requireData(await supabase
    .from('wa_templates')
    .delete()
    .eq('phone_number_id', phoneNumberId));

  if (templates.length === 0) return;

  requireData(await supabase
    .from('wa_templates')
    .insert(
      templates.map((template) => ({
        phone_number_id: phoneNumberId,
        template_name: template.name,
        category: template.category || null,
        language: template.language || null,
        status: template.status || null,
        header_format: template.headerFormat || null,
        body_text: template.bodyText || null,
        footer_text: template.footerText || null,
        buttons_json: template.buttons || [],
        meta_template_id: template.id || null,
        last_synced_at: new Date().toISOString(),
      })),
    ));
}

export async function listContactLists(phoneNumberId = null) {
  let query = supabase
    .from('wa_contact_lists')
    .select('*')
    .eq('is_archived', false)
    .order('created_at', { ascending: false });

  if (phoneNumberId) {
    query = query.eq('phone_number_id', phoneNumberId);
  }

  const rows = requireData(await query);
  if (rows.length === 0) return [];

  const memberRows = requireData(await supabase
    .from('wa_contact_list_members')
    .select('list_id')
    .in('list_id', rows.map((row) => row.id)));
  const memberCounts = memberRows.reduce((counts, member) => {
    counts.set(member.list_id, (counts.get(member.list_id) || 0) + 1);
    return counts;
  }, new Map());

  return rows.map((row) => mapContactList(row, [], memberCounts.get(row.id) || 0));
}

export async function getContactListById(id) {
  const listRow = requireData(await supabase
    .from('wa_contact_lists')
    .select('*')
    .eq('id', id)
    .maybeSingle());

  if (!listRow) return null;

  const members = requireData(await supabase
    .from('wa_contact_list_members')
    .select('*')
    .eq('list_id', id)
    .order('position', { ascending: true })
    .order('id', { ascending: true }));

  const contacts = await fetchContactsByIds([...new Set(members.map((member) => member.contact_id))]);

  return mapContactList(listRow, members.map((member) => ({
    id: member.id,
    position: member.position,
    contact: mapContact(contacts.get(member.contact_id)),
  })));
}

export async function createContactList({ phoneNumberId, name, source = 'manual', contacts = [] }) {
  const insertedList = requireData(await supabase
    .from('wa_contact_lists')
    .insert({
      phone_number_id: phoneNumberId,
      name,
      source,
    })
    .select('*')
    .single());

  const explicitContactIds = contacts.map((contact) => contact.contactId).filter(Boolean);
  const existingContacts = explicitContactIds.length > 0
    ? [...(await fetchContactsByIds(explicitContactIds)).values()].map(mapContact).filter(Boolean)
    : [];

  const rawContacts = contacts.filter((contact) => !contact.contactId);
  const upsertedContacts = [
    ...existingContacts,
    ...(await bulkUpsertContacts(rawContacts)),
  ];
  const dedupedContacts = dedupeContactsByIdentity(upsertedContacts);

  if (dedupedContacts.length > 0) {
    const memberRows = dedupedContacts.map((contact, index) => ({
        list_id: insertedList.id,
        contact_id: contact.id,
        position: index,
      }));

    for (let index = 0; index < memberRows.length; index += CONTACT_PAGE_SIZE) {
      requireData(await supabase
        .from('wa_contact_list_members')
        .insert(memberRows.slice(index, index + CONTACT_PAGE_SIZE)));
    }
  }

  return getContactListById(insertedList.id);
}

export async function replaceContactListMembers({ listId, contacts = [] }) {
  const explicitContactIds = contacts.map((contact) => contact.contactId || contact.id).filter(Boolean);
  const existingContacts = explicitContactIds.length > 0
    ? [...(await fetchContactsByIds(explicitContactIds)).values()].map(mapContact).filter(Boolean)
    : [];

  const rawContacts = contacts.filter((contact) => !(contact.contactId || contact.id));
  const upsertedContacts = [
    ...existingContacts,
    ...(await bulkUpsertContacts(rawContacts)),
  ];

  const dedupedContacts = dedupeContactsByIdentity(upsertedContacts);

  requireData(await supabase
    .from('wa_contact_list_members')
    .delete()
    .eq('list_id', listId));

  if (dedupedContacts.length > 0) {
    const memberRows = dedupedContacts.map((contact, index) => ({
      list_id: listId,
      contact_id: contact.id,
      position: index,
    }));

    for (let index = 0; index < memberRows.length; index += CONTACT_PAGE_SIZE) {
      requireData(await supabase
        .from('wa_contact_list_members')
        .insert(memberRows.slice(index, index + CONTACT_PAGE_SIZE)));
    }
  }

  requireData(await supabase
    .from('wa_contact_lists')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', listId));

  return getContactListById(listId);
}

export async function renameContactList({ listId, name }) {
  const normalizedName = String(name || '').replace(/\s+/g, ' ').trim();
  if (!normalizedName) {
    throw new Error('Broadcast list name is required');
  }

  const updated = await supabase
    .from('wa_contact_lists')
    .update({
      name: normalizedName,
      updated_at: new Date().toISOString(),
    })
    .eq('id', listId)
    .select('id')
    .maybeSingle();

  if (!requireData(updated)) return null;
  return getContactListById(listId);
}

export async function clearContactList(listId) {
  const now = new Date().toISOString();
  requireData(await supabase
    .from('wa_contact_lists')
    .update({
      cleared_at: now,
      is_archived: false,
      updated_at: now,
    })
    .eq('id', listId));

  return getContactListById(listId);
}

function normaliseRecentDuplicateValue(value) {
  if (value === null || value === undefined) return null;
  const normalised = String(value).trim();
  return normalised.length > 0 ? normalised : null;
}

export async function findRecentDuplicateCampaign({
  phoneNumberId,
  contactListId = null,
  title = null,
  mode,
  bodyText = null,
  mediaId = null,
  templateName = null,
  templateLanguage = null,
  templateParams = [],
  windowSeconds = 20,
}) {
  const windowStart = new Date(Date.now() - (windowSeconds * 1000)).toISOString();
  let query = supabase
    .from('wa_campaigns')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .eq('mode', mode)
    .gte('created_at', windowStart)
    .order('created_at', { ascending: false })
    .limit(5);

  query = contactListId ? query.eq('contact_list_id', contactListId) : query.is('contact_list_id', null);
  const rows = requireData(await query);

  const normalisedBodyText = normaliseRecentDuplicateValue(bodyText);
  const normalisedMediaId = normaliseRecentDuplicateValue(mediaId);
  const normalisedTemplateName = normaliseRecentDuplicateValue(templateName);
  const normalisedTemplateLanguage = normaliseRecentDuplicateValue(templateLanguage);
  const normalisedTemplateParams = JSON.stringify(Array.isArray(templateParams) ? templateParams : []);

  const match = rows.find((row) => {
    if (normaliseRecentDuplicateValue(row.body_text) !== normalisedBodyText) return false;
    if (normaliseRecentDuplicateValue(row.media_id) !== normalisedMediaId) return false;
    if (normaliseRecentDuplicateValue(row.template_name) !== normalisedTemplateName) return false;
    if (normaliseRecentDuplicateValue(row.template_language) !== normalisedTemplateLanguage) return false;
    return JSON.stringify(row.template_params_json || []) === normalisedTemplateParams;
  });

  return match ? mapCampaign(match) : null;
}

export async function archiveContactList(listId) {
  const now = new Date().toISOString();
  requireData(await supabase
    .from('wa_contact_lists')
    .update({
      cleared_at: now,
      is_archived: true,
      updated_at: now,
    })
    .eq('id', listId));
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
  const uniqueRecipients = [];
  const seenRecipientWaIds = new Set();

  for (const recipient of recipients) {
    const recipientWaId = normaliseRecipientWaId(recipient.waId);
    if (!recipientWaId || seenRecipientWaIds.has(recipientWaId)) continue;
    seenRecipientWaIds.add(recipientWaId);
    uniqueRecipients.push({
      ...recipient,
      waId: recipientWaId,
    });
  }

  const campaignInsert = await supabase
    .from('wa_campaigns')
    .insert({
      phone_number_id: phoneNumberId,
      contact_list_id: contactListId,
      title,
      mode,
      body_text: bodyText || null,
      media_id: mediaId || null,
      storage_bucket: storageBucket || null,
      storage_path: storagePath || null,
      media_size: mediaSize || null,
      mime_type: mimeType || null,
      file_name: fileName || null,
      template_name: templateName || null,
      initial_template_name: initialTemplateName,
      followup_template_name: followupTemplateName,
      template_language: templateLanguage || null,
      template_params_json: templateParams || [],
      total_recipients: uniqueRecipients.length,
    })
    .select('*')
    .single();

  const campaign = mapCampaign(requireData(campaignInsert));

  if (contactListId) {
    requireData(await supabase
      .from('wa_contact_lists')
      .update({
        is_archived: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contactListId));
  }

  if (uniqueRecipients.length > 0) {
    const recipientRows = uniqueRecipients.map((recipient) => ({
      campaign_id: campaign.id,
      recipient_wa_id: recipient.waId,
      recipient_name: recipient.name || null,
      contact_id: recipient.contactId || null,
      contact_list_member_id: recipient.contactListMemberId || null,
      pending_text_body: bodyText || null,
    }));

    for (let index = 0; index < recipientRows.length; index += CONTACT_PAGE_SIZE) {
      requireData(await supabase
        .from('wa_campaign_recipients')
        .insert(recipientRows.slice(index, index + CONTACT_PAGE_SIZE)));
    }
  }

  return campaign;
}

export async function listCampaigns(limit = 20) {
  const rows = requireData(await supabase
    .from('wa_campaigns')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit));

  return rows.map(mapCampaign);
}

export async function listCampaignsByContactList(contactListId, limit = 50, { includeRecipients = false } = {}) {
  const contactList = requireData(await supabase
    .from('wa_contact_lists')
    .select('cleared_at')
    .eq('id', contactListId)
    .maybeSingle());

  let query = supabase
    .from('wa_campaigns')
    .select('*')
    .eq('contact_list_id', contactListId)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (contactList?.cleared_at) {
    query = query.gt('created_at', contactList.cleared_at);
  }

  const rows = requireData(await query);

  if (!includeRecipients) {
    return rows.map(mapCampaign);
  }

  return Promise.all(rows.map((row) => getCampaignById(row.id)));
}

export async function getCampaignById(id) {
  const campaign = requireData(await supabase
    .from('wa_campaigns')
    .select('*')
    .eq('id', id)
    .maybeSingle());

  if (!campaign) return null;

  const recipients = requireData(await supabase
    .from('wa_campaign_recipients')
    .select('*')
    .eq('campaign_id', id)
    .order('id', { ascending: true }));

  return {
    ...mapCampaign(campaign),
    recipients: recipients.map((row) => ({
      id: row.id,
      recipientWaId: row.recipient_wa_id,
      recipientName: row.recipient_name,
      contactListMemberId: row.contact_list_member_id,
      contactId: row.contact_id,
      conversationId: row.conversation_id,
      waMessageId: row.wa_message_id,
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
    })),
  };
}

export async function updateCampaignMediaStorage(campaignId, {
  storageBucket,
  storagePath,
  mediaSize,
  mimeType,
  fileName,
}) {
  const payload = {
    storage_bucket: storageBucket || null,
    storage_path: storagePath || null,
    media_size: mediaSize || null,
    updated_at: new Date().toISOString(),
  };

  if (mimeType !== undefined) payload.mime_type = mimeType || null;
  if (fileName !== undefined) payload.file_name = fileName || null;

  const updated = await supabase
    .from('wa_campaigns')
    .update(payload)
    .eq('id', campaignId)
    .select('*')
    .maybeSingle();

  return mapCampaign(requireData(updated));
}

export async function getDispatchableCampaigns(limit = 3) {
  const rows = requireData(await supabase
    .from('wa_campaigns')
    .select('*')
    .in('status', ['pending', 'sending'])
    .order('created_at', { ascending: true })
    .limit(limit));

  return rows.map(mapCampaign);
}

export async function markCampaignSending(id) {
  requireData(await supabase
    .from('wa_campaigns')
    .update({
      status: 'sending',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id));
}

export async function getQueuedCampaignRecipients(campaignId, limit = 15) {
  const rows = requireData(await supabase
    .from('wa_campaign_recipients')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('status', 'queued')
    .order('id', { ascending: true })
    .limit(limit));

  return rows.map((row) => ({
    id: row.id,
    recipientWaId: row.recipient_wa_id,
    recipientName: row.recipient_name,
    contactListMemberId: row.contact_list_member_id,
    pendingTextBody: row.pending_text_body,
  }));
}

export async function claimCampaignRecipientForDispatch({
  recipientId,
  expectedStatuses,
  nextStatus,
}) {
  const claimed = await supabase
    .from('wa_campaign_recipients')
    .update({
      status: nextStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', recipientId)
    .in('status', expectedStatuses)
    .select('id')
    .maybeSingle();

  return Boolean(requireData(claimed)?.id);
}

export async function markCampaignRecipientSent({ recipientId, contactId, conversationId, waMessageId, optedInAt = null }) {
  const updatePayload = {
    contact_id: contactId,
    conversation_id: conversationId,
    wa_message_id: waMessageId,
    status: 'sent',
    sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (optedInAt) {
    updatePayload.opted_in_at = toIso(optedInAt);
  }

  requireData(await supabase
    .from('wa_campaign_recipients')
    .update(updatePayload)
    .eq('id', recipientId));
}

export async function markCampaignRecipientFailed({ recipientId, errorMessage }) {
  requireData(await supabase
    .from('wa_campaign_recipients')
    .update({
      status: 'failed',
      error_message: errorMessage,
      failed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', recipientId));
}

export async function markCampaignRecipientAwaitingOptIn({
  recipientId,
  contactId,
  conversationId,
  waMessageId = null,
  promptTemplateName,
  nextStatus,
  requestedAt,
}) {
  requireData(await supabase
    .from('wa_campaign_recipients')
    .update({
      contact_id: contactId,
      conversation_id: conversationId,
      wa_message_id: waMessageId,
      prompt_template_name: promptTemplateName,
      status: nextStatus,
      opt_in_requested_at: toIso(requestedAt),
      updated_at: new Date().toISOString(),
    })
    .eq('id', recipientId));
}

export async function getPendingOptInRecipientsForContact({ phoneNumberId, contactId }) {
  const rows = requireData(await supabase
    .from('wa_campaign_recipients')
    .select(`
      *,
      wa_campaigns!inner(
        id,
        phone_number_id,
        title,
        mode,
        body_text,
        media_id,
        storage_bucket,
        storage_path,
        media_size,
        mime_type,
        file_name,
        template_name,
        initial_template_name,
        followup_template_name,
        template_language,
        template_params_json,
        status,
        total_recipients,
        sent_count,
        failed_count,
        created_at,
        updated_at,
        started_at,
        completed_at,
        contact_list_id
      )
    `)
    .eq('contact_id', contactId)
    .eq('wa_campaigns.phone_number_id', phoneNumberId)
    .in('status', ['optin_initial_sent', 'optin_followup_sent'])
    .order('id', { ascending: true }));

  return rows.map((row) => ({
    recipient: {
      id: row.id,
      recipientWaId: row.recipient_wa_id,
      recipientName: row.recipient_name,
      contactListMemberId: row.contact_list_member_id,
      contactId: row.contact_id,
      conversationId: row.conversation_id,
      waMessageId: row.wa_message_id,
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
    },
    campaign: mapCampaign(row.wa_campaigns),
  }));
}

export async function refreshCampaignCounts(campaignId) {
  const rows = requireData(await supabase
    .from('wa_campaign_recipients')
    .select('status')
    .eq('campaign_id', campaignId));

  const sentCount = rows.filter((row) => ['sent', 'delivered', 'read'].includes(row.status)).length;
  const failedCount = rows.filter((row) => row.status === 'failed').length;

  requireData(await supabase
    .from('wa_campaigns')
    .update({
      sent_count: sentCount,
      failed_count: failedCount,
      updated_at: new Date().toISOString(),
    })
    .eq('id', campaignId));
}

export async function completeCampaignIfFinished(campaignId) {
  const rows = requireData(await supabase
    .from('wa_campaign_recipients')
    .select('status')
    .eq('campaign_id', campaignId));

  const inFlightCount = rows.filter((row) => ['queued', 'dispatching', 'dispatching_after_optin'].includes(row.status)).length;
  if (inFlightCount > 0) return false;

  const waitingOptInCount = rows.filter((row) => ['optin_initial_sent', 'optin_followup_sent'].includes(row.status)).length;

  if (waitingOptInCount > 0) {
    requireData(await supabase
      .from('wa_campaigns')
      .update({
        status: 'awaiting_opt_in',
        updated_at: new Date().toISOString(),
      })
      .eq('id', campaignId));

    return true;
  }

  const failedCount = rows.filter((row) => row.status === 'failed').length;
  const sentCount = rows.filter((row) => ['sent', 'delivered', 'read'].includes(row.status)).length;

  requireData(await supabase
    .from('wa_campaigns')
    .update({
      status: sentCount === 0 && failedCount > 0 ? 'failed' : 'completed',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', campaignId));

  return true;
}

export async function getBootstrapData() {
  const [businessNumbers, campaigns] = await Promise.all([
    listBusinessNumbers(),
    listCampaigns(8),
  ]);

  return {
    businessNumbers,
    campaigns,
    defaultPhoneNumberId: businessNumbers.find((number) => number.isDefault)?.id || businessNumbers[0]?.id || null,
  };
}

export async function createConversationMessageFromSend({
  conversationId,
  phoneNumberId,
  contactId,
  responseMessageId,
  payload,
}) {
  if (payload.messageType === 'reaction' && payload.replyToWaMessageId) {
    requireData(await supabase
      .from('wa_messages')
      .update({
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('conversation_id', conversationId)
      .eq('direction', 'outbound')
      .eq('message_type', 'reaction')
      .eq('parent_wa_message_id', payload.replyToWaMessageId)
      .is('deleted_at', null));
  }

  const message = await insertMessage({
    conversationId,
    phoneNumberId,
    contactId,
    direction: 'outbound',
    messageType: payload.messageType,
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

  if (message.messageType !== 'reaction') {
    await touchConversation({
      conversationId,
      messageId: message.id,
      preview: buildMessagePreview({
        textBody: message.textBody,
        caption: message.caption,
        messageType: message.messageType,
      }),
      timestamp: message.createdAt,
    });
  }

  return message;
}
