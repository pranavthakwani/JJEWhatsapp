import type { Message, PaginatedResult } from '../types';

const DB_NAME = 'jjewa-browser-cache';
const DB_VERSION = 1;
const MESSAGE_SNAPSHOT_STORE = 'messageSnapshots';
const MEDIA_STORE = 'messageMedia';

const MESSAGE_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES_PER_CONVERSATION = 500;
const MAX_MEDIA_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_MEDIA_CACHE_ENTRIES = 300;
const MAX_SINGLE_MEDIA_CACHE_BYTES = 128 * 1024 * 1024;

const MEDIA_MESSAGE_TYPES = new Set(['image', 'video', 'audio', 'document']);

type MessageSnapshotRecord = {
  key: string;
  apiBaseUrl: string;
  conversationId: number;
  savedAt: number;
  nextCursor: string | null;
  items: Message[];
};

export type CachedMessageMedia = {
  blob: Blob;
  mimeType: string | null;
  fileName: string | null;
  savedAt: number;
};

type MessageMediaRecord = CachedMessageMedia & {
  key: string;
  apiBaseUrl: string;
  conversationId: number;
  messageId: number;
  fingerprint: string;
  mediaSize: number;
  lastAccessedAt: number;
  sourceUrl: string | null;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function canUseIndexedDb() {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function openCacheDb() {
  if (!canUseIndexedDb()) {
    return Promise.reject(new Error('IndexedDB is not available'));
  }

  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(MESSAGE_SNAPSHOT_STORE)) {
          const store = db.createObjectStore(MESSAGE_SNAPSHOT_STORE, { keyPath: 'key' });
          store.createIndex('byConversationId', 'conversationId');
        }

        if (!db.objectStoreNames.contains(MEDIA_STORE)) {
          const store = db.createObjectStore(MEDIA_STORE, { keyPath: 'key' });
          store.createIndex('byConversationId', 'conversationId');
          store.createIndex('byLastAccessedAt', 'lastAccessedAt');
        }
      };

      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error('Failed to open browser cache'));
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
  }

  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

function messageSnapshotKey(apiBaseUrl: string, conversationId: number) {
  return `${apiBaseUrl}:conversation:${conversationId}`;
}

function messageMediaKey(apiBaseUrl: string, messageId: number) {
  return `${apiBaseUrl}:message:${messageId}`;
}

function sortMessages(items: Message[]) {
  return [...items].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

function compactMessages(items: Message[]) {
  const byId = new Map<number, Message>();

  for (const message of items) {
    if (!Number.isFinite(message.id) || message.id < 0 || message.deletedAt) continue;
    byId.set(message.id, message);
  }

  return sortMessages([...byId.values()]).slice(-MAX_MESSAGES_PER_CONVERSATION);
}

function messageMediaFingerprint(message: Message) {
  const stableMediaSource = message.mediaId
    || message.storagePath
    || (message.mediaUrl && !message.mediaUrl.startsWith('blob:') ? message.mediaUrl : '')
    || String(message.id);

  return `${message.messageType}:${stableMediaSource}`;
}

function isCacheableMediaMessage(message: Message) {
  return message.id > 0 && MEDIA_MESSAGE_TYPES.has(message.messageType);
}

async function getRecord<T>(storeName: string, key: string) {
  const db = await openCacheDb();
  const transaction = db.transaction(storeName, 'readonly');
  return requestToPromise<T | undefined>(transaction.objectStore(storeName).get(key) as IDBRequest<T | undefined>);
}

async function putRecord(storeName: string, value: unknown) {
  const db = await openCacheDb();
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
}

async function deleteRecord(storeName: string, key: string) {
  const db = await openCacheDb();
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
}

async function getAllRecords<T>(storeName: string) {
  const db = await openCacheDb();
  const transaction = db.transaction(storeName, 'readonly');
  return requestToPromise<T[]>(transaction.objectStore(storeName).getAll() as IDBRequest<T[]>);
}

export async function readCachedMessageSnapshot(apiBaseUrl: string, conversationId: number) {
  try {
    const key = messageSnapshotKey(apiBaseUrl, conversationId);
    const record = await getRecord<MessageSnapshotRecord>(MESSAGE_SNAPSHOT_STORE, key);
    if (!record) return null;

    if (Date.now() - record.savedAt > MESSAGE_SNAPSHOT_TTL_MS) {
      void deleteRecord(MESSAGE_SNAPSHOT_STORE, key).catch(() => undefined);
      return null;
    }

    return {
      items: record.items,
      nextCursor: record.nextCursor,
    } satisfies PaginatedResult<Message>;
  } catch {
    return null;
  }
}

export async function writeCachedMessageSnapshot(apiBaseUrl: string, conversationId: number, data: PaginatedResult<Message>) {
  try {
    const items = compactMessages(data.items);
    const record: MessageSnapshotRecord = {
      key: messageSnapshotKey(apiBaseUrl, conversationId),
      apiBaseUrl,
      conversationId,
      savedAt: Date.now(),
      nextCursor: data.nextCursor,
      items,
    };

    await putRecord(MESSAGE_SNAPSHOT_STORE, record);
  } catch {
    // Browser cache writes are opportunistic and must never block chat usage.
  }
}

export async function deleteCachedMessageSnapshot(apiBaseUrl: string, conversationId: number) {
  try {
    await deleteRecord(MESSAGE_SNAPSHOT_STORE, messageSnapshotKey(apiBaseUrl, conversationId));
  } catch {
    // Ignore cache cleanup failures.
  }
}

async function pruneMessageMediaCache(apiBaseUrl: string) {
  const records = await getAllRecords<MessageMediaRecord>(MEDIA_STORE);
  const scopedRecords = records.filter((record) => record.apiBaseUrl === apiBaseUrl);
  let totalBytes = scopedRecords.reduce((sum, record) => sum + (record.mediaSize || record.blob?.size || 0), 0);
  const evictionQueue = [...scopedRecords].sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);

  while (evictionQueue.length > MAX_MEDIA_CACHE_ENTRIES || totalBytes > MAX_MEDIA_CACHE_BYTES) {
    const record = evictionQueue.shift();
    if (!record) break;

    await deleteRecord(MEDIA_STORE, record.key);
    totalBytes -= record.mediaSize || record.blob?.size || 0;
  }
}

