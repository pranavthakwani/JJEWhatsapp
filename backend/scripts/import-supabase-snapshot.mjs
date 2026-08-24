import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import sql from 'mssql';
import { env } from '../src/config/env.js';
import { encryptSecret, hashSecret } from '../src/security/secretCipher.js';

const MAGIC = Buffer.from('JJESUP01');
const LEGACY_SOURCE = 'jjewa-supabase';
const apply = process.argv.includes('--apply');
const snapshotArgument = process.argv.slice(2).find((value) => !value.startsWith('--'));
if (!snapshotArgument) throw new Error('Usage: node scripts/import-supabase-snapshot.mjs <snapshot-directory> [--apply]');
if (String(env.database.database).toLowerCase() !== 'kore_demo') throw new Error('Refusing import outside Kore_Demo.');

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function validDate(value) { return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null; }
function integer(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback; }
function oneOf(value, allowed, fallback) { return allowed.includes(value) ? value : fallback; }
function json(value, fallback = null) {
  let normalized = value;
  if (typeof normalized === 'string') {
    try { normalized = JSON.parse(normalized); } catch { normalized = fallback; }
  }
  if (normalized === undefined || normalized === null) normalized = fallback;
  return normalized === undefined || normalized === null ? null : JSON.stringify(normalized);
}
function rowHash(row) { return sha256(Buffer.from(JSON.stringify(row))); }

const snapshotDirectory = path.resolve(snapshotArgument);
const manifest = JSON.parse(await fs.readFile(path.join(snapshotDirectory, 'manifest.json'), 'utf8'));
if (manifest.format !== 'jje-supabase-snapshot-v1' || !manifest.completedAt) throw new Error('Snapshot is incomplete or unsupported.');

const key = crypto.createHash('sha256').update(env.auth.tokenEncryptionKey).digest();
const tables = new Map();
let loadedRows = 0;

for (const table of manifest.tables) {
  const rows = [];
  for (const page of table.pages) {
    const contents = await fs.readFile(path.join(snapshotDirectory, page.file));
    if (sha256(contents) !== page.encryptedSha256 || !contents.subarray(0, 8).equals(MAGIC)) throw new Error(`Snapshot integrity failure: ${page.file}`);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, contents.subarray(8, 20));
    decipher.setAuthTag(contents.subarray(20, 36));
    const plaintext = gunzipSync(Buffer.concat([decipher.update(contents.subarray(36)), decipher.final()]));
    if (sha256(plaintext) !== page.plaintextSha256) throw new Error(`Snapshot plaintext checksum failure: ${page.file}`);
    const pageRows = JSON.parse(plaintext.toString('utf8'));
    if (!Array.isArray(pageRows) || pageRows.length !== page.rows) throw new Error(`Snapshot row-count failure: ${page.file}`);
    rows.push(...pageRows);
  }
  if (rows.length !== table.exportedRows) throw new Error(`Snapshot table-count failure: ${table.name}`);
  tables.set(table.name, rows);
  loadedRows += rows.length;
}
if (loadedRows !== manifest.totalRows) throw new Error('Snapshot total-count failure.');

const requiredTables = ['wa_business_accounts', 'wa_phone_numbers', 'wa_contacts', 'wa_conversations', 'wa_messages'];
for (const table of requiredTables) if (!tables.has(table)) throw new Error(`Required snapshot table is missing: ${table}`);

const sourceIds = (name) => new Set((tables.get(name) || []).map((row) => String(row.id)));
function assertReferences(table, column, targetTable, { nullable = false } = {}) {
  const targets = sourceIds(targetTable);
  for (const row of tables.get(table) || []) {
    if ((row[column] === null || row[column] === undefined) && nullable) continue;
    if (!targets.has(String(row[column]))) throw new Error(`${table}.${column} references missing ${targetTable} id ${row[column]}`);
  }
}
assertReferences('wa_phone_numbers', 'business_account_id', 'wa_business_accounts');
assertReferences('wa_conversations', 'phone_number_id', 'wa_phone_numbers');
assertReferences('wa_conversations', 'contact_id', 'wa_contacts');
assertReferences('wa_messages', 'conversation_id', 'wa_conversations');
assertReferences('wa_messages', 'phone_number_id', 'wa_phone_numbers');
assertReferences('wa_messages', 'contact_id', 'wa_contacts');

