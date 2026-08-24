import { normaliseRecipientWaId } from '../utils/messageFormat.js';
import { clampInteger, input, iso, query, sql } from './sqlHelpers.js';
import { mapContact } from './mappers.js';

const CONTACT_SELECT = `
  SELECT contact_id, wa_id, phone_number, profile_name, business_name, notes,
         opt_in_status, opt_in_keyword, opt_in_source, opt_in_updated_at,
         last_opt_in_template, last_opt_in_prompt_at, last_inbound_at,
         last_outbound_at, created_at, updated_at
  FROM jje.contacts
`;

function contactSearchPattern(search) {
  return `%${String(search || '').trim().replaceAll('[', '[[]').replaceAll('%', '[%]').replaceAll('_', '[_]')}%`;
}

export async function searchContacts(search, limit = 15) {
  const trimmed = String(search || '').trim();
  if (!trimmed) return [];
  const result = await query(`${CONTACT_SELECT}
    WHERE wa_id LIKE @search OR phone_number LIKE @search OR profile_name LIKE @search OR business_name LIKE @search
    ORDER BY updated_at DESC
    OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY;`, [
    input('search', sql.NVarChar(500), contactSearchPattern(trimmed)),
    input('limit', sql.Int, clampInteger(limit, 15, 1, 100)),
  ]);
  return result.recordset.map((row) => ({
    id: Number(row.contact_id),
    waId: row.wa_id,
    phoneNumber: row.phone_number,
    profileName: row.profile_name,
  }));
}

export async function listContacts({ search = '', limit = 100 }) {
  const trimmed = String(search || '').trim();
  const result = await query(`${CONTACT_SELECT}
    ${trimmed ? 'WHERE wa_id LIKE @search OR phone_number LIKE @search OR profile_name LIKE @search OR business_name LIKE @search' : ''}
    ORDER BY CASE WHEN COALESCE(NULLIF(business_name, ''), NULLIF(profile_name, '')) LIKE '[A-Za-z]%' THEN 0 ELSE 1 END,
             COALESCE(NULLIF(business_name, ''), NULLIF(profile_name, ''), phone_number, wa_id), wa_id
    OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY;`, [
    input('search', sql.NVarChar(500), contactSearchPattern(trimmed)),
    input('limit', sql.Int, clampInteger(limit, 100, 1, 5000)),
  ]);
  return result.recordset.map(mapContact);
}

function parseOffsetCursor(cursor) {
  const match = /^offset:(\d+)$/.exec(String(cursor || ''));
  return match ? Number(match[1]) : 0;
}