export async function readCachedMessageMedia(apiBaseUrl: string, message: Message) {
  if (!isCacheableMediaMessage(message)) return null;

  try {
    const key = messageMediaKey(apiBaseUrl, message.id);
    const record = await getRecord<MessageMediaRecord>(MEDIA_STORE, key);
    if (!record) return null;

    if (record.fingerprint !== messageMediaFingerprint(message)) {
      void deleteRecord(MEDIA_STORE, key).catch(() => undefined);
      return null;
    }

    const nextRecord: MessageMediaRecord = {
      ...record,
      lastAccessedAt: Date.now(),
    };
    void putRecord(MEDIA_STORE, nextRecord).catch(() => undefined);

    return {
      blob: record.blob,
      mimeType: record.mimeType,
      fileName: record.fileName,
      savedAt: record.savedAt,
    } satisfies CachedMessageMedia;
  } catch {
    return null;
  }
}

export async function writeCachedMessageMedia(apiBaseUrl: string, message: Message, blob: Blob, sourceUrl?: string | null) {
  if (!isCacheableMediaMessage(message) || blob.size <= 0 || blob.size > MAX_SINGLE_MEDIA_CACHE_BYTES) return;

  try {
    const now = Date.now();
    const record: MessageMediaRecord = {
      key: messageMediaKey(apiBaseUrl, message.id),
      apiBaseUrl,
      conversationId: message.conversationId,
      messageId: message.id,
      fingerprint: messageMediaFingerprint(message),
      blob,
      mimeType: blob.type || message.mimeType || null,
      fileName: message.fileName || null,
      mediaSize: blob.size,
      savedAt: now,
      lastAccessedAt: now,
      sourceUrl: sourceUrl || null,
    };

    await putRecord(MEDIA_STORE, record);
    await pruneMessageMediaCache(apiBaseUrl);
  } catch {
    // Ignore media cache failures; the live media URL remains the source of truth.
  }
}

export async function deleteCachedMessageMedia(apiBaseUrl: string, messageId: number) {
  try {
    await deleteRecord(MEDIA_STORE, messageMediaKey(apiBaseUrl, messageId));
  } catch {
    // Ignore cache cleanup failures.
  }
}

export async function deleteCachedConversationMedia(apiBaseUrl: string, conversationId: number) {
  try {
    const records = await getAllRecords<MessageMediaRecord>(MEDIA_STORE);
    await Promise.all(
      records
        .filter((record) => record.apiBaseUrl === apiBaseUrl && record.conversationId === conversationId)
        .map((record) => deleteRecord(MEDIA_STORE, record.key)),
    );
  } catch {
    // Ignore cache cleanup failures.
  }
}