console.log(`SNAPSHOT_READY tables=${manifest.tableCount} rows=${loadedRows} mode=${apply ? 'apply' : 'dry-run'}`);

const pool = await new sql.ConnectionPool({
  server: env.database.server, database: env.database.database, user: env.database.user, password: env.database.password,
  port: env.database.port, options: { encrypt: env.database.encrypt, trustServerCertificate: env.database.trustServerCertificate, enableArithAbort: true },
  pool: { min: 0, max: 2, idleTimeoutMillis: 10_000 }, connectionTimeout: env.database.connectionTimeoutMs, requestTimeout: 120_000,
}).connect();

const identity = await pool.request().query(`SELECT DB_NAME() database_name,
  CASE WHEN OBJECT_ID(N'jje.legacy_import_map', N'U') IS NULL THEN 0 ELSE 1 END import_ready;`);
if (identity.recordset[0]?.database_name !== 'Kore_Demo') throw new Error('Connected to an unexpected database.');
if (!apply) {
  const counts = await pool.request().query(`SELECT
    (SELECT COUNT_BIG(*) FROM jje.contacts) contacts,
    (SELECT COUNT_BIG(*) FROM jje.conversations) conversations,
    (SELECT COUNT_BIG(*) FROM jje.messages) messages;`);
  console.log(`DRY_RUN_OK currentContacts=${counts.recordset[0].contacts} currentConversations=${counts.recordset[0].conversations} currentMessages=${counts.recordset[0].messages} migrationReady=${Boolean(identity.recordset[0].import_ready)}`);
  await pool.close();
  process.exit(0);
}
if (!identity.recordset[0]?.import_ready) throw new Error('Apply database migration 005 before importing.');

const transaction = new sql.Transaction(pool);
await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

async function mergeRows(rows, statement, chunkSize = 500) {
  const mapping = new Map();
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const result = await new sql.Request(transaction)
      .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(chunk))
      .query(statement);
    for (const row of result.recordset || []) mapping.set(String(row.source_id), Number(row.target_id));
  }
  return mapping;
}

const trackingSql = (sourceTable, targetTable) => `
  MERGE jje.legacy_import_map AS target USING @mapped AS source
    ON target.legacy_source = '${LEGACY_SOURCE}' AND target.source_table = '${sourceTable}' AND target.source_id = source.source_id
  WHEN MATCHED THEN UPDATE SET target.target_table='${targetTable}', target.target_id=source.target_id,
    target.source_hash=source.source_hash, target.updated_at=SYSUTCDATETIME()
  WHEN NOT MATCHED THEN INSERT(legacy_source,source_table,source_id,target_table,target_id,source_hash)
    VALUES('${LEGACY_SOURCE}','${sourceTable}',source.source_id,'${targetTable}',source.target_id,source.source_hash);
  SELECT source_id,target_id FROM @mapped;`;

