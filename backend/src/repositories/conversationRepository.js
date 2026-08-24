import { clampInteger, input, query, sql } from './sqlHelpers.js';
import { mapConversation } from './mappers.js';

const CONVERSATION_SELECT = `
  SELECT conversation.conversation_id, conversation.phone_number_id, conversation.contact_id,
         conversation.last_message_id, conversation.last_message_preview, conversation.last_message_at,
         conversation.unread_count, conversation.is_archived, conversation.cleared_at,
         number.display_name AS phone_number_label,
         contact.wa_id AS contact_wa_id, contact.phone_number AS contact_phone,
         COALESCE(NULLIF(contact.business_name, ''), NULLIF(contact.profile_name, ''), contact.phone_number, contact.wa_id) AS contact_name,
         contact.opt_in_status AS contact_opt_in_status,
         contact.opt_in_updated_at AS contact_opt_in_updated_at,
         contact.last_opt_in_template AS contact_last_opt_in_template,
         contact.last_opt_in_prompt_at AS contact_last_opt_in_prompt_at,
         contact.last_inbound_at AS contact_last_inbound_at,
         contact.last_outbound_at AS contact_last_outbound_at
  FROM jje.conversations conversation
  INNER JOIN jje.contacts contact ON contact.contact_id = conversation.contact_id
  INNER JOIN jje.phone_numbers number ON number.phone_number_id = conversation.phone_number_id
`;

function parseCursor(cursor) {
  if (!cursor) return { time: null, id: null };
  const [time, rawId] = String(cursor).split('|');
  const id = Number(rawId);
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? { time: null, id: null } : { time: date, id: Number.isFinite(id) ? id : null };
}

function makeCursor(time, id) {
  return time ? `${new Date(time).toISOString()}|${id}` : null;
}

