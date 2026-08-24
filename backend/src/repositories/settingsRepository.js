import { input, query, sql } from './sqlHelpers.js';
import { mapTemplate } from './mappers.js';

function normaliseChatFilterMemberKeys(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter((item) => /^(conversation|broadcast):\d+$/.test(item))
    : [];
}

function normaliseCustomChatFilters(value) {
  return Array.isArray(value)
    ? value.map((filter) => ({
      id: String(filter?.id || '').trim(),
      name: String(filter?.name || '').trim(),
      memberKeys: normaliseChatFilterMemberKeys(filter?.memberKeys),
      createdAt: filter?.createdAt || new Date().toISOString(),
    })).filter((filter) => filter.id && filter.name)
    : [];
}

export async function listTemplates(phoneNumberId = null) {
  const result = await query(`
    SELECT * FROM jje.templates
    WHERE @phoneNumberId IS NULL OR phone_number_id = @phoneNumberId
    ORDER BY template_name, language;`, [input('phoneNumberId', sql.BigInt, phoneNumberId || null)]);
  return result.recordset.map(mapTemplate);
}

export async function replaceTemplates(phoneNumberId, templates) {
  const serialized = JSON.stringify(templates || []);
  await query(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DELETE FROM jje.templates WHERE phone_number_id = @phoneNumberId;
    INSERT jje.templates(
      phone_number_id, template_name, category, language, status, header_format,
      body_text, footer_text, buttons_json, meta_template_id, last_synced_at
    )
    SELECT @phoneNumberId, source.template_name, source.category, source.language,
      source.status, source.header_format, source.body_text, source.footer_text,
      source.buttons_json, source.meta_template_id, SYSUTCDATETIME()
    FROM OPENJSON(@templatesJson) WITH (
      template_name nvarchar(512) '$.name', category varchar(50) '$.category',
      language varchar(20) '$.language', status varchar(30) '$.status',
      header_format varchar(30) '$.headerFormat', body_text nvarchar(max) '$.bodyText',
      footer_text nvarchar(1000) '$.footerText', buttons_json nvarchar(max) '$.buttons' AS JSON,
      meta_template_id varchar(255) '$.id'
    ) source;
    COMMIT TRANSACTION;`, [
    input('phoneNumberId', sql.BigInt, phoneNumberId),
    input('templatesJson', sql.NVarChar(sql.MAX), serialized),
  ]);
}

export async function getChatFilterSettings(phoneNumberId) {
  const result = await query(`SELECT * FROM jje.chat_filter_settings WHERE phone_number_id = @phoneNumberId;`, [
    input('phoneNumberId', sql.BigInt, phoneNumberId),
  ]);
  const row = result.recordset[0];
  return {
    phoneNumberId,
    favoriteKeys: row ? normaliseChatFilterMemberKeys(JSON.parse(row.favorite_keys_json)) : [],
    customFilters: row ? normaliseCustomChatFilters(JSON.parse(row.custom_filters_json)) : [],
    updatedAt: row?.updated_at || null,
  };
}

export async function saveChatFilterSettings(phoneNumberId, state = {}) {
  const favoriteKeys = normaliseChatFilterMemberKeys(state.favoriteKeys);
  const customFilters = normaliseCustomChatFilters(state.customFilters);
  await query(`
    UPDATE jje.chat_filter_settings SET favorite_keys_json = @favorites, custom_filters_json = @custom,
      updated_at = SYSUTCDATETIME() WHERE phone_number_id = @phoneNumberId;
    IF @@ROWCOUNT = 0
      INSERT jje.chat_filter_settings(phone_number_id, favorite_keys_json, custom_filters_json)
      VALUES(@phoneNumberId, @favorites, @custom);`, [
    input('phoneNumberId', sql.BigInt, phoneNumberId),
    input('favorites', sql.NVarChar(sql.MAX), JSON.stringify(favoriteKeys)),
    input('custom', sql.NVarChar(sql.MAX), JSON.stringify(customFilters)),
  ]);
  return getChatFilterSettings(phoneNumberId);
}
