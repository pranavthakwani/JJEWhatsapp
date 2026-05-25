import axios from 'axios';
import { env } from '../config/env.js';

function buildBaseUrl(number) {
  return `https://graph.facebook.com/${number.apiVersion || env.graphVersion}`;
}

function buildHeaders(number) {
  return {
    Authorization: `Bearer ${number.accessToken}`,
    'Content-Type': 'application/json',
  };
}

function extractResponseMessageId(response) {
  return response?.data?.messages?.[0]?.id || null;
}

function wrapMetaError(error, fallback) {
  const metaMessage = error?.response?.data?.error?.message;
  const status = error?.response?.status;
  if (metaMessage && status) {
    return new Error(`${fallback}: ${status} ${metaMessage}`);
  }

  if (metaMessage) {
    return new Error(`${fallback}: ${metaMessage}`);
  }

  return error;
}

export async function sendTextMessage({ number, to, body, replyToWaMessageId }) {
  try {
    const response = await axios.post(
      `${buildBaseUrl(number)}/${number.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        context: replyToWaMessageId ? { message_id: replyToWaMessageId } : undefined,
        text: {
          body,
          preview_url: false,
        },
      },
      {
        headers: buildHeaders(number),
        timeout: 30000,
      },
    );

    return {
      response,
      messageId: extractResponseMessageId(response),
    };
  } catch (error) {
    throw wrapMetaError(error, 'Meta text send failed');
  }
}

export async function markMessageAsRead({ number, messageId }) {
  try {
    const response = await axios.post(
      `${buildBaseUrl(number)}/${number.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      },
      {
        headers: buildHeaders(number),
        timeout: 30000,
      },
    );

    return response.data;
  } catch (error) {
    throw wrapMetaError(error, 'Meta mark read failed');
  }
}

export async function sendTemplateMessage({ number, to, templateName, languageCode, components = [] }) {
  try {
    const response = await axios.post(
      `${buildBaseUrl(number)}/${number.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: {
            code: languageCode,
          },
          components,
        },
      },
      {
        headers: buildHeaders(number),
        timeout: 30000,
      },
    );

    return {
      response,
      messageId: extractResponseMessageId(response),
    };
  } catch (error) {
    throw wrapMetaError(error, 'Meta template send failed');
  }
}

export async function uploadMedia({ number, buffer, mimeType, fileName }) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([buffer], { type: mimeType }), fileName);

  const response = await fetch(`${buildBaseUrl(number)}/${number.phoneNumberId}/media`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${number.accessToken}`,
    },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Media upload failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.id;
}

export async function sendMediaMessage({ number, to, mediaType, mediaId, caption, fileName, replyToWaMessageId }) {
  const mediaPayload = {
    id: mediaId,
  };

  if (caption) mediaPayload.caption = caption;
  if (fileName && mediaType === 'document') mediaPayload.filename = fileName;

  try {
    const response = await axios.post(
      `${buildBaseUrl(number)}/${number.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: mediaType,
        context: replyToWaMessageId ? { message_id: replyToWaMessageId } : undefined,
        [mediaType]: mediaPayload,
      },
      {
        headers: buildHeaders(number),
        timeout: 30000,
      },
    );

    return {
      response,
      messageId: extractResponseMessageId(response),
    };
  } catch (error) {
    throw wrapMetaError(error, `Meta ${mediaType} send failed`);
  }
}

export async function sendReactionMessage({ number, to, emoji, replyToWaMessageId }) {
  try {
    const response = await axios.post(
      `${buildBaseUrl(number)}/${number.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'reaction',
        reaction: {
          message_id: replyToWaMessageId,
          emoji,
        },
      },
      {
        headers: buildHeaders(number),
        timeout: 30000,
      },
    );

    return {
      response,
      messageId: extractResponseMessageId(response),
    };
  } catch (error) {
    throw wrapMetaError(error, 'Meta reaction send failed');
  }
}

export async function listMessageTemplates(number) {
  try {
    const response = await axios.get(
      `${buildBaseUrl(number)}/${number.wabaId}/message_templates`,
      {
        headers: buildHeaders(number),
        timeout: 30000,
      },
    );

    return response.data.data || [];
  } catch (error) {
    throw wrapMetaError(error, 'Meta template sync failed');
  }
}

export async function downloadMediaContent({ number, mediaId }) {
  let metadataResponse;
  try {
    metadataResponse = await axios.get(
      `${buildBaseUrl(number)}/${mediaId}`,
      {
        headers: buildHeaders(number),
        timeout: 30000,
      },
    );
  } catch (error) {
    throw wrapMetaError(error, 'Meta media metadata fetch failed');
  }

  const mediaUrl = metadataResponse.data.url;
  const mimeType = metadataResponse.data.mime_type || 'application/octet-stream';

  let binaryResponse;
  try {
    binaryResponse = await axios.get(mediaUrl, {
      headers: {
        Authorization: `Bearer ${number.accessToken}`,
      },
      responseType: 'arraybuffer',
      timeout: 60000,
    });
  } catch (error) {
    throw wrapMetaError(error, 'Meta media download failed');
  }

  return {
    buffer: binaryResponse.data,
    mimeType,
  };
}
