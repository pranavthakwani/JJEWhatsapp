export type BusinessNumber = {
  id: number;
  businessAccountId: number;
  businessAccountName: string;
  wabaId: string;
  displayName: string;
  phoneNumber: string;
  phoneNumberId: string;
  profilePictureUrl?: string | null;
  isDefault: boolean;
  status: string;
};

export type AuthDevice = {
  id: number;
  deviceCode: string;
  deviceName: string | null;
  browserInfo: string | null;
  ipAddress: string | null;
  status: 'pending' | 'approved' | 'blocked' | string;
  approvedBy: string | null;
  approvedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  isCurrent: boolean;
};

export type AuthStatus = {
  authenticated: boolean;
  loginRequired: boolean;
  deviceApprovalRequired: boolean;
  canUseApp: boolean;
  user: {
    id: number;
    displayName: string;
    email: string;
    roles: string[];
  } | null;
  device: AuthDevice | null;
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
  storageBucket?: string | null;
  storagePath?: string | null;
  mediaSize?: number | null;
  uploadProgress?: number | null;
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
  starredAt: string | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StarredMessage = Message & {
  contactName: string;
  contactPhone: string | null;
  contactWaId: string;
  starredAt: string;
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
  mode: 'text' | 'template' | 'image' | 'video' | 'audio' | 'document';
  bodyText: string | null;
  mediaId?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
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

export type LeadOpsItemType = 'lead' | 'offering' | 'ignored';

export type LeadOpsItem = {
  id: number;
  type: LeadOpsItemType;
  analysisId: number;
  messageId: number;
  conversationId: number;
  contactId: number;
  contactName: string;
  phoneNumber: string;
  sourceText: string | null;
  classification: string;
  confidence: number | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  ramGb: number | null;
  storageGb: number | null;
  colors: string[];
  quantityMin: number | null;
  quantityMax: number | null;
  priceMin: number | null;
  priceMax: number | null;
  condition: string | null;
  gstIncluded: boolean | null;
  dispatchLocation: string | null;
  status: string;
  createdAt: string;
  matchScore?: number;
};

export type LeadOpsDashboard = {
  days: number;
  totals: {
    leads: number;
    offerings: number;
    ignored: number;
    openLeads: number;
    pendingPrices: number;
    analyzedContacts: number;
    tokenInput: number;
    tokenOutput: number;
    queuedJobs: number;
    failedJobs: number;
  };
  trend: Array<{ date: string; leads: number; offerings: number; ignored: number }>;
};

export type LeadOpsFacets = {
  brands: Array<{ value: string; total: number }>;
  models: Array<{ value: string; total: number }>;
};

export type LeadOpsPage = {
  items: LeadOpsItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type AiWorkflowTest = {
  testId: string;
  stage: 'received' | 'queued' | 'processing' | 'completed' | 'failed';
  messageId: number;
  conversationId: number;
  contactName: string;
  sourceText: string;
  jobStatus: string | null;
  attemptCount: number;
  classification: string | null;
  confidence: number | null;
  model: string | null;
  leadCount: number;
  offeringCount: number;
  items: Array<Record<string, unknown>>;
  error: string | null;
  createdAt: string | null;
  completedAt: string | null;
};
