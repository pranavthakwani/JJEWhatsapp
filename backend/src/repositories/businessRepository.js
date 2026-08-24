import { hashSecret } from '../security/secretCipher.js';
import { input, query, sql } from './sqlHelpers.js';
import { mapBusinessNumber } from './mappers.js';

const NUMBER_SELECT = `
  SELECT number.*, account.name AS business_account_name, account.meta_waba_id
  FROM jje.phone_numbers number
  INNER JOIN jje.business_accounts account ON account.business_account_id = number.business_account_id
`;

export function toPublicBusinessNumber(number) {
  if (!number) return null;
  const { accessToken: _accessToken, verifyToken: _verifyToken, ...publicNumber } = number;
  return publicNumber;
}

export async function listBusinessNumbers() {
  const result = await query(`${NUMBER_SELECT}
    WHERE number.status = 'active'
    ORDER BY number.is_default DESC, number.display_name ASC;`);
  return result.recordset.map(mapBusinessNumber);
}

export async function getBusinessNumberById(id) {
  const result = await query(`${NUMBER_SELECT} WHERE number.phone_number_id = @id;`, [
    input('id', sql.BigInt, id),
  ]);
  return mapBusinessNumber(result.recordset[0]);
}

export async function getBusinessNumberByPhoneNumberId(metaPhoneNumberId) {
  const result = await query(`${NUMBER_SELECT} WHERE number.meta_phone_number_id = @metaPhoneNumberId;`, [
    input('metaPhoneNumberId', sql.VarChar(100), metaPhoneNumberId),
  ]);
  return mapBusinessNumber(result.recordset[0]);
}

export async function getBusinessNumberByVerifyToken(verifyToken) {
  const result = await query(`${NUMBER_SELECT}
    WHERE number.verify_token_hash = @verifyTokenHash AND number.status = 'active';`, [
    input('verifyTokenHash', sql.Binary(32), hashSecret(verifyToken)),
  ]);
  return mapBusinessNumber(result.recordset[0]);
}

export async function getDefaultBusinessNumber() {
  const result = await query(`${NUMBER_SELECT}
    WHERE number.status = 'active'
    ORDER BY number.is_default DESC, number.phone_number_id ASC
    OFFSET 0 ROWS FETCH NEXT 1 ROW ONLY;`);
  return mapBusinessNumber(result.recordset[0]);
}
