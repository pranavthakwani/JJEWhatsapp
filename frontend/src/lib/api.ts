import axios from 'axios';
import type {
  BootstrapPayload,
  Campaign,
  Contact,
  ContactList,
  ContactSearchResult,
  Conversation,
  Message,
  PaginatedResult,
  Template,
} from '../types';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:4500/api',
});

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4500/api';

export async function getBootstrap() {
  const { data } = await api.get<BootstrapPayload>('/bootstrap');
  return data;
}

export async function getConversations(params: { phoneNumberId?: number | null; search?: string; cursor?: string | null; limit?: number }) {
  const { data } = await api.get<PaginatedResult<Conversation>>('/conversations', { params });
  return data;
}

export async function getConversation(conversationId: number) {
  const { data } = await api.get<Conversation>(`/conversations/${conversationId}`);
  return data;
}

export async function getMessages(conversationId: number, params?: { cursor?: string | null; limit?: number }) {
  const { data } = await api.get<PaginatedResult<Message>>(`/conversations/${conversationId}/messages`, { params });
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
  const { data } = await api.post<{ mediaId: string }>(`/media/upload/${phoneNumberId}`, await file.arrayBuffer(), {
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

  return data;
}

export async function listContactsPage(query = '', limit = 300, cursor?: string | null) {
  const { data } = await api.get<PaginatedResult<Contact>>('/contacts/page', {
    params: { q: query, limit, cursor },
  });

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
  mode: 'text' | 'template';
  bodyText?: string;
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
