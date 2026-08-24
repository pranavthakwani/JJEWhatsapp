import crypto from 'node:crypto';
import { env } from '../config/env.js';

export function verifyMetaSignature(req) {
  if (!env.metaAppSecret) return !env.isProduction;
  const signature = String(req.headers['x-hub-signature-256'] || '');
  const [algorithm, receivedDigest] = signature.split('=');
  if (algorithm !== 'sha256' || !receivedDigest || !Buffer.isBuffer(req.rawBody)) return false;
  const expectedDigest = crypto.createHmac('sha256', env.metaAppSecret).update(req.rawBody).digest('hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  const received = Buffer.from(receivedDigest, 'hex');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
