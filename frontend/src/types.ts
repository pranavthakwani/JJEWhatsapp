export type BusinessNumber = {
  id: number;
  businessAccountId: number;
  businessAccountName: string;
  wabaId: string;
  displayName: string;
  phoneNumber: string;
  phoneNumberId: string;
  isDefault: boolean;
  status: string;
};

export type Contact = {
  id: number;
  waId: string;
  phoneNumber: string | null;
  profileName: string | null;
  businessDirectoryName: string | null;
  notes: string | null;
  optInStatus: string;
  optInKeyword: string | null;
  optInSource: string | null;
  optInUpdatedAt: string | null;
  lastOptInTemplateName: string | null;
  lastOptInPromptAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ContactListMember = {
  id: number;
  position: number;
  contact: Contact;
};

export type ContactList = {
  id: number;
  phoneNumberId: number;
  name: string;
  source: string;
  isArchived?: boolean;
  clearedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  memberCount?: number;
  members?: ContactListMember[];
};

export type Conversation = {
  id: number;
  phoneNumberId: number;
  phoneNumberLabel: string;
  contactId: number;
  contactName: string;
  contactPhone: string | null;
  contactWaId: string;
  contactOptInStatus: string;
  contactOptInUpdatedAt: string | null;
  contactLastOptInTemplateName: string | null;
  contactLastOptInPromptAt: string | null;
  contactLastInboundAt: string | null;
  contactLastOutboundAt: string | null;
  lastMessageId: number | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  isArchived?: boolean;
  clearedAt?: string | null;
};

export type Message = {
  id: number;
  conversationId: number;
  phoneNumberId: number;
  contactId: number;
  direction: 'inbound' | 'outbound' | 'system';
  messageType: string;
  waMessageId: string | null;
  parentWaMessageId: string | null;
  textBody: string | null;
  caption: string | null;
  mediaId: string | null;
  mediaUrl: string | null;
  mimeType: string | null;
  fileName: string | null;
  templateName: string | null;
  templateLanguage: string | null;
  templateParams: string[] | null;
  campaignId: number | null;
  status: string;
  errorMessage: string | null;
  waTimestamp: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Template = {
  id: number;
  phoneNumberId: number | null;
  templateName: string;
  category: string | null;
  language: string;
  status: string | null;
  headerFormat: string | null;
  bodyText: string | null;
  footerText: string | null;
  buttons: Array<Record<string, unknown>>;
  metaTemplateId: string | null;
  lastSyncedAt: string | null;
};

export type CampaignRecipient = {
  id: number;
  recipientWaId: string;
  recipientName: string | null;
  contactListMemberId?: number | null;
  contactId: number | null;
  conversationId: number | null;
  waMessageId: string | null;
  pendingTextBody?: string | null;
  promptTemplateName?: string | null;
  status: string;
  errorMessage: string | null;
  optInRequestedAt?: string | null;
  optedInAt?: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
};

export type Campaign = {
  id: number;
  phoneNumberId: number;
  contactListId?: number | null;
  title: string;
  mode: 'text' | 'template';
  bodyText: string | null;
  templateName: string | null;
  initialTemplateName?: string | null;
  followupTemplateName?: string | null;
  templateLanguage: string | null;
  templateParams: string[];
  status: string;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  recipients?: CampaignRecipient[];
};

export type PaginatedResult<T> = {
  items: T[];
  nextCursor: string | null;
};

export type BootstrapPayload = {
  businessNumbers: BusinessNumber[];
  campaigns: Campaign[];
  defaultPhoneNumberId: number | null;
};

export type ContactSearchResult = {
  id: number;
  waId: string;
  phoneNumber: string | null;
  profileName: string | null;
};
