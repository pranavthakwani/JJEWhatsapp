import axios from 'axios';
import type {
  AuthDevice,
  AuthStatus,
  BootstrapPayload,
  Campaign,
  Contact,
  ContactList,
  ContactSearchResult,
  Conversation,
  Message,
  PaginatedResult,
  StarredMessage,
  Template,
} from '../types';

export type ChatFilterMemberKey = `conversation:${number}` | `broadcast:${number}`;

export type StoredChatFilter = {
  id: string;
  name: string;
  memberKeys: ChatFilterMemberKey[];
  createdAt: string;
};

export type ChatFilterSettings = {
  phoneNumberId: number;
  favoriteKeys: ChatFilterMemberKey[];
  customFilters: StoredChatFilter[];
  updatedAt?: string | null;
};

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:4500/api',
  withCredentials: true,
});

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4500/api';
const BOOTSTRAP_CACHE_TTL_MS = 5 * 60 * 1000;
const CONVERSATION_CACHE_TTL_MS = 2 * 60 * 1000;
const MESSAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const CONTACT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BROADCAST_HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEnvelope<T> = {
  savedAt: number;
  data: T;
};

function makeCacheKey(name: string) {
  return `jjewa-cache:${name}:${apiBaseUrl}`;
}

function readCache<T>(key: string, ttlMs: number) {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed?.savedAt || Date.now() - parsed.savedAt > ttlMs) {
      window.localStorage.removeItem(key);
      return null;
    }

    return parsed.data;
  } catch {
    window.localStorage.removeItem(key);
    return null;
  }
}

function writeCache<T>(key: string, data: T) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // Cache failures should never block the live API path.
  }
}

export function getCachedBootstrap() {
  return readCache<BootstrapPayload>(makeCacheKey('bootstrap'), BOOTSTRAP_CACHE_TTL_MS);
}

function normaliseSearch(value = '') {
  return value.trim().toLowerCase();
}

function makeConversationCacheName(params: { phoneNumberId?: number | null; search?: string; cursor?: string | null; limit?: number }) {
  return `conversations:${params.phoneNumberId || 'all'}:${normaliseSearch(params.search || '')}:${params.cursor || 'first'}:${params.limit || 20}`;
}

function makeContactPageCacheName(query = '', limit = 300, cursor?: string | null) {
  return `contacts-page:${normaliseSearch(query)}:${cursor || 'first'}:${limit}`;
}

export function getCachedConversations(params: { phoneNumberId?: number | null; search?: string; cursor?: string | null; limit?: number }) {
  return readCache<PaginatedResult<Conversation>>(makeCacheKey(makeConversationCacheName(params)), CONVERSATION_CACHE_TTL_MS);
}

export function cacheConversations(params: { phoneNumberId?: number | null; search?: string; cursor?: string | null; limit?: number }, data: PaginatedResult<Conversation>) {
  writeCache(makeCacheKey(makeConversationCacheName(params)), data);
}

export function getCachedMessages(conversationId: number) {
  return readCache<PaginatedResult<Message>>(makeCacheKey(`messages:${conversationId}:first:30`), MESSAGE_CACHE_TTL_MS);
}

export function cacheMessages(conversationId: number, data: PaginatedResult<Message>) {
  writeCache(makeCacheKey(`messages:${conversationId}:first:30`), data);
}

export function getCachedContactsPage(query = '', limit = 300, cursor?: string | null) {
  return readCache<PaginatedResult<Contact>>(makeCacheKey(makeContactPageCacheName(query, limit, cursor)), CONTACT_CACHE_TTL_MS);
}

export function cacheContactsPage(query = '', limit = 300, cursor: string | null | undefined, data: PaginatedResult<Contact>) {
  writeCache(makeCacheKey(makeContactPageCacheName(query, limit, cursor)), data);
}

export function getCachedContactDirectory(limit = 50000) {
  return readCache<Contact[]>(makeCacheKey(`contacts-directory:${limit}`), CONTACT_CACHE_TTL_MS);
}

export function cacheContactDirectory(limit: number, data: Contact[]) {
  writeCache(makeCacheKey(`contacts-directory:${limit}`), data);
}

export function getCachedContactListCampaigns(contactListId: number) {
  return readCache<Campaign[]>(makeCacheKey(`broadcast-history:${contactListId}`), BROADCAST_HISTORY_CACHE_TTL_MS);
}