export async function ensureConversation(phoneNumberId, contactId) {
  const result = await query(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @conversationId bigint;
    SELECT @conversationId = conversation_id
    FROM jje.conversations WITH (UPDLOCK, HOLDLOCK)
    WHERE phone_number_id = @phoneNumberId AND contact_id = @contactId;
    IF @conversationId IS NULL
    BEGIN
      INSERT jje.conversations(phone_number_id, contact_id) VALUES(@phoneNumberId, @contactId);
      SET @conversationId = SCOPE_IDENTITY();
    END
    ELSE
      UPDATE jje.conversations SET is_archived = 0, updated_at = SYSUTCDATETIME() WHERE conversation_id = @conversationId;
    COMMIT TRANSACTION;
    SELECT @conversationId AS conversation_id;`, [
    input('phoneNumberId', sql.BigInt, phoneNumberId),
    input('contactId', sql.BigInt, contactId),
  ]);
  return Number(result.recordset[0].conversation_id);
}

export async function touchConversation({ conversationId, messageId, preview, timestamp, unreadIncrement = 0 }) {
  await query(`
    UPDATE jje.conversations SET
      last_message_id = @messageId,
      last_message_preview = @preview,
      last_message_at = @timestamp,
      unread_count = CASE WHEN @unreadIncrement > 0 THEN unread_count + @unreadIncrement ELSE unread_count END,
      is_archived = 0,
      updated_at = SYSUTCDATETIME()
    WHERE conversation_id = @conversationId;`, [
    input('conversationId', sql.BigInt, conversationId),
    input('messageId', sql.BigInt, messageId),
    input('preview', sql.NVarChar(500), String(preview || '').slice(0, 500) || null),
    input('timestamp', sql.DateTime2(3), timestamp ? new Date(timestamp) : new Date()),
    input('unreadIncrement', sql.Int, Math.max(0, Number(unreadIncrement) || 0)),
  ]);
}

export async function markConversationRead(conversationId) {
  await query(`UPDATE jje.conversations SET unread_count = 0, updated_at = SYSUTCDATETIME() WHERE conversation_id = @conversationId;`, [
    input('conversationId', sql.BigInt, conversationId),
  ]);
}

export async function refreshConversationPreview(conversationId) {
  await query(`
    DECLARE @clearedAt datetime2(3);
    SELECT @clearedAt = cleared_at FROM jje.conversations WHERE conversation_id = @conversationId;
    DECLARE @messageId bigint, @preview nvarchar(500), @messageAt datetime2(3);
    SELECT TOP (1)
      @messageId = message_id,
      @preview = LEFT(COALESCE(NULLIF(text_body, ''), NULLIF(caption, ''), CONCAT('[', message_type, ']')), 500),
      @messageAt = created_at
    FROM jje.messages
    WHERE conversation_id = @conversationId AND deleted_at IS NULL
      AND (@clearedAt IS NULL OR created_at > @clearedAt)
    ORDER BY created_at DESC, message_id DESC;
    UPDATE jje.conversations SET last_message_id = @messageId, last_message_preview = @preview,
      last_message_at = @messageAt, updated_at = SYSUTCDATETIME()
    WHERE conversation_id = @conversationId;`, [input('conversationId', sql.BigInt, conversationId)]);
  return getConversationById(conversationId);
}

export async function clearConversation(conversationId) {
  await query(`
    UPDATE jje.conversations SET last_message_id = NULL, last_message_preview = NULL,
      last_message_at = NULL, unread_count = 0, cleared_at = SYSUTCDATETIME(),
      is_archived = 0, updated_at = SYSUTCDATETIME()
    WHERE conversation_id = @conversationId;`, [input('conversationId', sql.BigInt, conversationId)]);
  return getConversationById(conversationId);
}

export async function archiveConversation(conversationId) {
  await query(`
    UPDATE jje.conversations SET last_message_id = NULL, last_message_preview = NULL,
      last_message_at = NULL, unread_count = 0, cleared_at = SYSUTCDATETIME(),
      is_archived = 1, updated_at = SYSUTCDATETIME()
    WHERE conversation_id = @conversationId;`, [input('conversationId', sql.BigInt, conversationId)]);
}

export async function listRecentInboundWaMessageIds(conversationId, limit = 20) {
  const result = await query(`
    SELECT provider_message_id
    FROM jje.messages
    WHERE conversation_id = @conversationId AND direction = 'inbound'
      AND deleted_at IS NULL AND provider_message_id IS NOT NULL
    ORDER BY created_at DESC, message_id DESC
    OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY;`, [
    input('conversationId', sql.BigInt, conversationId),
    input('limit', sql.Int, clampInteger(limit, 20, 1, 100)),
  ]);
  return result.recordset.map((row) => row.provider_message_id);
}

export async function getConversationById(id) {
  const result = await query(`${CONVERSATION_SELECT} WHERE conversation.conversation_id = @id;`, [
    input('id', sql.BigInt, id),
  ]);
  return mapConversation(result.recordset[0]);
}

export async function listConversations({ phoneNumberId, search = '', limit = 40, cursor = null }) {
  const requestedLimit = clampInteger(limit, 40, 1, 100);
  const parsedCursor = parseCursor(cursor);
  const trimmedSearch = String(search || '').trim();
  const result = await query(`${CONVERSATION_SELECT}
    WHERE conversation.is_archived = 0
      AND (@phoneNumberId IS NULL OR conversation.phone_number_id = @phoneNumberId)
      AND (@search = '' OR contact.wa_id LIKE @searchPattern OR contact.phone_number LIKE @searchPattern
           OR contact.profile_name LIKE @searchPattern OR contact.business_name LIKE @searchPattern)
      AND (@cursorTime IS NULL OR conversation.last_message_at < @cursorTime
           OR (conversation.last_message_at = @cursorTime AND conversation.conversation_id < @cursorId))
    ORDER BY conversation.last_message_at DESC, conversation.conversation_id DESC
    OFFSET 0 ROWS FETCH NEXT @take ROWS ONLY;`, [
    input('phoneNumberId', sql.BigInt, phoneNumberId || null),
    input('search', sql.NVarChar(500), trimmedSearch),
    input('searchPattern', sql.NVarChar(500), `%${trimmedSearch}%`),
    input('cursorTime', sql.DateTime2(3), parsedCursor.time),
    input('cursorId', sql.BigInt, parsedCursor.id),
    input('take', sql.Int, requestedLimit + 1),
  ]);
  const hasMore = result.recordset.length > requestedLimit;
  const rows = result.recordset.slice(0, requestedLimit);
  return {
    items: rows.map(mapConversation),
    nextCursor: hasMore && rows.length ? makeCursor(rows.at(-1).last_message_at, rows.at(-1).conversation_id) : null,
  };
}