try {
  const businessRows = (tables.get('wa_business_accounts') || []).map((row) => ({ ...row, source_hash: rowHash(row) }));
  const businessMap = await mergeRows(businessRows, `
    DECLARE @mapped TABLE(source_id nvarchar(200),target_id bigint,source_hash char(64));
    MERGE jje.business_accounts AS target USING (SELECT * FROM OPENJSON(@payload) WITH
      (legacy_id bigint '$.id', waba_id varchar(100) '$.waba_id', name nvarchar(200) '$.name', status varchar(20) '$.status', source_hash char(64) '$.source_hash')) AS source
    ON target.meta_waba_id=source.waba_id
    WHEN MATCHED THEN UPDATE SET target.name=source.name,target.status=CASE WHEN source.status='inactive' THEN 'inactive' ELSE 'active' END,target.updated_at=SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT(meta_waba_id,name,status) VALUES(source.waba_id,source.name,CASE WHEN source.status='inactive' THEN 'inactive' ELSE 'active' END)
    OUTPUT CONVERT(nvarchar(200),source.legacy_id),inserted.business_account_id,source.source_hash INTO @mapped;
    ${trackingSql('wa_business_accounts', 'business_accounts')}`);

  const phoneRows = (tables.get('wa_phone_numbers') || []).map((row) => ({
    ...row, target_business_account_id: businessMap.get(String(row.business_account_id)),
    access_cipher_hex: encryptSecret(row.access_token).toString('hex'), verify_hash_hex: hashSecret(row.verify_token).toString('hex'), source_hash: rowHash(row),
  }));
  const phoneMap = await mergeRows(phoneRows, `
    DECLARE @mapped TABLE(source_id nvarchar(200),target_id bigint,source_hash char(64));
    MERGE jje.phone_numbers AS target USING (SELECT * FROM OPENJSON(@payload) WITH
      (legacy_id bigint '$.id', business_account_id bigint '$.target_business_account_id', display_name nvarchar(200) '$.display_name', phone_number varchar(32) '$.phone_number', meta_id varchar(100) '$.phone_number_id', access_hex varchar(max) '$.access_cipher_hex', verify_hex varchar(64) '$.verify_hash_hex', api_version varchar(20) '$.api_version', webhook_path nvarchar(500) '$.webhook_path', is_default bit '$.is_default', status varchar(20) '$.status', source_hash char(64) '$.source_hash')) AS source
    ON target.meta_phone_number_id=source.meta_id
    WHEN MATCHED THEN UPDATE SET target.display_name=source.display_name,target.phone_number=source.phone_number,target.api_version=source.api_version,target.webhook_path=source.webhook_path,target.status=CASE WHEN source.status='inactive' THEN 'inactive' ELSE 'active' END,target.updated_at=SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT(business_account_id,display_name,phone_number,meta_phone_number_id,access_token_cipher,verify_token_hash,api_version,webhook_path,is_default,status)
      VALUES(source.business_account_id,source.display_name,source.phone_number,source.meta_id,CONVERT(varbinary(max),source.access_hex,2),CONVERT(binary(32),source.verify_hex,2),source.api_version,source.webhook_path,0,CASE WHEN source.status='inactive' THEN 'inactive' ELSE 'active' END)
    OUTPUT CONVERT(nvarchar(200),source.legacy_id),inserted.phone_number_id,source.source_hash INTO @mapped;
    ${trackingSql('wa_phone_numbers', 'phone_numbers')}`);

  const contactRows = (tables.get('wa_contacts') || []).map((row) => ({ ...row,
    opt_in_status: oneOf(row.opt_in_status, ['unknown','pending_initial','pending_followup','opted_in','opted_out'], 'unknown'), source_hash: rowHash(row) }));
  const contactMap = await mergeRows(contactRows, `
    DECLARE @mapped TABLE(source_id nvarchar(200),target_id bigint,source_hash char(64));
    MERGE jje.contacts AS target USING (SELECT * FROM OPENJSON(@payload) WITH
      (legacy_id bigint '$.id',wa_id varchar(64) '$.wa_id',phone_number varchar(32) '$.phone_number',profile_name nvarchar(240) '$.profile_name',business_name nvarchar(240) '$.business_directory_name',notes nvarchar(2000) '$.notes',opt_status varchar(30) '$.opt_in_status',opt_keyword nvarchar(100) '$.opt_in_keyword',opt_source varchar(50) '$.opt_in_source',opt_updated datetime2(3) '$.opt_in_updated_at',last_template nvarchar(512) '$.last_opt_in_template_name',last_prompt datetime2(3) '$.last_opt_in_prompt_at',last_inbound datetime2(3) '$.last_inbound_at',last_outbound datetime2(3) '$.last_outbound_at',created_at datetime2(3) '$.created_at',updated_at datetime2(3) '$.updated_at',source_hash char(64) '$.source_hash')) AS source
    ON target.wa_id=source.wa_id
    WHEN MATCHED THEN UPDATE SET target.phone_number=COALESCE(source.phone_number,target.phone_number),target.profile_name=COALESCE(source.profile_name,target.profile_name),target.business_name=COALESCE(source.business_name,target.business_name),target.notes=COALESCE(source.notes,target.notes),target.opt_in_status=source.opt_status,target.opt_in_keyword=source.opt_keyword,target.opt_in_source=source.opt_source,target.opt_in_updated_at=source.opt_updated,target.last_opt_in_template=source.last_template,target.last_opt_in_prompt_at=source.last_prompt,target.last_inbound_at=source.last_inbound,target.last_outbound_at=source.last_outbound,target.updated_at=COALESCE(source.updated_at,SYSUTCDATETIME())
    WHEN NOT MATCHED THEN INSERT(wa_id,phone_number,profile_name,business_name,notes,opt_in_status,opt_in_keyword,opt_in_source,opt_in_updated_at,last_opt_in_template,last_opt_in_prompt_at,last_inbound_at,last_outbound_at,created_at,updated_at)
      VALUES(source.wa_id,source.phone_number,source.profile_name,source.business_name,source.notes,source.opt_status,source.opt_keyword,source.opt_source,source.opt_updated,source.last_template,source.last_prompt,source.last_inbound,source.last_outbound,COALESCE(source.created_at,SYSUTCDATETIME()),COALESCE(source.updated_at,SYSUTCDATETIME()))
    OUTPUT CONVERT(nvarchar(200),source.legacy_id),inserted.contact_id,source.source_hash INTO @mapped;
    ${trackingSql('wa_contacts', 'contacts')}`);

  const conversationRows = (tables.get('wa_conversations') || []).map((row) => ({ ...row,
    target_phone_number_id: phoneMap.get(String(row.phone_number_id)), target_contact_id: contactMap.get(String(row.contact_id)), source_hash: rowHash(row) }));
  const conversationMap = await mergeRows(conversationRows, `
    DECLARE @mapped TABLE(source_id nvarchar(200),target_id bigint,source_hash char(64));
    MERGE jje.conversations AS target USING (SELECT * FROM OPENJSON(@payload) WITH
      (legacy_id bigint '$.id',phone_id bigint '$.target_phone_number_id',contact_id bigint '$.target_contact_id',preview nvarchar(500) '$.last_message_preview',last_at datetime2(3) '$.last_message_at',unread int '$.unread_count',archived bit '$.is_archived',cleared datetime2(3) '$.cleared_at',created_at datetime2(3) '$.created_at',updated_at datetime2(3) '$.updated_at',source_hash char(64) '$.source_hash')) AS source
    ON target.phone_number_id=source.phone_id AND target.contact_id=source.contact_id
    WHEN MATCHED THEN UPDATE SET target.last_message_preview=source.preview,target.last_message_at=source.last_at,target.unread_count=CASE WHEN source.unread<0 THEN 0 ELSE source.unread END,target.is_archived=source.archived,target.cleared_at=source.cleared,target.updated_at=COALESCE(source.updated_at,SYSUTCDATETIME())
    WHEN NOT MATCHED THEN INSERT(phone_number_id,contact_id,last_message_preview,last_message_at,unread_count,is_archived,cleared_at,created_at,updated_at)
      VALUES(source.phone_id,source.contact_id,source.preview,source.last_at,CASE WHEN source.unread<0 THEN 0 ELSE source.unread END,source.archived,source.cleared,COALESCE(source.created_at,SYSUTCDATETIME()),COALESCE(source.updated_at,SYSUTCDATETIME()))
    OUTPUT CONVERT(nvarchar(200),source.legacy_id),inserted.conversation_id,source.source_hash INTO @mapped;
    ${trackingSql('wa_conversations', 'conversations')}`);

  const listRows = (tables.get('wa_contact_lists') || []).map((row) => ({ ...row, target_phone_number_id: phoneMap.get(String(row.phone_number_id)), source_hash: rowHash(row) }));
  const listMap = await mergeRows(listRows, `
    DECLARE @mapped TABLE(source_id nvarchar(200),target_id bigint,source_hash char(64));
    MERGE jje.contact_lists AS target USING (SELECT * FROM OPENJSON(@payload) WITH
      (legacy_id bigint '$.id',phone_id bigint '$.target_phone_number_id',name nvarchar(240) '$.name',source_name varchar(30) '$.source',archived bit '$.is_archived',cleared datetime2(3) '$.cleared_at',created_at datetime2(3) '$.created_at',updated_at datetime2(3) '$.updated_at',source_hash char(64) '$.source_hash')) AS source
    ON EXISTS(SELECT 1 FROM jje.legacy_import_map map WHERE map.legacy_source='${LEGACY_SOURCE}' AND map.source_table='wa_contact_lists' AND map.source_id=CONVERT(nvarchar(200),source.legacy_id) AND map.target_id=target.contact_list_id)
    WHEN MATCHED THEN UPDATE SET target.name=source.name,target.source=source.source_name,target.is_archived=source.archived,target.cleared_at=source.cleared,target.updated_at=COALESCE(source.updated_at,SYSUTCDATETIME())
    WHEN NOT MATCHED THEN INSERT(phone_number_id,name,source,is_archived,cleared_at,created_at,updated_at) VALUES(source.phone_id,source.name,source.source_name,source.archived,source.cleared,COALESCE(source.created_at,SYSUTCDATETIME()),COALESCE(source.updated_at,SYSUTCDATETIME()))
    OUTPUT CONVERT(nvarchar(200),source.legacy_id),inserted.contact_list_id,source.source_hash INTO @mapped;
    ${trackingSql('wa_contact_lists', 'contact_lists')}`);

  const memberRows = (tables.get('wa_contact_list_members') || []).map((row) => ({ ...row,
    target_list_id: listMap.get(String(row.list_id)), target_contact_id: contactMap.get(String(row.contact_id)), source_hash: rowHash(row) }));
  const memberMap = await mergeRows(memberRows, `
    DECLARE @mapped TABLE(source_id nvarchar(200),target_id bigint,source_hash char(64));
    MERGE jje.contact_list_members AS target USING (SELECT * FROM OPENJSON(@payload) WITH
      (legacy_id bigint '$.id',list_id bigint '$.target_list_id',contact_id bigint '$.target_contact_id',position int '$.position',created_at datetime2(3) '$.created_at',source_hash char(64) '$.source_hash')) AS source
    ON target.contact_list_id=source.list_id AND target.contact_id=source.contact_id
    WHEN MATCHED THEN UPDATE SET target.position=source.position
    WHEN NOT MATCHED THEN INSERT(contact_list_id,contact_id,position,created_at) VALUES(source.list_id,source.contact_id,source.position,COALESCE(source.created_at,SYSUTCDATETIME()))
    OUTPUT CONVERT(nvarchar(200),source.legacy_id),inserted.contact_list_member_id,source.source_hash INTO @mapped;
    ${trackingSql('wa_contact_list_members', 'contact_list_members')}`);

  const campaignRows = (tables.get('wa_campaigns') || []).map((row) => ({ ...row,
    target_phone_number_id: phoneMap.get(String(row.phone_number_id)), target_contact_list_id: row.contact_list_id == null ? null : listMap.get(String(row.contact_list_id)),
    mode: oneOf(row.mode, ['text','image','video','audio','document','template'], 'text'), status: oneOf(row.status, ['draft','pending','sending','awaiting_opt_in','completed','failed','cancelled'], 'completed'),
    template_params_text: json(row.template_params_json, []), source_hash: rowHash(row) }));
  const campaignMap = await mergeRows(campaignRows, `
    DECLARE @mapped TABLE(source_id nvarchar(200),target_id bigint,source_hash char(64));
    MERGE jje.campaigns AS target USING (SELECT * FROM OPENJSON(@payload) WITH
      (legacy_id bigint '$.id',phone_id bigint '$.target_phone_number_id',list_id bigint '$.target_contact_list_id',title nvarchar(240) '$.title',mode varchar(20) '$.mode',body nvarchar(max) '$.body_text',template_name nvarchar(512) '$.template_name',initial_name nvarchar(512) '$.initial_template_name',followup_name nvarchar(512) '$.followup_template_name',language varchar(20) '$.template_language',params nvarchar(max) '$.template_params_text',status varchar(30) '$.status',total int '$.total_recipients',sent int '$.sent_count',failed int '$.failed_count',created_at datetime2(3) '$.created_at',updated_at datetime2(3) '$.updated_at',started_at datetime2(3) '$.started_at',completed_at datetime2(3) '$.completed_at',source_hash char(64) '$.source_hash')) AS source
    ON EXISTS(SELECT 1 FROM jje.legacy_import_map map WHERE map.legacy_source='${LEGACY_SOURCE}' AND map.source_table='wa_campaigns' AND map.source_id=CONVERT(nvarchar(200),source.legacy_id) AND map.target_id=target.campaign_id)
    WHEN MATCHED THEN UPDATE SET target.title=source.title,target.status=source.status,target.sent_count=source.sent,target.failed_count=source.failed,target.updated_at=COALESCE(source.updated_at,SYSUTCDATETIME())
    WHEN NOT MATCHED THEN INSERT(phone_number_id,contact_list_id,title,mode,body_text,template_name,initial_template_name,followup_template_name,template_language,template_params_json,status,total_recipients,sent_count,failed_count,created_at,updated_at,started_at,completed_at)
      VALUES(source.phone_id,source.list_id,source.title,source.mode,source.body,source.template_name,source.initial_name,source.followup_name,source.language,source.params,source.status,source.total,source.sent,source.failed,COALESCE(source.created_at,SYSUTCDATETIME()),COALESCE(source.updated_at,SYSUTCDATETIME()),source.started_at,source.completed_at)
    OUTPUT CONVERT(nvarchar(200),source.legacy_id),inserted.campaign_id,source.source_hash INTO @mapped;
    ${trackingSql('wa_campaigns', 'campaigns')}`);

  const messageRows = (tables.get('wa_messages') || []).map((row) => ({ ...row,
    target_conversation_id: conversationMap.get(String(row.conversation_id)), target_phone_number_id: phoneMap.get(String(row.phone_number_id)), target_contact_id: contactMap.get(String(row.contact_id)),
    target_campaign_id: row.campaign_id == null ? null : campaignMap.get(String(row.campaign_id)), direction: oneOf(row.direction, ['inbound','outbound'], 'inbound'),
    template_params_text: json(row.template_params, null), source_hash: rowHash(row) }));
  const messageMap = await mergeRows(messageRows, `
    DECLARE @mapped TABLE(source_id nvarchar(200),target_id bigint,source_hash char(64));
    MERGE jje.messages AS target USING (SELECT * FROM OPENJSON(@payload) WITH
      (legacy_id bigint '$.id',conversation_id bigint '$.target_conversation_id',phone_id bigint '$.target_phone_number_id',contact_id bigint '$.target_contact_id',direction varchar(10) '$.direction',message_type varchar(30) '$.message_type',provider_id varchar(255) '$.wa_message_id',parent_provider_id varchar(255) '$.parent_wa_message_id',body nvarchar(max) '$.text_body',caption nvarchar(max) '$.caption',media_id varchar(255) '$.media_id',mime nvarchar(255) '$.mime_type',file_name nvarchar(512) '$.file_name',template_name nvarchar(512) '$.template_name',language varchar(20) '$.template_language',params nvarchar(max) '$.template_params_text',campaign_id bigint '$.target_campaign_id',status varchar(30) '$.status',error_message nvarchar(2000) '$.error_message',provider_at datetime2(3) '$.wa_timestamp',sent_at datetime2(3) '$.sent_at',delivered_at datetime2(3) '$.delivered_at',read_at datetime2(3) '$.read_at',failed_at datetime2(3) '$.failed_at',starred_at datetime2(3) '$.starred_at',deleted_at datetime2(3) '$.deleted_at',created_at datetime2(3) '$.created_at',updated_at datetime2(3) '$.updated_at',source_hash char(64) '$.source_hash')) AS source
    ON (source.provider_id IS NOT NULL AND target.provider_message_id=source.provider_id) OR EXISTS(SELECT 1 FROM jje.legacy_import_map map WHERE map.legacy_source='${LEGACY_SOURCE}' AND map.source_table='wa_messages' AND map.source_id=CONVERT(nvarchar(200),source.legacy_id) AND map.target_id=target.message_id)
    WHEN MATCHED THEN UPDATE SET target.status=source.status,target.delivered_at=source.delivered_at,target.read_at=source.read_at,target.failed_at=source.failed_at,target.starred_at=source.starred_at,target.deleted_at=source.deleted_at,target.updated_at=COALESCE(source.updated_at,SYSUTCDATETIME())
    WHEN NOT MATCHED THEN INSERT(conversation_id,phone_number_id,contact_id,direction,message_type,provider_message_id,parent_provider_message_id,text_body,caption,provider_media_id,mime_type,file_name,template_name,template_language,template_params_json,campaign_id,status,error_message,provider_timestamp,sent_at,delivered_at,read_at,failed_at,starred_at,deleted_at,created_at,updated_at)
      VALUES(source.conversation_id,source.phone_id,source.contact_id,source.direction,source.message_type,source.provider_id,source.parent_provider_id,source.body,source.caption,source.media_id,source.mime,source.file_name,source.template_name,source.language,source.params,source.campaign_id,source.status,source.error_message,source.provider_at,source.sent_at,source.delivered_at,source.read_at,source.failed_at,source.starred_at,source.deleted_at,COALESCE(source.created_at,SYSUTCDATETIME()),COALESCE(source.updated_at,SYSUTCDATETIME()))
    OUTPUT CONVERT(nvarchar(200),source.legacy_id),inserted.message_id,source.source_hash INTO @mapped;
    ${trackingSql('wa_messages', 'messages')}`);

  const conversationLastRows = conversationRows.filter((row) => row.last_message_id != null && messageMap.has(String(row.last_message_id)))
    .map((row) => ({ conversation_id: conversationMap.get(String(row.id)), message_id: messageMap.get(String(row.last_message_id)) }));
  if (conversationLastRows.length) await new sql.Request(transaction).input('payload', sql.NVarChar(sql.MAX), JSON.stringify(conversationLastRows)).query(`
    UPDATE conversation SET last_message_id=source.message_id FROM jje.conversations conversation
    INNER JOIN OPENJSON(@payload) WITH(conversation_id bigint '$.conversation_id',message_id bigint '$.message_id') source ON source.conversation_id=conversation.conversation_id;`);

  const templateRows = (tables.get('wa_templates') || []).map((row) => ({ ...row,
    target_phone_number_id: phoneMap.get(String(row.phone_number_id)) || [...phoneMap.values()][0], buttons_text: json(row.buttons_json, []), source_hash: rowHash(row) }));
  await mergeRows(templateRows, `
    DECLARE @mapped TABLE(source_id nvarchar(200),target_id bigint,source_hash char(64));
    MERGE jje.templates AS target USING (SELECT * FROM OPENJSON(@payload) WITH
      (legacy_id bigint '$.id',phone_id bigint '$.target_phone_number_id',name nvarchar(512) '$.template_name',category varchar(50) '$.category',language varchar(20) '$.language',status varchar(30) '$.status',header varchar(30) '$.header_format',body nvarchar(max) '$.body_text',footer nvarchar(1000) '$.footer_text',buttons nvarchar(max) '$.buttons_text',meta_id varchar(255) '$.meta_template_id',synced datetime2(3) '$.last_synced_at',created_at datetime2(3) '$.created_at',updated_at datetime2(3) '$.updated_at',source_hash char(64) '$.source_hash')) AS source
    ON target.phone_number_id=source.phone_id AND target.template_name=source.name AND target.language=source.language
    WHEN MATCHED THEN UPDATE SET target.category=source.category,target.status=source.status,target.header_format=source.header,target.body_text=source.body,target.footer_text=source.footer,target.buttons_json=source.buttons,target.meta_template_id=source.meta_id,target.last_synced_at=source.synced,target.updated_at=COALESCE(source.updated_at,SYSUTCDATETIME())
    WHEN NOT MATCHED THEN INSERT(phone_number_id,template_name,category,language,status,header_format,body_text,footer_text,buttons_json,meta_template_id,last_synced_at,created_at,updated_at)
      VALUES(source.phone_id,source.name,source.category,source.language,source.status,source.header,source.body,source.footer,source.buttons,source.meta_id,source.synced,COALESCE(source.created_at,SYSUTCDATETIME()),COALESCE(source.updated_at,SYSUTCDATETIME()))
    OUTPUT CONVERT(nvarchar(200),source.legacy_id),inserted.template_id,source.source_hash INTO @mapped;
    ${trackingSql('wa_templates', 'templates')}`);

  const providerMessageMap = new Map(messageRows.filter((row) => row.wa_message_id).map((row) => [String(row.wa_message_id), messageMap.get(String(row.id))]));
  const recipientRows = (tables.get('wa_campaign_recipients') || []).map((row) => ({ ...row,
    target_campaign_id: campaignMap.get(String(row.campaign_id)), target_member_id: row.contact_list_member_id == null ? null : memberMap.get(String(row.contact_list_member_id)),
    target_contact_id: row.contact_id == null ? null : contactMap.get(String(row.contact_id)), target_conversation_id: row.conversation_id == null ? null : conversationMap.get(String(row.conversation_id)),
    target_message_id: row.wa_message_id == null ? null : providerMessageMap.get(String(row.wa_message_id)), source_hash: rowHash(row) }));
  await mergeRows(recipientRows, `
    DECLARE @mapped TABLE(source_id nvarchar(200),target_id bigint,source_hash char(64));
    MERGE jje.campaign_recipients AS target USING (SELECT * FROM OPENJSON(@payload) WITH
      (legacy_id bigint '$.id',campaign_id bigint '$.target_campaign_id',wa_id varchar(64) '$.recipient_wa_id',name nvarchar(240) '$.recipient_name',member_id bigint '$.target_member_id',contact_id bigint '$.target_contact_id',conversation_id bigint '$.target_conversation_id',message_id bigint '$.target_message_id',pending_body nvarchar(max) '$.pending_text_body',prompt nvarchar(512) '$.prompt_template_name',status varchar(30) '$.status',error nvarchar(2000) '$.error_message',opt_requested datetime2(3) '$.opt_in_requested_at',opted_in datetime2(3) '$.opted_in_at',sent_at datetime2(3) '$.sent_at',delivered_at datetime2(3) '$.delivered_at',read_at datetime2(3) '$.read_at',failed_at datetime2(3) '$.failed_at',created_at datetime2(3) '$.created_at',updated_at datetime2(3) '$.updated_at',source_hash char(64) '$.source_hash')) AS source
    ON target.campaign_id=source.campaign_id AND target.recipient_wa_id=source.wa_id
    WHEN MATCHED THEN UPDATE SET target.status=source.status,target.message_id=source.message_id,target.error_message=source.error,target.updated_at=COALESCE(source.updated_at,SYSUTCDATETIME())
    WHEN NOT MATCHED THEN INSERT(campaign_id,recipient_wa_id,recipient_name,contact_list_member_id,contact_id,conversation_id,message_id,pending_text_body,prompt_template_name,status,error_message,opt_in_requested_at,opted_in_at,sent_at,delivered_at,read_at,failed_at,created_at,updated_at)
      VALUES(source.campaign_id,source.wa_id,source.name,source.member_id,source.contact_id,source.conversation_id,source.message_id,source.pending_body,source.prompt,source.status,source.error,source.opt_requested,source.opted_in,source.sent_at,source.delivered_at,source.read_at,source.failed_at,COALESCE(source.created_at,SYSUTCDATETIME()),COALESCE(source.updated_at,SYSUTCDATETIME()))
    OUTPUT CONVERT(nvarchar(200),source.legacy_id),inserted.campaign_recipient_id,source.source_hash INTO @mapped;
    ${trackingSql('wa_campaign_recipients', 'campaign_recipients')}`);

  const filterRows = (tables.get('wa_chat_filter_settings') || []).map((row) => ({ ...row,
    target_phone_number_id: phoneMap.get(String(row.phone_number_id)), favorite_text: json(row.favorite_keys, []), custom_text: json(row.custom_filters, []), source_hash: rowHash(row) }));
  await mergeRows(filterRows, `
    DECLARE @mapped TABLE(source_id nvarchar(200),target_id bigint,source_hash char(64));
    MERGE jje.chat_filter_settings AS target USING (SELECT * FROM OPENJSON(@payload) WITH
      (legacy_id bigint '$.id',phone_id bigint '$.target_phone_number_id',favorites nvarchar(max) '$.favorite_text',custom nvarchar(max) '$.custom_text',source_hash char(64) '$.source_hash')) AS source
    ON target.phone_number_id=source.phone_id
    WHEN MATCHED THEN UPDATE SET target.favorite_keys_json=source.favorites,target.custom_filters_json=source.custom,target.updated_at=SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT(phone_number_id,favorite_keys_json,custom_filters_json) VALUES(source.phone_id,source.favorites,source.custom)
    OUTPUT CONVERT(nvarchar(200),source.legacy_id),inserted.phone_number_id,source.source_hash INTO @mapped;
    ${trackingSql('wa_chat_filter_settings', 'chat_filter_settings')}`);

  await transaction.commit();
  const summary = await pool.request().query(`SELECT
    (SELECT COUNT_BIG(*) FROM jje.contacts) contacts,
    (SELECT COUNT_BIG(*) FROM jje.conversations) conversations,
    (SELECT COUNT_BIG(*) FROM jje.messages) messages,
    (SELECT COUNT_BIG(*) FROM jje.contact_lists) contact_lists,
    (SELECT COUNT_BIG(*) FROM jje.campaigns) campaigns,
    (SELECT COUNT_BIG(*) FROM jje.legacy_import_map WHERE legacy_source='${LEGACY_SOURCE}') mapped_rows;`);
  console.log(`IMPORT_COMPLETE ${Object.entries(summary.recordset[0]).map(([name,value]) => `${name}=${value}`).join(' ')}`);
} catch (error) {
  await transaction.rollback().catch(() => {});
  throw error;
} finally {
  await pool.close();
}