export function cacheContactListCampaigns(contactListId: number, data: Campaign[]) {
  writeCache(makeCacheKey(`broadcast-history:${contactListId}`), data);
}

export async function getAuthStatus() {
  const { data } = await api.get<AuthStatus>('/auth/status');
  return data;
}

export async function logout() {
  await api.post('/auth/logout');
}

export async function listAuthDevices() {
  const { data } = await api.get<{ devices: AuthDevice[] }>('/auth/devices');
  return data.devices;
}

export async function updateAuthDevice(deviceId: number, payload: { status?: 'pending' | 'approved' | 'blocked'; deviceName?: string }) {
  const { data } = await api.patch<{ device: AuthDevice }>(`/auth/devices/${deviceId}`, payload);
  return data.device;
}

export async function getBootstrap() {
  const { data } = await api.get<BootstrapPayload>('/bootstrap');
  writeCache(makeCacheKey('bootstrap'), data);
  return data;
}

export async function getConversations(params: { phoneNumberId?: number | null; search?: string; cursor?: string | null; limit?: number }) {
  const { data } = await api.get<PaginatedResult<Conversation>>('/conversations', { params });
  cacheConversations(params, data);
  return data;
}

export async function getConversation(conversationId: number) {
  const { data } = await api.get<Conversation>(`/conversations/${conversationId}`);
  return data;
}

export async function getMessages(conversationId: number, params?: { cursor?: string | null; limit?: number }) {
  const { data } = await api.get<PaginatedResult<Message>>(`/conversations/${conversationId}/messages`, { params });
  if (!params?.cursor) {
    cacheMessages(conversationId, data);
  }
  return data;
}

export async function markConversationRead(conversationId: number) {
  await api.post(`/conversations/${conversationId}/read`);
}

export async function clearConversation(conversationId: number) {
  const { data } = await api.post<Conversation>(`/conversations/${conversationId}/clear`);
  return data;
}

export async function deleteConversation(conversationId: number) {
  await api.delete(`/conversations/${conversationId}`);
}

export async function sendConversationMessage(
  conversationId: number,
  payload: {
    type: string;
    text?: string;
    mediaId?: string;
    caption?: string;
    mimeType?: string;
    fileName?: string;
    templateName?: string;
    templateLanguage?: string;
    templateParams?: string[];
    replyToWaMessageId?: string | null;
    emoji?: string;
  },
) {
  const { data } = await api.post<Message>(`/conversations/${conversationId}/messages`, payload);
  return data;
}

export async function uploadMedia(phoneNumberId: number, file: File) {
  const { data } = await api.post<{ mediaId: string; mimeType?: string; fileName?: string }>(`/media/upload/${phoneNumberId}`, await file.arrayBuffer(), {
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'x-file-name': file.name,
      'x-mime-type': file.type || 'application/octet-stream',
    },
  });

  return data;
}

export async function searchContacts(query: string) {
  const { data } = await api.get<ContactSearchResult[]>('/contacts/search', {
    params: { q: query },
  });

  return data;
}

export async function listContacts(query = '', limit = 250) {
  const { data } = await api.get<Contact[]>('/contacts', {
    params: { q: query, limit },
  });

  if (!query.trim()) {
    cacheContactDirectory(limit, data);
  }

  return data;
}

export async function listContactsPage(query = '', limit = 300, cursor?: string | null) {
  const { data } = await api.get<PaginatedResult<Contact>>('/contacts/page', {
    params: { q: query, limit, cursor },
  });

  cacheContactsPage(query, limit, cursor, data);
  return data;
}

export async function createContact(payload: { countryCode: string; phoneNumber: string; name: string }) {
  const { data } = await api.post<Contact>('/contacts', payload);
  return data;
}

export async function startConversation(payload: { phoneNumberId: number; contactId: number }) {
  const { data } = await api.post<Conversation>('/conversations/start', payload);
  return data;
}

export async function sendConversationOptInTemplate(conversationId: number, templateKind: 'auto' | 'intro' | 'followup') {
  const { data } = await api.post<{ message: Message; conversation: Conversation }>(
    `/conversations/${conversationId}/opt-in`,
    { templateKind },
  );
  return data;
}

export async function starMessage(messageId: number) {
  const { data } = await api.post<Message>(`/messages/${messageId}/star`);
  return data;
}

export async function unstarMessage(messageId: number) {
  const { data } = await api.delete<Message>(`/messages/${messageId}/star`);
  return data;
}

