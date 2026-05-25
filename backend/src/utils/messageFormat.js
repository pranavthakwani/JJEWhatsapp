import { env } from '../config/env.js';

const MEDIA_LABELS = {
  image: '[Image]',
  document: '[Document]',
  video: '[Video]',
  audio: '[Audio]',
  sticker: '[Sticker]',
  reaction: '[Reaction]',
  template: '[Template]',
  interactive: '[Interactive]',
  button: '[Button]',
  unknown: '[Message]',
};

export function normaliseRecipientWaId(value) {
  if (!value) return null;

  const digits = String(value).replace(/\D/g, '');

  if (!digits) return null;
  if (digits.length === 10) return `${env.defaultCountryCode}${digits}`;

  return digits;
}

export function buildMessagePreview(message) {
  const text = message.text_body || message.textBody || message.caption;
  if (text && text.trim()) return text.trim().slice(0, 240);

  return MEDIA_LABELS[message.message_type || message.messageType || 'unknown'] || '[Message]';
}

export function deriveMessageType(message) {
  const keys = ['text', 'image', 'document', 'video', 'audio', 'sticker', 'reaction', 'button', 'interactive'];
  return keys.find((key) => message[key]) || message.type || 'unknown';
}

export function extractInboundMessageParts(message) {
  const messageType = deriveMessageType(message);
  const textBody =
    message.text?.body ||
    message.button?.text ||
    message.interactive?.button_reply?.title ||
    message.interactive?.list_reply?.title ||
    message.reaction?.emoji ||
    null;

  const mediaNode = message[messageType] || {};

  return {
    messageType,
    textBody,
    caption: mediaNode.caption || null,
    mediaId: mediaNode.id || null,
    mimeType: mediaNode.mime_type || null,
    fileName: mediaNode.filename || null,
    parentWaMessageId: message.context?.id || null,
  };
}

export function toDateFromUnixSeconds(value) {
  if (!value) return null;
  return new Date(Number(value) * 1000);
}
