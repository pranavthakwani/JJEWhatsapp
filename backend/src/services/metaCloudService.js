import axios from 'axios';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

const BUSINESS_PROFILE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const BUSINESS_PROFILE_NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const businessProfileCache = new Map();

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

function isWebmAudio(mimeType, fileName) {
  const normalizedMime = String(mimeType || '').toLowerCase();
  const normalizedName = String(fileName || '').toLowerCase();
  return normalizedMime.includes('audio/webm') || normalizedName.endsWith('.webm');
}

function isAppRecordedVoiceNote(mimeType, fileName) {
  const normalizedMime = String(mimeType || '').toLowerCase();
  const normalizedName = String(fileName || '').toLowerCase();
  return normalizedMime.startsWith('audio/') && (
    normalizedName.startsWith('voice-note-') ||
    normalizedName.startsWith('broadcast-voice-note-')
  );
}

function isOggOpusAudio(mimeType, fileName) {
  const normalizedMime = String(mimeType || '').toLowerCase();
  const normalizedName = String(fileName || '').toLowerCase();
  return normalizedMime.includes('audio/ogg') || normalizedMime.includes('audio/opus') || normalizedName.endsWith('.ogg');
}

function normalizeMediaMimeType(mimeType) {
  const normalizedMime = String(mimeType || '').toLowerCase();
  if (normalizedMime.includes('audio/ogg')) return 'audio/ogg';
  if (normalizedMime.includes('audio/opus')) return 'audio/opus';
  if (normalizedMime.includes('audio/mp4')) return 'audio/mp4';
  if (normalizedMime.includes('audio/mpeg')) return 'audio/mpeg';
  return mimeType;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const errorChunks = [];

    child.stderr.on('data', (chunk) => errorChunks.push(chunk));
    child.on('error', (error) => {
      reject(new Error(`ffmpeg could not start. Install ffmpeg on the server or set FFMPEG_PATH. ${error.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg conversion failed with code ${code}: ${Buffer.concat(errorChunks).toString('utf8').slice(-1200)}`));
    });
  });
}

function audioInputExtension(mimeType, fileName) {
  const normalizedMime = String(mimeType || '').toLowerCase();
  const normalizedName = String(fileName || '').toLowerCase();
  if (normalizedMime.includes('webm') || normalizedName.endsWith('.webm')) return 'webm';
  if (normalizedMime.includes('mp4') || normalizedName.endsWith('.m4a') || normalizedName.endsWith('.mp4')) return 'm4a';
  if (normalizedMime.includes('mpeg') || normalizedName.endsWith('.mp3')) return 'mp3';
  if (normalizedMime.includes('ogg') || normalizedName.endsWith('.ogg')) return 'ogg';
  return 'audio';
}

async function convertAudioToOgg(buffer, inputExtension = 'audio') {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jjewa-audio-'));
  const inputPath = path.join(tempDir, `${randomUUID()}.${inputExtension}`);
  const outputPath = path.join(tempDir, `${randomUUID()}.ogg`);

  try {
    await fs.writeFile(inputPath, buffer);
    await runFfmpeg([
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-ar',
      '48000',
      outputPath,
    ]);

    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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
        proxy: false,
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
        proxy: false,
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
        proxy: false,
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
  let uploadBuffer = buffer;
  let uploadMimeType = mimeType;
  let uploadFileName = fileName;

  if (isWebmAudio(mimeType, fileName) || (isAppRecordedVoiceNote(mimeType, fileName) && !isOggOpusAudio(mimeType, fileName))) {
    uploadBuffer = await convertAudioToOgg(Buffer.from(buffer), audioInputExtension(mimeType, fileName));
    uploadMimeType = 'audio/ogg';
    uploadFileName = String(fileName || 'voice-note.audio').replace(/\.[^.]+$/i, '.ogg');
  } else {
    uploadMimeType = normalizeMediaMimeType(uploadMimeType);
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', uploadMimeType);
  form.append('file', new Blob([uploadBuffer], { type: uploadMimeType }), uploadFileName);

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
  return {
    id: data.id,
    mimeType: uploadMimeType,
    fileName: uploadFileName,
    buffer: uploadBuffer,
  };
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
        proxy: false,
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
        proxy: false,
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
        proxy: false,
        timeout: 30000,
      },
    );

    return response.data.data || [];
  } catch (error) {
    throw wrapMetaError(error, 'Meta template sync failed');
  }
}

export async function getBusinessProfile(number) {
  const cacheKey = String(number.phoneNumberId || number.id || '');
  const cached = businessProfileCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < cached.ttlMs) {
    return cached.data;
  }

  try {
    const response = await axios.get(
      `${buildBaseUrl(number)}/${number.phoneNumberId}/whatsapp_business_profile`,
      {
        params: {
          fields: 'profile_picture_url',
        },
        headers: buildHeaders(number),
        proxy: false,
        timeout: 7000,
      },
    );

    const profile = response.data?.data?.[0] || null;
    businessProfileCache.set(cacheKey, {
      savedAt: Date.now(),
      ttlMs: BUSINESS_PROFILE_CACHE_TTL_MS,
      data: profile,
    });
    return profile;
  } catch (error) {
    businessProfileCache.set(cacheKey, {
      savedAt: Date.now(),
      ttlMs: BUSINESS_PROFILE_NEGATIVE_CACHE_TTL_MS,
      data: null,
    });
    throw wrapMetaError(error, 'Meta business profile fetch failed');
  }
}

export async function downloadMediaContent({ number, mediaId }) {
  let metadataResponse;
  try {
    metadataResponse = await axios.get(
      `${buildBaseUrl(number)}/${mediaId}`,
      {
        headers: buildHeaders(number),
        proxy: false,
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
      proxy: false,
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

export async function getMediaDownloadStream({ number, mediaId }) {
  let metadataResponse;
  try {
    metadataResponse = await axios.get(
      `${buildBaseUrl(number)}/${mediaId}`,
      {
        headers: buildHeaders(number),
        proxy: false,
        timeout: 30000,
      },
    );
  } catch (error) {
    throw wrapMetaError(error, 'Meta media metadata fetch failed');
  }

  const mediaUrl = metadataResponse.data.url;
  const mimeType = metadataResponse.data.mime_type || 'application/octet-stream';

  try {
    const response = await axios.get(mediaUrl, {
      headers: {
        Authorization: `Bearer ${number.accessToken}`,
      },
      proxy: false,
      responseType: 'stream',
      timeout: 60000,
    });

    return {
      stream: response.data,
      mimeType,
      contentLength: Number(response.headers['content-length'] || 0) || null,
    };
  } catch (error) {
    throw wrapMetaError(error, 'Meta media download failed');
  }
}
