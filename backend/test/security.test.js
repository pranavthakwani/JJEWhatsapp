import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword } from '../src/services/authService.js';
import { decryptSecret, encryptSecret, hashSecret } from '../src/security/secretCipher.js';
import { buildMessagePreview, extractInboundMessageParts, normaliseRecipientWaId } from '../src/utils/messageFormat.js';
import { normalizeExtraction } from '../src/ai/extractionService.js';
import { extractPrices, isLikelyPriceFollowup } from '../src/ai/priceParser.js';
import { toPublicBusinessNumber } from '../src/repositories/businessRepository.js';
import { dataDeletionPage, privacyPolicyPage } from '../src/legalPages.js';

test('password hashes are salted and reject invalid credentials', () => {
  const first = hashPassword('a-production-password');
  const second = hashPassword('a-production-password');
  assert.notEqual(first, second);
  assert.equal(verifyPassword('a-production-password', first), true);
  assert.equal(verifyPassword('wrong-password', first), false);
});

test('application secrets use authenticated encryption', () => {
  const encrypted = encryptSecret('private-value');
  assert.equal(decryptSecret(encrypted), 'private-value');
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptSecret(tampered));
  assert.equal(hashSecret('same-value').equals(hashSecret('same-value')), true);
});

test('WhatsApp payload normalization is deterministic', () => {
  assert.equal(normaliseRecipientWaId('98765 43210'), '919876543210');
  assert.deepEqual(extractInboundMessageParts({
    text: { body: 'Yes' },
    context: { id: 'parent-1' },
  }), {
    messageType: 'text',
    textBody: 'Yes',
    caption: null,
    mediaId: null,
    mimeType: null,
    fileName: null,
    parentWaMessageId: 'parent-1',
  });
  assert.equal(buildMessagePreview({ messageType: 'image' }), '[Image]');
});

test('AI extraction normalization bounds untrusted model output', () => {
  const result = normalizeExtraction({
    isBusinessMessage: true,
    classification: 'offering',
    actorType: 'dealer',
    confidence: 2,
    items: [{ brand: ' Apple ', model: 'iPhone 17', ramGb: '8', storageGb: 256, colors: { Black: 4 }, priceMin: -5, priceMax: 90000 }],
  });
  assert.equal(result.classification, 'offering');
  assert.equal(result.confidence, 0);
  assert.equal(result.items[0].brand, 'Apple');
  assert.equal(result.items[0].ramGb, 8);
  assert.equal(result.items[0].priceMin, null);
  assert.deepEqual(result.items[0].colors, [{ name: 'Black', quantity: 4 }]);
});

test('price follow-up parser recognizes rates without treating quantities as prices', () => {
  assert.deepEqual(extractPrices('final 13.5k, 14,250 with gst'), [13_500, 14_250]);
  assert.equal(isLikelyPriceFollowup('best price 13.5k'), true);
  assert.equal(isLikelyPriceFollowup('50 pcs available'), false);
  assert.equal(isLikelyPriceFollowup('Samsung A55 available 25000'), false);
});

test('public business number DTO never serializes Meta credentials', () => {
  const publicNumber = toPublicBusinessNumber({ id: 1, displayName: 'JJE', accessToken: 'secret', verifyToken: 'verify' });
  assert.deepEqual(publicNumber, { id: 1, displayName: 'JJE' });
  assert.equal(JSON.stringify(publicNumber).includes('secret'), false);
});

test('public legal pages include required privacy and deletion information', () => {
  const privacy = privacyPolicyPage();
  const deletion = dataDeletionPage();
  assert.match(privacy, /Privacy Policy/);
  assert.match(privacy, /Information we process/);
  assert.match(privacy, /Data Deletion Instructions/);
  assert.match(deletion, /DELETE MY DATA/);
  assert.doesNotMatch(`${privacy}${deletion}`, /META_ACCESS_TOKEN|DB_PASSWORD/);
});
