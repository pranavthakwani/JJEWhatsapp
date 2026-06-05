import { env } from '../config/env.js';
import { getAdminClient } from '../config/db.js';

const supabase = getAdminClient();

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

let bucketReadyPromise = null;

export function getMediaStorageBucket() {
  return env.media.bucket;
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

async function ensureBucket() {
  if (!bucketReadyPromise) {
    bucketReadyPromise = (async () => {
      const bucket = getMediaStorageBucket();
      const existing = await supabase.storage.getBucket(bucket);

      if (!existing.error && existing.data) return;

      const created = await supabase.storage.createBucket(bucket, {
        public: false,
        fileSizeLimit: '64MB',
      });

      if (created.error && !/already exists/i.test(created.error.message || '')) {
        throw created.error;
      }
    })();
  }

  return bucketReadyPromise;
}

export async function storeMediaBuffer({
  phoneNumberId,
  source = 'messages',
  mediaId,
  buffer,
  mimeType = 'application/octet-stream',
  fileName,
}) {
  await ensureBucket();

  const normalizedBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const storageBucket = getMediaStorageBucket();
  const storagePath = buildStoragePath({
    phoneNumberId,
    source,
    mediaId,
    fileName,
    mimeType,
  });

  const uploaded = await supabase.storage
    .from(storageBucket)
    .upload(storagePath, normalizedBuffer, {
      contentType: mimeType,
      upsert: true,
    });

  if (uploaded.error) {
    throw uploaded.error;
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
  const bucket = storageBucket || getMediaStorageBucket();
  const downloaded = await supabase.storage
    .from(bucket)
    .download(storagePath);

  if (downloaded.error) {
    throw downloaded.error;
  }

  const arrayBuffer = await downloaded.data.arrayBuffer();

  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: downloaded.data.type || 'application/octet-stream',
    fileName: String(storagePath || '').split('/').pop() || 'media',
  };
}