export async function getStarredMessages(phoneNumberId?: number | null) {
  const { data } = await api.get<StarredMessage[]>('/messages/starred', {
    params: { phoneNumberId },
  });

  return data;
}

export async function deleteMessage(messageId: number) {
  const { data } = await api.delete<{ message: Message; conversation: Conversation }>(`/messages/${messageId}`);
  return data;
}

export async function importBusinessDirectoryContacts() {
  const { data } = await api.post<{ workbookPath: string; importedCount: number; contacts: Contact[] }>('/contacts/import/business-directory');
  return data;
}

export async function parseSpreadsheetContacts(file: File, sheetName?: string) {
  const { data } = await api.post<{
    sheetNames: string[];
    activeSheet: string | null;
    contacts: Array<{
      waId: string;
      phoneNumber: string;
      profileName: string;
      source: string;
    }>;
  }>('/contacts/parse-spreadsheet', await file.arrayBuffer(), {
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'x-file-name': file.name,
      'x-sheet-name': sheetName || '',
    },
  });

  return data;
}

export async function getTemplates(phoneNumberId?: number | null) {
  const { data } = await api.get<Template[]>('/templates', {
    params: { phoneNumberId },
  });

  return data;
}

export async function getChatFilterSettings(phoneNumberId: number) {
  const { data } = await api.get<ChatFilterSettings>('/chat-filter-settings', {
    params: { phoneNumberId },
  });

  return data;
}

export async function saveChatFilterSettings(payload: Pick<ChatFilterSettings, 'phoneNumberId' | 'favoriteKeys' | 'customFilters'>) {
  const { data } = await api.put<ChatFilterSettings>('/chat-filter-settings', payload);
  return data;
}

export async function getContactLists(phoneNumberId?: number | null) {
  const { data } = await api.get<ContactList[]>('/contact-lists', {
    params: { phoneNumberId },
  });

  return data;
}

export async function getContactList(listId: number) {
  const { data } = await api.get<ContactList>(`/contact-lists/${listId}`);
  return data;
}

export async function createContactList(payload: {
  phoneNumberId: number;
  name: string;
  source?: string;
  contacts: Array<{
    contactId?: number | null;
    waId?: string;
    phoneNumber?: string;
    profileName?: string | null;
    name?: string | null;
    businessDirectoryName?: string | null;
  }>;
}) {
  const { data } = await api.post<ContactList>('/contact-lists', payload);
  return data;
}

export async function replaceContactListMembers(listId: number, contacts: Array<{ contactId: number }>) {
  const { data } = await api.patch<ContactList>(`/contact-lists/${listId}/members`, {
    contacts,
  });

  return data;
}

export async function clearContactList(listId: number) {
  const { data } = await api.post<ContactList>(`/contact-lists/${listId}/clear`);
  return data;
}

export async function deleteContactList(listId: number) {
  await api.delete(`/contact-lists/${listId}`);
}

export async function syncTemplates(phoneNumberId: number) {
  const { data } = await api.post<Template[]>('/templates/sync', { phoneNumberId });
  return data;
}

export async function getCampaigns() {
  const { data } = await api.get<Campaign[]>('/campaigns');
  return data;
}

export async function getContactListCampaigns(contactListId: number) {
  const { data } = await api.get<Campaign[]>('/campaigns', {
    params: { contactListId },
  });

  cacheContactListCampaigns(contactListId, data);
  return data;
}

export async function getCampaign(campaignId: number) {
  const { data } = await api.get<Campaign>(`/campaigns/${campaignId}`);
  return data;
}

export async function createCampaign(payload: {
  phoneNumberId: number;
  contactListId?: number | null;
  title: string;
  mode: 'text' | 'template' | 'image' | 'video' | 'audio' | 'document';
  bodyText?: string;
  mediaId?: string;
  mimeType?: string;
  fileName?: string;
  templateName?: string;
  initialTemplateName?: string;
  followupTemplateName?: string;
  templateLanguage?: string;
  templateParams?: string[];
  recipients: Array<{ waId: string; name?: string | null; contactId?: number | null; contactListMemberId?: number | null }>;
}) {
  const { data } = await api.post<Campaign>('/campaigns', payload);
  return data;
}

export function getMediaUrl(messageId: number) {
  return `${apiBaseUrl}/messages/${messageId}/media`;
}

export function getCampaignMediaUrl(campaignId: number) {
  return `${apiBaseUrl}/campaigns/${campaignId}/media`;
}
