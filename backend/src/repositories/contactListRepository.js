import { normaliseRecipientWaId } from '../utils/messageFormat.js';
import { bulkUpsertContacts, getContactById } from './contactRepository.js';
import { input, query, sql } from './sqlHelpers.js';
import { mapContact, mapContactList } from './mappers.js';

const LIST_SELECT = `
  SELECT list.contact_list_id, list.phone_number_id, list.name, list.source,
         list.is_archived, list.cleared_at, list.created_at, list.updated_at,
         COUNT(member.contact_list_member_id) AS member_count
  FROM jje.contact_lists list
  LEFT JOIN jje.contact_list_members member ON member.contact_list_id = list.contact_list_id
`;

function dedupeContacts(contacts) {
  const seen = new Set();
  return contacts.filter((contact) => {
    const key = normaliseRecipientWaId(contact?.waId || contact?.phoneNumber) || `id:${contact?.id}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveContacts(contacts) {
  const existing = [];
  const raw = [];
  for (const contact of contacts || []) {
    const contactId = contact.contactId || contact.id;
    if (contactId) {
      const found = await getContactById(contactId);
      if (found) existing.push(found);
    } else {
      raw.push(contact);
    }
  }
  return dedupeContacts([...existing, ...(await bulkUpsertContacts(raw))]);
}

async function replaceMembers(listId, contacts) {
  const memberJson = JSON.stringify(contacts.map((contact, index) => ({ contactId: contact.id, position: index })));
  await query(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DELETE FROM jje.contact_list_members WHERE contact_list_id = @listId;
    INSERT jje.contact_list_members(contact_list_id, contact_id, position)
    SELECT @listId, source.contact_id, source.position
    FROM OPENJSON(@membersJson) WITH (contact_id bigint '$.contactId', position int '$.position') source;
    UPDATE jje.contact_lists SET updated_at = SYSUTCDATETIME() WHERE contact_list_id = @listId;
    COMMIT TRANSACTION;`, [
    input('listId', sql.BigInt, listId),
    input('membersJson', sql.NVarChar(sql.MAX), memberJson),
  ]);
}

export async function listContactLists(phoneNumberId = null) {
  const result = await query(`${LIST_SELECT}
    WHERE list.is_archived = 0 AND (@phoneNumberId IS NULL OR list.phone_number_id = @phoneNumberId)
    GROUP BY list.contact_list_id, list.phone_number_id, list.name, list.source,
      list.is_archived, list.cleared_at, list.created_at, list.updated_at
    ORDER BY list.created_at DESC;`, [input('phoneNumberId', sql.BigInt, phoneNumberId || null)]);
  return result.recordset.map((row) => mapContactList(row, [], row.member_count));
}

export async function getContactListById(id) {
  const listResult = await query(`${LIST_SELECT}
    WHERE list.contact_list_id = @id
    GROUP BY list.contact_list_id, list.phone_number_id, list.name, list.source,
      list.is_archived, list.cleared_at, list.created_at, list.updated_at;`, [input('id', sql.BigInt, id)]);
  const row = listResult.recordset[0];
  if (!row) return null;
  const members = await query(`
    SELECT member.contact_list_member_id, member.position,
      contact.contact_id, contact.wa_id, contact.phone_number, contact.profile_name,
      contact.business_name, contact.notes, contact.opt_in_status, contact.opt_in_keyword,
      contact.opt_in_source, contact.opt_in_updated_at, contact.last_opt_in_template,
      contact.last_opt_in_prompt_at, contact.last_inbound_at, contact.last_outbound_at,
      contact.created_at, contact.updated_at
    FROM jje.contact_list_members member
    INNER JOIN jje.contacts contact ON contact.contact_id = member.contact_id
    WHERE member.contact_list_id = @id
    ORDER BY member.position, member.contact_list_member_id;`, [input('id', sql.BigInt, id)]);
  return mapContactList(row, members.recordset.map((member) => ({
    id: Number(member.contact_list_member_id),
    position: member.position,
    contact: mapContact(member),
  })), row.member_count);
}

export async function createContactList({ phoneNumberId, name, source = 'manual', contacts = [] }) {
  const normalizedName = String(name || '').replace(/\s+/g, ' ').trim();
  if (!normalizedName) throw new Error('Broadcast list name is required');
  const inserted = await query(`
    INSERT jje.contact_lists(phone_number_id, name, source)
    OUTPUT inserted.contact_list_id
    VALUES(@phoneNumberId, @name, @source);`, [
    input('phoneNumberId', sql.BigInt, phoneNumberId),
    input('name', sql.NVarChar(240), normalizedName),
    input('source', sql.VarChar(30), source),
  ]);
  const listId = Number(inserted.recordset[0].contact_list_id);
  await replaceMembers(listId, await resolveContacts(contacts));
  return getContactListById(listId);
}

export async function replaceContactListMembers({ listId, contacts = [] }) {
  await replaceMembers(listId, await resolveContacts(contacts));
  return getContactListById(listId);
}

export async function renameContactList({ listId, name }) {
  const normalizedName = String(name || '').replace(/\s+/g, ' ').trim();
  if (!normalizedName) throw new Error('Broadcast list name is required');
  await query(`UPDATE jje.contact_lists SET name = @name, updated_at = SYSUTCDATETIME() WHERE contact_list_id = @listId;`, [
    input('listId', sql.BigInt, listId), input('name', sql.NVarChar(240), normalizedName),
  ]);
  return getContactListById(listId);
}

export async function clearContactList(listId) {
  await query(`UPDATE jje.contact_lists SET cleared_at = SYSUTCDATETIME(), is_archived = 0, updated_at = SYSUTCDATETIME() WHERE contact_list_id = @listId;`, [
    input('listId', sql.BigInt, listId),
  ]);
  return getContactListById(listId);
}

export async function archiveContactList(listId) {
  await query(`UPDATE jje.contact_lists SET cleared_at = SYSUTCDATETIME(), is_archived = 1, updated_at = SYSUTCDATETIME() WHERE contact_list_id = @listId;`, [
    input('listId', sql.BigInt, listId),
  ]);
}