export async function listContactsPage({ search = '', limit = 300, cursor = null }) {
  const requestedLimit = clampInteger(limit, 300, 1, 300);
  const offset = parseOffsetCursor(cursor);
  const trimmed = String(search || '').trim();
  const result = await query(`${CONTACT_SELECT}
    ${trimmed ? 'WHERE wa_id LIKE @search OR phone_number LIKE @search OR profile_name LIKE @search OR business_name LIKE @search' : ''}
    ORDER BY CASE WHEN COALESCE(NULLIF(business_name, ''), NULLIF(profile_name, '')) LIKE '[A-Za-z]%' THEN 0 ELSE 1 END,
             COALESCE(NULLIF(business_name, ''), NULLIF(profile_name, ''), phone_number, wa_id), wa_id
    OFFSET @offset ROWS FETCH NEXT @take ROWS ONLY;`, [
    input('search', sql.NVarChar(500), contactSearchPattern(trimmed)),
    input('offset', sql.Int, offset),
    input('take', sql.Int, requestedLimit + 1),
  ]);
  const hasMore = result.recordset.length > requestedLimit;
  return {
    items: result.recordset.slice(0, requestedLimit).map(mapContact),
    nextCursor: hasMore ? `offset:${offset + requestedLimit}` : null,
  };
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
  const normalizedWaId = normaliseRecipientWaId(waId);
  if (!normalizedWaId) throw new Error('A valid WhatsApp ID is required.');
  const result = await query(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @contactId bigint;
    SELECT @contactId = contact_id FROM jje.contacts WITH (UPDLOCK, HOLDLOCK) WHERE wa_id = @waId;
    IF @contactId IS NULL
    BEGIN
      INSERT jje.contacts(
        wa_id, phone_number, profile_name, business_name, opt_in_status,
        opt_in_keyword, opt_in_source, opt_in_updated_at, last_opt_in_template,
        last_opt_in_prompt_at, last_inbound_at, last_outbound_at
      ) VALUES(
        @waId, @phoneNumber, @profileName, @businessName, COALESCE(@optInStatus, 'unknown'),
        @optInKeyword, @optInSource, @optInUpdatedAt, @lastOptInTemplate,
        @lastOptInPromptAt, @lastInboundAt, @lastOutboundAt
      );
      SET @contactId = SCOPE_IDENTITY();
    END
    ELSE
    BEGIN
      UPDATE jje.contacts SET
        phone_number = COALESCE(@phoneNumber, phone_number),
        profile_name = COALESCE(NULLIF(@profileName, ''), profile_name),
        business_name = COALESCE(NULLIF(@businessName, ''), business_name),
        opt_in_status = COALESCE(@optInStatus, opt_in_status),
        opt_in_keyword = COALESCE(@optInKeyword, opt_in_keyword),
        opt_in_source = COALESCE(@optInSource, opt_in_source),
        opt_in_updated_at = COALESCE(@optInUpdatedAt, opt_in_updated_at),
        last_opt_in_template = COALESCE(@lastOptInTemplate, last_opt_in_template),
        last_opt_in_prompt_at = COALESCE(@lastOptInPromptAt, last_opt_in_prompt_at),
        last_inbound_at = COALESCE(@lastInboundAt, last_inbound_at),
        last_outbound_at = COALESCE(@lastOutboundAt, last_outbound_at),
        updated_at = SYSUTCDATETIME()
      WHERE contact_id = @contactId;
    END;
    COMMIT TRANSACTION;
    ${CONTACT_SELECT} WHERE contact_id = @contactId;`, [
    input('waId', sql.VarChar(64), normalizedWaId),
    input('phoneNumber', sql.VarChar(32), phoneNumber || normalizedWaId),
    input('profileName', sql.NVarChar(240), profileName || null),
    input('businessName', sql.NVarChar(240), businessDirectoryName || null),
    input('optInStatus', sql.VarChar(30), optInStatus || null),
    input('optInKeyword', sql.NVarChar(100), optInKeyword || null),
    input('optInSource', sql.VarChar(50), optInSource || null),
    input('optInUpdatedAt', sql.DateTime2(3), optInUpdatedAt ? new Date(optInUpdatedAt) : null),
    input('lastOptInTemplate', sql.NVarChar(512), lastOptInTemplateName || null),
    input('lastOptInPromptAt', sql.DateTime2(3), lastOptInPromptAt ? new Date(lastOptInPromptAt) : null),
    input('lastInboundAt', sql.DateTime2(3), inboundAt ? new Date(inboundAt) : null),
    input('lastOutboundAt', sql.DateTime2(3), outboundAt ? new Date(outboundAt) : null),
  ]);
  return mapContact(result.recordset[0]);
}

export async function bulkUpsertContacts(contacts = []) {
  const results = [];
  for (const contact of contacts) {
    if (!contact.waId) continue;
    results.push(await upsertContact({
      waId: contact.waId,
      phoneNumber: contact.phoneNumber || contact.waId,
      profileName: contact.profileName || contact.name || contact.waId,
      businessDirectoryName: contact.businessDirectoryName || contact.profileName || contact.name || null,
    }));
  }
  return results;
}

export async function renameContact({ contactId, name }) {
  const result = await query(`
    UPDATE jje.contacts SET business_name = @name, updated_at = SYSUTCDATETIME() WHERE contact_id = @contactId;
    ${CONTACT_SELECT} WHERE contact_id = @contactId;`, [
    input('contactId', sql.BigInt, contactId),
    input('name', sql.NVarChar(240), String(name || '').trim() || null),
  ]);
  return mapContact(result.recordset[0]);
}

export async function setContactOptInState(contactId, {
  status,
  keyword = null,
  source = null,
  templateName = undefined,
  timestamp = new Date(),
}) {
  const result = await query(`
    UPDATE jje.contacts SET
      opt_in_status = @status,
      opt_in_keyword = @keyword,
      opt_in_source = @source,
      opt_in_updated_at = @timestamp,
      last_opt_in_template = CASE WHEN @setTemplate = 1 THEN @templateName ELSE last_opt_in_template END,
      last_opt_in_prompt_at = CASE WHEN @setTemplate = 1 THEN @timestamp ELSE last_opt_in_prompt_at END,
      updated_at = SYSUTCDATETIME()
    WHERE contact_id = @contactId;
    ${CONTACT_SELECT} WHERE contact_id = @contactId;`, [
    input('contactId', sql.BigInt, contactId),
    input('status', sql.VarChar(30), status),
    input('keyword', sql.NVarChar(100), keyword),
    input('source', sql.VarChar(50), source),
    input('timestamp', sql.DateTime2(3), new Date(timestamp)),
    input('setTemplate', sql.Bit, templateName !== undefined),
    input('templateName', sql.NVarChar(512), templateName ?? null),
  ]);
  return mapContact(result.recordset[0]);
}

export async function getContactById(contactId) {
  const result = await query(`${CONTACT_SELECT} WHERE contact_id = @contactId;`, [input('contactId', sql.BigInt, contactId)]);
  return mapContact(result.recordset[0]);
}
