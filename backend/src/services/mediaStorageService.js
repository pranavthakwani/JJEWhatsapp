import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

const MIME_EXTENSIONS = {
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/amr': 'amr',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'text/plain': 'txt',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
};

export function getMediaStorageBucket() {
  return 'local';
}

function safePathSegment(value, fallback = 'media') {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/[\\/:*?"<>|#%{}^~[\]`]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return cleaned.slice(0, 160) || fallback;
}

function extensionFromMime(mimeType) {
  return MIME_EXTENSIONS[String(mimeType || '').toLowerCase()] || 'bin';
}

function ensureExtension(fileName, mimeType) {
  const safeName = safePathSegment(fileName, 'media');
  if (/\.[a-z0-9]{2,8}$/i.test(safeName)) return safeName;
  return `${safeName}.${extensionFromMime(mimeType)}`;
}

function buildStoragePath({ phoneNumberId, source, mediaId, fileName, mimeType }) {
  const date = new Date().toISOString().slice(0, 10);
  const idPart = safePathSegment(mediaId || `${Date.now()}`, 'media');
  const namePart = ensureExtension(fileName || idPart, mimeType);

  return [
    `phone-${safePathSegment(phoneNumberId, 'unknown')}`,
    safePathSegment(source, 'messages'),
    date,
    `${idPart}-${namePart}`,
  ].join('/');
}

function resolveStorageFile(storagePath) {
  const normalizedRelativePath = String(storagePath || '').replaceAll('\\', '/');
  const resolved = path.resolve(env.media.root, normalizedRelativePath);
  const rootPrefix = `${path.resolve(env.media.root)}${path.sep}`;
  if (!resolved.startsWith(rootPrefix)) {
    throw new Error('Invalid media storage path.');
  }
  return resolved;
}

export async function storeMediaBuffer({
  phoneNumberId,
  source = 'messages',
  mediaId,
  buffer,
  mimeType = 'application/octet-stream',
  fileName,
}) {
  const normalizedBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (normalizedBuffer.length > env.media.maxBytes) {
    throw new Error(`Media exceeds the ${env.media.maxBytes} byte storage limit.`);
  }

  const storageBucket = getMediaStorageBucket();
  const storagePath = buildStoragePath({
    phoneNumberId,
    source,
    mediaId,
    fileName,
    mimeType,
  });
  const destination = resolveStorageFile(storagePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });

  try {
    await fs.writeFile(destination, normalizedBuffer, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  return {
    storageBucket,
    storagePath,
    mediaSize: normalizedBuffer.length,
    mimeType,
    fileName: ensureExtension(fileName || mediaId || 'media', mimeType),
  };
}

export async function downloadStoredMedia({ storageBucket, storagePath }) {
  if (storageBucket && storageBucket !== getMediaStorageBucket()) {
    throw new Error(`Unsupported media storage provider: ${storageBucket}`);
  }
  const storageFile = resolveStorageFile(storagePath);
  const [buffer, metadata] = await Promise.all([
    fs.readFile(storageFile),
    fs.stat(storageFile),
  ]);
  if (metadata.size > env.media.maxBytes) {
    throw new Error('Stored media exceeds the configured download limit.');
  }

  return {
    buffer,
    mimeType: 'application/octet-stream',
    fileName: path.basename(storageFile),
  };
}
