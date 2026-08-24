import crypto from 'node:crypto';
import { env } from '../config/env.js';

const VERSION = 1;

function encryptionKey() {
  return crypto.createHash('sha256').update(env.auth.tokenEncryptionKey).digest();
}

export function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, authTag, ciphertext]);
}

export function decryptSecret(payload) {
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  if (buffer.length < 30 || buffer[0] !== VERSION) {
    throw new Error('Unsupported encrypted secret payload.');
  }
  const iv = buffer.subarray(1, 13);
  const authTag = buffer.subarray(13, 29);
  const ciphertext = buffer.subarray(29);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}
