import axios from 'axios';
import { closePool } from '../src/config/db.js';
import { getDefaultBusinessNumber } from '../src/repositories/businessRepository.js';
import { input, query, sql } from '../src/repositories/sqlHelpers.js';
import { encryptSecret } from '../src/security/secretCipher.js';

const accessToken = String(process.env.META_ACCESS_TOKEN || '').trim();
if (!accessToken) {
  throw new Error('META_ACCESS_TOKEN is required. Set it temporarily from the clipboard; never save it in source control.');
}
if (!accessToken.startsWith('EAA') || /\s/.test(accessToken) || /[^\x20-\x7E]/.test(accessToken)) {
  throw new Error('META_ACCESS_TOKEN is malformed. Copy only the complete token value from Meta; it should start with EAA and contain no spaces, labels, quotes, or line breaks.');
}

const number = await getDefaultBusinessNumber();
if (!number?.id || !number.phoneNumberId || !number.wabaId) {
  throw new Error('The default business number, Meta Phone Number ID, or WABA ID is not configured.');
}

const phoneNumberId = String(process.env.META_PHONE_NUMBER_ID || number.phoneNumberId).trim();
const wabaId = String(process.env.META_WABA_ID || number.wabaId).trim();
if (!/^\d+$/.test(phoneNumberId) || !/^\d+$/.test(wabaId)) {
  throw new Error('META_PHONE_NUMBER_ID and META_WABA_ID must contain digits only.');
}

const graphBase = `https://graph.facebook.com/${number.apiVersion || 'v22.0'}`;
const headers = { Authorization: `Bearer ${accessToken}` };

function metaMessage(error) {
  return error?.response?.data?.error?.message || error?.message || 'Unknown Meta error';
}

try {
  let phone;
  try {
    const response = await axios.get(`${graphBase}/${phoneNumberId}`, {
      headers,
      params: { fields: 'id,display_phone_number,verified_name,quality_rating' },
      proxy: false,
      timeout: 20_000,
    });
    phone = response.data;
  } catch (error) {
    throw new Error(`New token cannot access Meta Phone Number ID ${phoneNumberId}: ${metaMessage(error)}`);
  }

  let templateCount;
  try {
    const response = await axios.get(`${graphBase}/${wabaId}/message_templates`, {
      headers,
      params: { fields: 'id,name,status,language', limit: 100 },
      proxy: false,
      timeout: 20_000,
    });
    templateCount = Array.isArray(response.data?.data) ? response.data.data.length : 0;
  } catch (error) {
    throw new Error(`New token cannot manage WABA ID ${wabaId}: ${metaMessage(error)}`);
  }

  const expectedPhone = String(number.phoneNumber || '').replace(/\D/g, '');
  const metaPhone = String(phone.display_phone_number || '').replace(/\D/g, '');
  if (expectedPhone && metaPhone && expectedPhone !== metaPhone) {
    throw new Error(`Meta Phone Number ID ${phoneNumberId} belongs to ${phone.display_phone_number}, not the configured business number ${number.phoneNumber}.`);
  }

  await query(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
      UPDATE jje.business_accounts
      SET meta_waba_id = @wabaId, updated_at = SYSUTCDATETIME()
      WHERE business_account_id = @businessAccountId;
      IF @@ROWCOUNT <> 1 THROW 51000, 'Meta business account update target was not found.', 1;

      UPDATE jje.phone_numbers
      SET meta_phone_number_id = @metaPhoneNumberId,
          access_token_cipher = @cipher,
          updated_at = SYSUTCDATETIME()
      WHERE phone_number_id = @internalPhoneNumberId;
      IF @@ROWCOUNT <> 1 THROW 51000, 'Meta phone number update target was not found.', 1;
    COMMIT TRANSACTION;
  `, [
    input('cipher', sql.VarBinary(sql.MAX), encryptSecret(accessToken)),
    input('wabaId', sql.VarChar(100), wabaId),
    input('businessAccountId', sql.BigInt, number.businessAccountId),
    input('metaPhoneNumberId', sql.VarChar(100), phoneNumberId),
    input('internalPhoneNumberId', sql.BigInt, number.id),
  ]);

  console.log(JSON.stringify({
    ok: true,
    businessNumber: phone.display_phone_number || number.phoneNumber,
    verifiedName: phone.verified_name || number.displayName,
    qualityRating: phone.quality_rating || null,
    approvedTemplateAccess: true,
    templatesVisible: templateCount,
    metaPhoneNumberId: phoneNumberId,
    wabaId,
    note: 'Token encrypted in Kore_Demo. Restart the API service before testing sends.',
  }));
} finally {
  await closePool();
}
