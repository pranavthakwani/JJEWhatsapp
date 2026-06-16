import {
  AlertCircle,
  ArrowLeft,
  Bell,
  BellOff,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Clock3,
  FileText,
  Info,
  Megaphone,
  Mic,
  MoreVertical,
  Paperclip,
  Pencil,
  Play,
  Search,
  SendHorizonal,
  Smile,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { EmojiClickData } from 'emoji-picker-react';
import {
  getCachedContactDirectory,
  getCachedContactListCampaigns,
  getCampaign,
  getCampaignMediaUrl,
  getContactList,
  getContactListCampaigns,
  listContacts,
  renameContactList,
  replaceContactListMembers,
} from '../lib/api';
import { socket } from '../lib/socket';
import type { Campaign, CampaignRecipient, Contact, ContactList } from '../types';

const EmojiPicker = lazy(() => import('emoji-picker-react'));
const COMPOSER_MAX_TEXTAREA_HEIGHT = 176;

type Props = {
  theme: 'dark' | 'light';
  contactList: ContactList | null;
  onBack?: () => void;
  onSendBroadcast: (contactList: ContactList, payload: { bodyText: string; file?: File | null }) => Promise<Campaign>;
  onContactListUpdated: (contactList: ContactList) => void;
};

type OptimisticBroadcast = {
  id: string;
  bodyText: string;
  mode: Campaign['mode'];
  fileName?: string | null;
  mimeType?: string | null;
  previewUrl?: string | null;
  createdAt: string;
  totalRecipients: number;
  status: 'queued' | 'failed';
  errorMessage?: string;
};

type BroadcastTimelineItem =
  | { type: 'date'; key: string; label: string }
  | { type: 'campaign'; key: string; campaign: Campaign }
  | { type: 'optimistic'; key: string; item: OptimisticBroadcast };

type DeliveryGroupKey = 'notDelivered' | 'delivered' | 'seen' | 'underOptation';
type BroadcastAutocompleteSnippet = {
  label: string;
  value: string;
  keywords?: string[];
};

const DELIVERY_GROUP_PAGES: DeliveryGroupKey[][] = [
  ['seen', 'delivered'],
  ['notDelivered', 'underOptation'],
];

const BROADCAST_AUTOCOMPLETE_SNIPPETS: BroadcastAutocompleteSnippet[] = [
  { label: 'Fresh with GST', value: 'Fresh with GST', keywords: ['fresh', 'gst'] },
  { label: 'Active', value: 'Active', keywords: ['active', 'stock'] },
  { label: 'Today Dispatch', value: 'Today Dispatch', keywords: ['today dispatch', 'today'] },
  { label: 'Tomorrow Dispatch', value: 'Tomorrow Dispatch', keywords: ['tomorrow dispatch', 'tomorrow'] },
  { label: 'Dispatch in 2-3 days', value: 'Dispatch in 2-3 days', keywords: ['dispatch', '2-3 days', '2 3 days'] },
  { label: 'Model:', value: 'Model: ', keywords: ['model', 'modal'] },
  { label: 'RAM:', value: 'RAM: ', keywords: ['ram'] },
  { label: 'ROM:', value: 'ROM: ', keywords: ['rom'] },
  { label: 'Price:', value: 'Price: ', keywords: ['price', 'rate'] },
  { label: 'TC:', value: 'TC: ', keywords: ['tc'] },
  { label: 'Color:', value: 'Color: ', keywords: ['color', 'colour'] },
  { label: 'Qty:', value: 'Qty: ', keywords: ['qty', 'quantity'] },
  { label: 'Brand:', value: 'Brand: ', keywords: ['brand'] },
];

const CONTACT_FETCH_LIMIT = 50000;
const OPT_IN_WAITING_STATUSES = new Set(['optin_initial_sent', 'optin_followup_sent']);
const CAMPAIGN_SUCCESS_STATUSES = new Set(['sent', 'delivered', 'read']);
const VOICE_RECORDER_MIME_TYPES = [
  'audio/ogg;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
];

function shouldSubmitOnEnter() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

function shouldAutoFocusComposer() {
  return shouldSubmitOnEnter();
}

function resizeComposerTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;

  textarea.style.height = 'auto';
  const nextHeight = Math.min(textarea.scrollHeight, COMPOSER_MAX_TEXTAREA_HEIGHT);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > COMPOSER_MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
}

function formatBubbleTime(value: string | null) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  }).toLowerCase();
}

function formatDateLabel(value: string) {
  const current = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (current.toDateString() === today.toDateString()) return 'Today';
  if (current.toDateString() === yesterday.toDateString()) return 'Yesterday';

  return current.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: current.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

function formatVoiceDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function getSupportedVoiceMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }

  return VOICE_RECORDER_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || '';
}

function getVoiceRecorderSupportError() {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'Voice recording needs HTTPS. Use the live HTTPS domain or localhost.';
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return 'Voice recording is not available in this browser.';
  }

  if (typeof MediaRecorder === 'undefined') {
    return 'Voice recording is not supported in this browser.';
  }

  return '';
}

function getAudioExtension(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('mp4')) return 'm4a';
  if (normalized.includes('mpeg')) return 'mp3';
  if (normalized.includes('webm')) return 'webm';
  return 'ogg';
}

function getFileCampaignMode(file: File): Campaign['mode'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'document';
}

function isMediaCampaignMode(mode: Campaign['mode']) {
  return ['image', 'video', 'audio', 'document'].includes(mode);
}

function getAttachmentLabel(mode: Campaign['mode'], mimeType?: string | null) {
  if (mode === 'image') return 'Image';
  if (mode === 'video') return 'Video';
  if (mode === 'audio') return 'Voice note';
  if (mode === 'document') return mimeType || 'Document';
  return 'Message';
}

function getBroadcastSearchText(item: Campaign | OptimisticBroadcast) {
  return [
    item.bodyText,
    item.fileName,
    item.mimeType,
    'templateName' in item ? item.templateName : null,
  ].filter(Boolean).join(' ').toLowerCase();
}

function getRecipientCount(contactList: ContactList) {
  return contactList.memberCount ?? contactList.members?.length ?? 0;
}

function hasCompleteMemberDetails(contactList: ContactList) {
  return Array.isArray(contactList.members) && contactList.members.length >= getRecipientCount(contactList);
}

function getContactName(contact: Contact) {
  return contact.businessDirectoryName || contact.profileName || contact.phoneNumber || contact.waId;
}

function getRecipientName(recipient: CampaignRecipient) {
  return recipient.recipientName || recipient.recipientWaId;
}

function normalizeAutocompleteText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getComposerLineContext(text: string, selectionStart: number, selectionEnd: number) {
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const nextLineBreak = text.indexOf('\n', end);
  const lineEnd = nextLineBreak === -1 ? text.length : nextLineBreak;
  const rawLine = text.slice(lineStart, lineEnd);
  const leadingWhitespace = rawLine.match(/^\s*/)?.[0] || '';
  const query = rawLine.trim();

  return { lineStart, lineEnd, rawLine, leadingWhitespace, query };
}

function getBroadcastAutocompleteSuggestions(query: string) {
  const normalizedQuery = normalizeAutocompleteText(query);
  if (normalizedQuery.length < 2) return [];

  return BROADCAST_AUTOCOMPLETE_SNIPPETS
    .map((snippet) => {
      const candidates = [snippet.label, snippet.value, ...(snippet.keywords || [])]
        .map(normalizeAutocompleteText)
        .filter(Boolean);

      let score = 0;
      for (const candidate of candidates) {
        if (candidate === normalizedQuery) {
          score = Math.max(score, 500);
          continue;
        }
        if (candidate.startsWith(normalizedQuery)) {
          score = Math.max(score, 380 - Math.max(candidate.length - normalizedQuery.length, 0));
          continue;
        }
        if (candidate.split(' ').some((part) => part.startsWith(normalizedQuery))) {
          score = Math.max(score, 260);
          continue;
        }
        if (candidate.includes(normalizedQuery)) {
          score = Math.max(score, 140);
        }
      }

      return { ...snippet, score };
    })
    .filter((snippet) => snippet.score > 0 && normalizeAutocompleteText(snippet.value) !== normalizedQuery)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, 5);
}

function getRecipientFailureReason(recipient: CampaignRecipient) {
  const reason = String(recipient.errorMessage || '').trim();
  if (!reason) return 'Meta did not return a delivery reason.';

  if (reason.includes('131049')) {
    return 'Meta engagement block (131049). Ask the customer to message first, then send again inside the 24-hour window.';
  }

  if (reason.includes('132001')) {
    return 'Template/language mismatch (132001). Sync templates and verify the approved language translation exists.';
  }

  return reason;
}

function getCampaignStatusSummary(campaign: Campaign) {
  const recipients = campaign.recipients || [];
  let successCount = 0;
  let deliveredCount = 0;
  let readCount = 0;
  let failedCount = 0;
  let queuedCount = 0;
  let optInCount = 0;

  for (const recipient of recipients) {
    if (OPT_IN_WAITING_STATUSES.has(recipient.status)) {
      optInCount += 1;
      continue;
    }

    if (recipient.status === 'read') {
      successCount += 1;
      deliveredCount += 1;
      readCount += 1;
      continue;
    }

    if (recipient.status === 'delivered') {
      successCount += 1;
      deliveredCount += 1;
      continue;
    }

    if (recipient.status === 'sent') {
      successCount += 1;
      continue;
    }

    if (recipient.status === 'failed') {
      failedCount += 1;
      continue;
    }

    queuedCount += 1;
  }

  return {
    total: recipients.length || campaign.totalRecipients || 0,
    successCount,
    deliveredCount,
    readCount,
    failedCount,
    queuedCount,
    optInCount,
  };
}

function upsertCampaign(items: Campaign[], incoming: Campaign) {
  return [...items.filter((item) => item.id !== incoming.id), incoming]
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

function buildDeliveryGroups(campaign: Campaign) {
  const groups: Record<DeliveryGroupKey, CampaignRecipient[]> = {
    notDelivered: [],
    delivered: [],
    seen: [],
    underOptation: [],
  };

  for (const recipient of campaign.recipients || []) {
    if (OPT_IN_WAITING_STATUSES.has(recipient.status)) {
      groups.underOptation.push(recipient);
      continue;
    }

    if (recipient.status === 'read') {
      groups.seen.push(recipient);
      continue;
    }

    if (CAMPAIGN_SUCCESS_STATUSES.has(recipient.status)) {
      groups.delivered.push(recipient);
      continue;
    }

    groups.notDelivered.push(recipient);
  }

  return groups;
}

function getCampaignDeliveryLabel(campaign: Campaign) {
  const summary = getCampaignStatusSummary(campaign);

  if (summary.total > 0 && summary.readCount === summary.total) return `Seen by ${summary.total}`;
  if (summary.readCount > 0) return `Seen ${summary.readCount}/${summary.total}`;
  if (summary.deliveredCount > 0) return `Delivered ${summary.deliveredCount}/${summary.total}`;
  if (summary.successCount > 0) return `Sent ${summary.successCount}/${summary.total}`;
  if (summary.optInCount > 0) return `Under optation ${summary.optInCount}`;
  if (summary.failedCount > 0) return `${summary.failedCount} failed`;
  if (campaign.status === 'sending') return `Sending ${campaign.sentCount}/${campaign.totalRecipients}`;
  if (campaign.status === 'completed') return `Sent to ${campaign.sentCount}/${campaign.totalRecipients}`;
  return `Queued for ${campaign.totalRecipients}`;
}

function getCampaignCheckState(campaign: Campaign) {
  const summary = getCampaignStatusSummary(campaign);
  if (summary.total === 0) {
    if (campaign.status === 'completed') return 'sent';
    if (campaign.failedCount > 0) return 'failed';
    return 'queued';
  }

  if (summary.readCount === summary.total) return 'read';
  if (summary.deliveredCount === summary.total) return 'delivered';
  if (summary.successCount > 0) return 'sent';
  if (summary.optInCount > 0 || summary.queuedCount > 0) return 'queued';
  if (summary.failedCount > 0) return 'failed';
  return 'queued';
}

function isCampaignAfterListClear(campaign: Campaign, contactList: ContactList | null) {
  if (!contactList?.clearedAt) return true;
  return new Date(campaign.createdAt).getTime() > new Date(contactList.clearedAt).getTime();
}

function renderCampaignInfoButton(campaign: Campaign, onOpen: (campaign: Campaign) => void) {
  return (
    <button
      type="button"
      className="broadcast-info-trigger"
      onClick={() => void onOpen(campaign)}
      title="Message info"
      aria-label="Message info"
    >
      <Info size={14} />
    </button>
  );
}

function renderBroadcastPayload(payload: {
  id?: number | string;
  mode: Campaign['mode'];
  bodyText: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  previewUrl?: string | null;
}) {
  const bodyText = payload.bodyText || '';

  if (!isMediaCampaignMode(payload.mode)) {
    return <p>{bodyText || '[Template]'}</p>;
  }

  const src = payload.previewUrl || (typeof payload.id === 'number' ? getCampaignMediaUrl(payload.id) : null);
  const label = getAttachmentLabel(payload.mode, payload.mimeType);

  return (
    <div className="bubble__media broadcast-bubble__media">
      {payload.mode === 'image' && src ? (
        <div className="bubble__media-frame bubble__media-frame--image is-loaded is-landscape">
          <img src={src} alt={payload.fileName || bodyText || 'Broadcast image'} loading="lazy" />
        </div>
      ) : payload.mode === 'video' && src ? (
        <div className="bubble__media-frame bubble__media-frame--video is-loaded is-landscape">
          <video src={src} controls preload="metadata" />
        </div>
      ) : payload.mode === 'audio' && src ? (
        <div className="bubble__media-button bubble__media-button--audio">
          <Play size={18} />
          <div>
            <strong>{payload.fileName || 'Voice note'}</strong>
            <span>{label}</span>
          </div>
          <audio controls preload="metadata" src={src} />
        </div>
      ) : (
        <div className="bubble__attachment">
          <FileText size={18} />
          <div>
            <strong>{payload.fileName || label}</strong>
            <span>{label}</span>
          </div>
        </div>
      )}

      {bodyText && payload.mode !== 'audio' && (
        <p className="bubble__media-caption">{bodyText}</p>
      )}
    </div>
  );
}

function groupTitle(group: DeliveryGroupKey) {
  if (group === 'seen') return 'Read by';
  if (group === 'delivered') return 'Delivered to';
  if (group === 'underOptation') return 'Under opt-in';
  return 'Not delivered';
}

function groupIcon(group: DeliveryGroupKey) {
  if (group === 'seen') return <CheckCheck size={18} className="delivery-group-card__status-icon delivery-group-card__status-icon--read" />;
  if (group === 'delivered') return <CheckCheck size={18} className="delivery-group-card__status-icon" />;
  if (group === 'underOptation') return <Clock3 size={18} className="delivery-group-card__status-icon delivery-group-card__status-icon--waiting" />;
  return <AlertCircle size={18} className="delivery-group-card__status-icon delivery-group-card__status-icon--failed" />;
}

function optInLabel(status: string) {
  if (status === 'opted_in') return 'Opted in';
  if (status === 'pending_initial') return 'First template sent';
  if (status === 'pending_followup') return 'Follow-up sent';
  return 'Not opted in';
}

function BroadcastHistorySkeleton() {
  return (
    <div className="broadcast-history-skeleton" aria-label="Loading broadcast history">
      {[0, 1, 2].map((item) => (
        <div key={item} className="message-row message-row--outbound">
          <div className="bubble bubble--outbound broadcast-bubble skeleton-bubble">
            <span className="skeleton-line skeleton-line--wide" />
            <span className="skeleton-line skeleton-line--medium" />
            <span className="skeleton-line skeleton-line--short skeleton-line--meta" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ContactRowsSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="skeleton-list" aria-label="Loading contacts">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="member-picker-row skeleton-contact-row">
          <span className="skeleton-checkbox" />
          <span className="skeleton-avatar" />
          <span className="skeleton-contact-row__copy">
            <span className="skeleton-line skeleton-line--medium" />
            <span className="skeleton-line skeleton-line--short" />
          </span>
          <span className="skeleton-pill" />
        </div>
      ))}
    </div>
  );
}

function DeliveryGroupsSkeleton() {
  return (
    <div className="bottom-sheet__body delivery-groups" aria-label="Loading delivery info">
      <div className="delivery-groups-scroll">
        {[0, 1].map((page) => (
          <div key={page} className="delivery-groups-page">
            {[0, 1].map((group) => (
              <section key={`${page}-${group}`} className="delivery-group-card">
                <div className="delivery-group-card__title">
                  <span className="skeleton-line skeleton-line--medium" />
                  <span className="skeleton-pill" />
                </div>
                <ContactRowsSkeleton count={3} />
              </section>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function BroadcastWorkspace({ theme, contactList, onBack, onSendBroadcast, onContactListUpdated }: Props) {
  const [draft, setDraft] = useState('');
  const [draftSelection, setDraftSelection] = useState({ start: 0, end: 0 });
  const [file, setFile] = useState<File | null>(null);
  const [composerPreviewUrl, setComposerPreviewUrl] = useState<string | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [optimisticItems, setOptimisticItems] = useState<OptimisticBroadcast[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [infoCampaign, setInfoCampaign] = useState<Campaign | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState('');
  const [membersOpen, setMembersOpen] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [allContacts, setAllContacts] = useState<Contact[]>([]);
  const [selectedContactIds, setSelectedContactIds] = useState<number[]>([]);
  const [loadingMemberDetail, setLoadingMemberDetail] = useState(false);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [savingMembers, setSavingMembers] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [listNameDraft, setListNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [muted, setMuted] = useState(false);
  const [voiceMode, setVoiceMode] = useState<'idle' | 'recording' | 'review'>('idle');
  const [voiceDurationMs, setVoiceDurationMs] = useState(0);
  const [voiceChunkCount, setVoiceChunkCount] = useState(0);
  const [voiceError, setVoiceError] = useState('');
  const submitLockRef = useRef(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const emojiRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const broadcastItemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const voiceHoldTimerRef = useRef<number | null>(null);
  const voiceTimerRef = useRef<number | null>(null);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceStartedAtRef = useRef(0);
  const voiceAccumulatedMsRef = useRef(0);

  function closeMembersSheet() {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }

    setEditingName(false);
    setListNameDraft(contactList?.name || '');
    setMembersOpen(false);

    window.requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    });
  }

  const recipientCount = contactList ? getRecipientCount(contactList) : 0;
  const hasMemberDetails = contactList ? hasCompleteMemberDetails(contactList) : false;
  const selectedContactIdSet = useMemo(() => new Set(selectedContactIds), [selectedContactIds]);
  const memberPickerLoading = loadingContacts || loadingMemberDetail;

  const timeline = useMemo(() => {
    const combined = [
      ...campaigns.map((campaign) => ({
        kind: 'campaign' as const,
        createdAt: campaign.createdAt,
        campaign,
      })),
      ...optimisticItems.map((item) => ({
        kind: 'optimistic' as const,
        createdAt: item.createdAt,
        item,
      })),
    ].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());

    let lastDateLabel = '';
    return combined.flatMap((entry): BroadcastTimelineItem[] => {
      const currentDateLabel = formatDateLabel(entry.createdAt);
      const items: BroadcastTimelineItem[] = [];

      if (currentDateLabel !== lastDateLabel) {
        items.push({
          type: 'date',
          key: `date-${currentDateLabel}-${entry.createdAt}`,
          label: currentDateLabel,
        });
        lastDateLabel = currentDateLabel;
      }

      if (entry.kind === 'campaign') {
        items.push({
          type: 'campaign',
          key: `campaign-${entry.campaign.id}`,
          campaign: entry.campaign,
        });
      } else {
        items.push({
          type: 'optimistic',
          key: entry.item.id,
          item: entry.item,
        });
      }

      return items;
    });
  }, [campaigns, optimisticItems]);

  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];

    return timeline
      .filter((item): item is Exclude<BroadcastTimelineItem, { type: 'date' }> => item.type !== 'date')
      .filter((item) => getBroadcastSearchText(item.type === 'campaign' ? item.campaign : item.item).includes(query))
      .map((item) => item.key);
  }, [searchQuery, timeline]);
  const composerLineContext = useMemo(
    () => getComposerLineContext(draft, draftSelection.start, draftSelection.end),
    [draft, draftSelection.end, draftSelection.start],
  );
  const broadcastAutocompleteSuggestions = useMemo(
    () => getBroadcastAutocompleteSuggestions(composerLineContext.query),
    [composerLineContext.query],
  );

  const visibleContacts = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    if (!query) return allContacts;

    return allContacts.filter((contact) => [
      contact.profileName,
      contact.businessDirectoryName,
      contact.phoneNumber,
      contact.waId,
    ].filter(Boolean).join(' ').toLowerCase().includes(query));
  }, [allContacts, memberSearch]);

  const selectedContacts = useMemo(() => {
    const contactsById = new Map<number, Contact>();

    for (const member of contactList?.members || []) {
      contactsById.set(member.contact.id, member.contact);
    }

    for (const contact of allContacts) {
      contactsById.set(contact.id, contact);
    }

    return selectedContactIds
      .map((contactId) => contactsById.get(contactId))
      .filter((contact): contact is Contact => Boolean(contact));
  }, [allContacts, contactList?.members, selectedContactIds]);

  useEffect(() => {
    if (!file || (!file.type.startsWith('image/') && !file.type.startsWith('video/'))) {
      setComposerPreviewUrl(null);
      return undefined;
    }

    const url = URL.createObjectURL(file);
    setComposerPreviewUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  useEffect(() => {
    resizeComposerTextarea(textareaRef.current);
  }, [draft, file, contactList?.id]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (!emojiRef.current?.contains(target)) {
        setEmojiPickerOpen(false);
      }
      if (menuRef.current && !menuRef.current.contains(target)) {
        setMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (searchMatches.length === 0) {
      setActiveSearchIndex(0);
      return;
    }
    if (activeSearchIndex >= searchMatches.length) {
      setActiveSearchIndex(0);
    }
  }, [activeSearchIndex, searchMatches.length]);

  useEffect(() => {
    const activeKey = searchMatches[activeSearchIndex];
    if (!activeKey) return;
    broadcastItemRefs.current[activeKey]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeSearchIndex, searchMatches]);

  useEffect(() => () => {
    if (voiceHoldTimerRef.current) {
      clearTimeout(voiceHoldTimerRef.current);
    }
    if (voiceTimerRef.current) {
      clearInterval(voiceTimerRef.current);
    }
    voiceRecorderRef.current?.state === 'recording' && voiceRecorderRef.current.stop();
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    setDraft('');
    setFile(null);
    setEmojiPickerOpen(false);
    setError('');
    setInfoError('');
    setInfoCampaign(null);
    setMembersOpen(false);
    setEditingName(false);
    setMenuOpen(false);
    setSearchOpen(false);
    setSearchQuery('');
    setActiveSearchIndex(0);
    setListNameDraft(contactList?.name || '');
    setOptimisticItems([]);
    setCampaigns([]);
    clearVoiceRecording();

    if (!contactList) {
      setMuted(false);
      return;
    }

    try {
      const saved = JSON.parse(window.localStorage.getItem('jjewa-muted-broadcasts') || '[]');
      setMuted(Array.isArray(saved) && saved.includes(contactList.id));
    } catch {
      setMuted(false);
    }

    let cancelled = false;
    const cachedCampaigns = getCachedContactListCampaigns(contactList.id);
    if (cachedCampaigns) {
      setCampaigns(cachedCampaigns.filter((item) => item && isCampaignAfterListClear(item, contactList)));
      setLoading(false);
    } else {
      setLoading(true);
    }

    void getContactListCampaigns(contactList.id)
      .then((items) => {
        if (!cancelled) setCampaigns(items.filter((item) => item && isCampaignAfterListClear(item, contactList)));
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Failed to load broadcast history');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [contactList?.clearedAt, contactList?.id]);

  useEffect(() => {
    if (!editingName) {
      setListNameDraft(contactList?.name || '');
    }
  }, [contactList?.name, editingName]);

  useEffect(() => {
    if (!contactList) return;

    function handleCampaignUpdated(campaign: Campaign) {
      if (campaign.contactListId !== contactList?.id) return;
      if (!isCampaignAfterListClear(campaign, contactList)) return;
      setCampaigns((current) => upsertCampaign(current, campaign));
      setInfoCampaign((current) => (current?.id === campaign.id ? campaign : current));
    }

    socket.on('campaign:updated', handleCampaignUpdated);
    return () => {
      socket.off('campaign:updated', handleCampaignUpdated);
    };
  }, [contactList?.id]);

  useEffect(() => {
    if (!messagesRef.current) return;
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [timeline.length, contactList?.id]);

  useEffect(() => {
    if (!membersOpen || !contactList) return;

    let cancelled = false;

    if (hasCompleteMemberDetails(contactList)) {
      setSelectedContactIds(contactList.members.map((member) => member.contact.id));
    } else {
      setLoadingMemberDetail(true);
      void getContactList(contactList.id)
        .then((detail) => {
          if (cancelled) return;
          onContactListUpdated(detail);
          setSelectedContactIds((detail.members || []).map((member) => member.contact.id));
        })
        .catch((loadError) => {
          if (!cancelled) {
            setError(loadError instanceof Error ? loadError.message : 'Failed to load broadcast participants');
          }
        })
        .finally(() => {
          if (!cancelled) setLoadingMemberDetail(false);
        });
    }

    if (allContacts.length === 0) {
      const cachedContacts = getCachedContactDirectory(CONTACT_FETCH_LIMIT);
      if (cachedContacts) {
        setAllContacts(cachedContacts);
        setLoadingContacts(false);
      } else {
        setLoadingContacts(true);
      }

      void listContacts('', CONTACT_FETCH_LIMIT)
        .then((contacts) => {
          if (!cancelled) setAllContacts(contacts);
        })
        .catch((loadError) => {
          if (!cancelled) {
            setError(loadError instanceof Error ? loadError.message : 'Failed to load contacts');
          }
        })
        .finally(() => {
          if (!cancelled) setLoadingContacts(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [allContacts.length, contactList, membersOpen, onContactListUpdated]);

  async function openInfoDrawer(campaign: Campaign) {
    if (infoLoading && infoCampaign?.id === campaign.id) return;

    setInfoCampaign(campaign);
    setInfoError('');
    setInfoLoading(true);
    try {
      const detail = await getCampaign(campaign.id);
      if (!detail) {
        throw new Error('Campaign not found');
      }
      setInfoCampaign(detail);
      setCampaigns((current) => upsertCampaign(current, detail));
    } catch (loadError) {
      setInfoError(loadError instanceof Error ? loadError.message : 'Failed to load delivery details');
    } finally {
      setInfoLoading(false);
    }
  }

  function handleEmojiClick(emojiData: EmojiClickData) {
    setDraft((current) => `${current}${emojiData.emoji}`);
    if (shouldAutoFocusComposer()) {
      textareaRef.current?.focus();
    }
  }

  function syncDraftSelection(target: HTMLTextAreaElement | null) {
    if (!target) return;
    setDraftSelection({
      start: target.selectionStart ?? target.value.length,
      end: target.selectionEnd ?? target.value.length,
    });
  }

  function applyAutocompleteSnippet(value: string, options?: { nextDraft?: string; start?: number; end?: number }) {
    const baseDraft = options?.nextDraft ?? draft;
    const selectionStart = options?.start ?? textareaRef.current?.selectionStart ?? draftSelection.start ?? baseDraft.length;
    const selectionEnd = options?.end ?? textareaRef.current?.selectionEnd ?? draftSelection.end ?? selectionStart;
    const context = getComposerLineContext(baseDraft, selectionStart, selectionEnd);
    const replacement = `${context.leadingWhitespace}${value}`;
    const nextDraft = `${baseDraft.slice(0, context.lineStart)}${replacement}${baseDraft.slice(context.lineEnd)}`;
    const caretPosition = context.lineStart + replacement.length;

    setDraft(nextDraft);
    setDraftSelection({ start: caretPosition, end: caretPosition });

    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(caretPosition, caretPosition);
      resizeComposerTextarea(textarea);
    });
  }

  function clearVoiceTimer() {
    if (voiceTimerRef.current) {
      clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
  }

  function stopVoiceStream() {
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    voiceStreamRef.current = null;
  }

  async function startVoiceRecording() {
    if (voiceMode === 'recording' || sending || recipientCount === 0) return;

    const supportError = getVoiceRecorderSupportError();
    if (supportError) {
      setVoiceError(supportError);
      return;
    }

    setVoiceError('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const supportedMimeType = getSupportedVoiceMimeType();
      const recorder = new MediaRecorder(stream, supportedMimeType ? { mimeType: supportedMimeType } : undefined);
      voiceStreamRef.current = stream;
      voiceRecorderRef.current = recorder;

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          voiceChunksRef.current.push(event.data);
          setVoiceChunkCount(voiceChunksRef.current.length);
        }
      });

      recorder.addEventListener('stop', stopVoiceStream, { once: true });
      voiceStartedAtRef.current = Date.now();
      recorder.start();
      setVoiceMode('recording');
      clearVoiceTimer();
      voiceTimerRef.current = window.setInterval(() => {
        setVoiceDurationMs(voiceAccumulatedMsRef.current + Date.now() - voiceStartedAtRef.current);
      }, 250);
    } catch (recordError) {
      stopVoiceStream();
      setVoiceError(recordError instanceof Error ? recordError.message : 'Could not start recording');
      setVoiceMode(voiceChunksRef.current.length > 0 ? 'review' : 'idle');
    }
  }

  function pauseVoiceRecordingForReview() {
    if (voiceRecorderRef.current?.state !== 'recording') return;

    voiceAccumulatedMsRef.current += Date.now() - voiceStartedAtRef.current;
    setVoiceDurationMs(voiceAccumulatedMsRef.current);
    clearVoiceTimer();
    voiceRecorderRef.current.stop();
    voiceRecorderRef.current = null;
    setVoiceMode('review');
  }

  function clearVoiceRecording() {
    if (voiceRecorderRef.current?.state === 'recording') {
      voiceRecorderRef.current.stop();
    }
    clearVoiceTimer();
    stopVoiceStream();
    voiceRecorderRef.current = null;
    voiceChunksRef.current = [];
    setVoiceChunkCount(0);
    voiceAccumulatedMsRef.current = 0;
    voiceStartedAtRef.current = 0;
    setVoiceDurationMs(0);
    setVoiceMode('idle');
    setVoiceError('');
  }

  function handleMicPointerDown() {
    if (sending || recipientCount === 0 || file || draft.trim()) return;

    if (voiceHoldTimerRef.current) {
      clearTimeout(voiceHoldTimerRef.current);
    }

    voiceHoldTimerRef.current = window.setTimeout(() => {
      voiceHoldTimerRef.current = null;
      void startVoiceRecording();
    }, 500);
  }

  function handleMicPointerEnd() {
    if (voiceHoldTimerRef.current) {
      clearTimeout(voiceHoldTimerRef.current);
      voiceHoldTimerRef.current = null;
      return;
    }

    pauseVoiceRecordingForReview();
  }

  async function handleSubmit(override?: { file?: File | null; bodyText?: string }) {
    if (!contactList || submitLockRef.current || sending) return;

    const bodyText = override?.bodyText !== undefined ? override.bodyText.trim() : draft.trim();
    const selectedFile = override?.file !== undefined ? override.file : file;
    if ((!bodyText && !selectedFile) || recipientCount === 0) return;

    const mode = selectedFile ? getFileCampaignMode(selectedFile) : 'text';
    const optimisticPreviewUrl = selectedFile && (selectedFile.type.startsWith('image/') || selectedFile.type.startsWith('video/'))
      ? URL.createObjectURL(selectedFile)
      : null;

    const optimisticItem: OptimisticBroadcast = {
      id: `broadcast-${Date.now()}`,
      bodyText,
      mode,
      fileName: selectedFile?.name || null,
      mimeType: selectedFile?.type || null,
      previewUrl: optimisticPreviewUrl,
      createdAt: new Date().toISOString(),
      totalRecipients: recipientCount,
      status: 'queued',
    };

    submitLockRef.current = true;
    setSending(true);
    setError('');
    setDraft('');
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setOptimisticItems((current) => [...current, optimisticItem]);

    try {
      const campaign = await onSendBroadcast(contactList, { bodyText, file: selectedFile });
      setCampaigns((current) => upsertCampaign(current, campaign));
      setOptimisticItems((current) => current.filter((item) => item.id !== optimisticItem.id));
      if (optimisticPreviewUrl) URL.revokeObjectURL(optimisticPreviewUrl);
    } catch (sendError) {
      setOptimisticItems((current) => current.map((item) => (
        item.id === optimisticItem.id
          ? {
              ...item,
              status: 'failed',
              errorMessage: sendError instanceof Error ? sendError.message : 'Broadcast failed',
            }
          : item
      )));
      setDraft(bodyText);
      setFile(selectedFile || null);
      setError(sendError instanceof Error ? sendError.message : 'Broadcast failed');
    } finally {
      setSending(false);
      submitLockRef.current = false;
    }
  }

  async function sendVoiceRecording() {
    if (voiceMode === 'recording') {
      pauseVoiceRecordingForReview();
    }

    if (voiceChunksRef.current.length === 0) return;

    const mimeType = voiceChunksRef.current[0]?.type || 'audio/ogg';
    const extension = getAudioExtension(mimeType);
    const voiceFile = new File(
      voiceChunksRef.current,
      `broadcast-voice-note-${Date.now()}.${extension}`,
      { type: mimeType },
    );

    clearVoiceRecording();
    await handleSubmit({ file: voiceFile, bodyText: '' });
  }

  function toggleContact(contactId: number) {
    setSelectedContactIds((current) => (
      current.includes(contactId)
        ? current.filter((id) => id !== contactId)
        : [...current, contactId]
    ));
  }

  function removeSelectedContact(contactId: number) {
    setSelectedContactIds((current) => current.filter((id) => id !== contactId));
  }

  async function handleSaveMembers() {
    if (!contactList) return;

    setSavingMembers(true);
    setError('');

    try {
      const updatedList = await replaceContactListMembers(
        contactList.id,
        selectedContactIds.map((contactId) => ({ contactId })),
      );
      onContactListUpdated(updatedList);
      closeMembersSheet();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to update broadcast members');
    } finally {
      setSavingMembers(false);
    }
  }

  async function handleSaveListName() {
    if (!contactList) return;

    const name = listNameDraft.replace(/\s+/g, ' ').trim();
    if (!name || name === contactList.name) {
      setEditingName(false);
      setListNameDraft(contactList.name);
      return;
    }

    setSavingName(true);
    setError('');
    try {
      const updatedList = await renameContactList(contactList.id, name);
      onContactListUpdated(updatedList);
      setEditingName(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to rename broadcast list');
    } finally {
      setSavingName(false);
    }
  }

  function handleToggleSearch() {
    setSearchOpen((current) => {
      const next = !current;
      if (!next) {
        setSearchQuery('');
        setActiveSearchIndex(0);
      }
      return next;
    });
    setMenuOpen(false);
  }

  function handleJumpToLatest() {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth',
    });
    setMenuOpen(false);
  }

  function handleToggleMute() {
    if (!contactList) return;

    setMuted((current) => {
      const next = !current;
      let mutedIds: number[] = [];
      try {
        const saved = JSON.parse(window.localStorage.getItem('jjewa-muted-broadcasts') || '[]');
        mutedIds = Array.isArray(saved) ? saved.filter((value) => Number.isInteger(value)) : [];
      } catch {
        mutedIds = [];
      }

      const updatedIds = next
        ? [...new Set([...mutedIds, contactList.id])]
        : mutedIds.filter((listId) => listId !== contactList.id);
      window.localStorage.setItem('jjewa-muted-broadcasts', JSON.stringify(updatedIds));
      return next;
    });
    setMenuOpen(false);
  }

  function openBroadcastEditor() {
    setListNameDraft(contactList?.name || '');
    setEditingName(true);
    setMembersOpen(true);
    setMenuOpen(false);
  }

  if (!contactList) {
    return (
      <section className="chat-pane chat-pane--empty">
        <div className="chat-pane__empty-state frosted-card">
          <div className="chat-pane__empty-logo">J</div>
          <h2>Jay Jalaram Enterprise</h2>
          <p>Select a broadcast list from the left to send a message.</p>
        </div>
      </section>
    );
  }

  const contactListMembers = hasMemberDetails ? (contactList.members || []) : [];
  const optedInMembers = contactListMembers.filter((member) => member.contact.optInStatus === 'opted_in');
  const notOptedInMembers = contactListMembers.filter((member) => member.contact.optInStatus !== 'opted_in');
  const deliveryGroups = infoCampaign ? buildDeliveryGroups(infoCampaign) : null;
  const displayMemberTotal = hasMemberDetails ? contactListMembers.length : recipientCount;

  return (
    <section className="chat-pane broadcast-chat-pane">
      <header className="chat-pane__header">
        <div className="chat-pane__header-main">
          <button type="button" className="mobile-back-button" onClick={onBack} title="Back to chats">
            <ArrowLeft size={22} />
          </button>
          <button type="button" className="chat-pane__contact broadcast-header-button" onClick={() => setMembersOpen(true)}>
            <div className="chat-pane__avatar chat-pane__avatar--broadcast">
              <Megaphone size={18} />
            </div>
            <div>
              <strong>{contactList.name}</strong>
              <div className="chat-pane__subtitle-row">
                <div className="chat-pane__subtitle">
                  {recipientCount} recipients
                </div>
                {muted && (
                  <span className="chat-pane__mute-indicator" title="Muted">
                    <BellOff size={14} />
                  </span>
                )}
              </div>
            </div>
          </button>
        </div>
        <div className="chat-pane__header-actions">
          <button type="button" className="toolbar-icon-button" title="Search in broadcast" onClick={handleToggleSearch}>
            <Search size={18} />
          </button>
          <div ref={menuRef} className="chat-pane__menu-anchor">
            <button
              type="button"
              className="toolbar-icon-button"
              title="More options"
              onClick={() => setMenuOpen((current) => !current)}
            >
              <MoreVertical size={18} />
            </button>
            {menuOpen && (
              <div className="chat-pane__menu">
                <button type="button" onClick={openBroadcastEditor}>
                  <Pencil size={16} />
                  <span>Edit broadcast</span>
                </button>
                <button type="button" onClick={() => { setMembersOpen(true); setMenuOpen(false); }}>
                  <Users size={16} />
                  <span>Broadcast participants</span>
                </button>
                <button type="button" onClick={handleToggleMute}>
                  {muted ? <Bell size={16} /> : <BellOff size={16} />}
                  <span>{muted ? 'Unmute broadcast' : 'Mute broadcast'}</span>
                </button>
                <button type="button" onClick={handleToggleSearch}>
                  <Search size={16} />
                  <span>Search in broadcast</span>
                </button>
                <button type="button" onClick={handleJumpToLatest}>
                  <ChevronDown size={16} />
                  <span>Jump to latest</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {searchOpen && (
        <div className="chat-pane__searchbar">
          <Search size={16} />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search in broadcast"
          />
          <span className="chat-pane__searchbar-count">
            {searchMatches.length === 0 ? '0' : `${activeSearchIndex + 1}/${searchMatches.length}`}
          </span>
          <button
            type="button"
            className="toolbar-icon-button"
            onClick={() => setActiveSearchIndex((current) => (current <= 0 ? searchMatches.length - 1 : current - 1))}
            disabled={searchMatches.length === 0}
            title="Previous result"
          >
            <ChevronUp size={16} />
          </button>
          <button
            type="button"
            className="toolbar-icon-button"
            onClick={() => setActiveSearchIndex((current) => (current + 1) % searchMatches.length)}
            disabled={searchMatches.length === 0}
            title="Next result"
          >
            <ChevronDown size={16} />
          </button>
          <button type="button" className="toolbar-icon-button" onClick={handleToggleSearch} title="Close search">
            <X size={16} />
          </button>
        </div>
      )}

      <div ref={messagesRef} className="chat-pane__messages broadcast-chat-pane__messages">
        {loading && timeline.length === 0 && <BroadcastHistorySkeleton />}

        {!loading && timeline.length === 0 && (
          <div className="broadcast-chat__empty frosted-card">
            <Users size={20} />
            <span>Send one message here. Each recipient will receive it as a private chat.</span>
          </div>
        )}

        {timeline.map((item) => {
          if (item.type === 'date') {
            return (
              <div key={item.key} className="chat-date-divider">
                <span>{item.label}</span>
              </div>
            );
          }

          if (item.type === 'campaign') {
            return (
              <div
                key={item.key}
                ref={(node) => { broadcastItemRefs.current[item.key] = node; }}
                className={`message-row message-row--outbound ${searchMatches[activeSearchIndex] === item.key ? 'message-row--search-active' : ''}`}
              >
                <div className="bubble bubble--outbound broadcast-bubble">
                  <div className="bubble__content">
                    {renderBroadcastPayload({
                      id: item.campaign.id,
                      mode: item.campaign.mode,
                      bodyText: item.campaign.bodyText,
                      fileName: item.campaign.fileName,
                      mimeType: item.campaign.mimeType,
                    })}
                  </div>
                  <div className="bubble__meta bubble__meta--broadcast">
                    <span>{getCampaignDeliveryLabel(item.campaign)}</span>
                    <span>{formatBubbleTime(item.campaign.createdAt)}</span>
                    {renderCampaignInfoButton(item.campaign, openInfoDrawer)}
                  </div>
                </div>
              </div>
            );
          }

          return (
            <div
              key={item.key}
              ref={(node) => { broadcastItemRefs.current[item.key] = node; }}
              className={`message-row message-row--outbound ${searchMatches[activeSearchIndex] === item.key ? 'message-row--search-active' : ''}`}
            >
              <div className={`bubble bubble--outbound broadcast-bubble ${item.item.status === 'failed' ? 'broadcast-bubble--failed' : ''}`}>
                <div className="bubble__content">
                  {renderBroadcastPayload({
                    id: item.item.id,
                    mode: item.item.mode,
                    bodyText: item.item.bodyText,
                    fileName: item.item.fileName,
                    mimeType: item.item.mimeType,
                    previewUrl: item.item.previewUrl,
                  })}
                </div>
                {item.item.errorMessage && (
                  <div className="broadcast-bubble__error">{item.item.errorMessage}</div>
                )}
                <div className="bubble__meta bubble__meta--broadcast">
                  <span>{item.item.status === 'failed' ? 'Failed' : `Queued for ${item.item.totalRecipients}`}</span>
                  <span>{formatBubbleTime(item.item.createdAt)}</span>
                  {item.item.status === 'failed'
                    ? <AlertCircle size={15} className="bubble__status bubble__status--failed" />
                    : <Clock3 size={15} className="bubble__status bubble__status--queued" />}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <footer className="chat-pane__composer-shell">
        {file && (
          <div className="composer__file-chip">
            {composerPreviewUrl ? (
              file.type.startsWith('image/') ? (
                <img className="composer__file-preview" src={composerPreviewUrl} alt={file.name} />
              ) : (
                <video className="composer__file-preview" muted playsInline preload="metadata" src={composerPreviewUrl} />
              )
            ) : (
              <span className="composer__file-icon">
                {file.type.startsWith('audio/') ? <Play size={16} /> : <FileText size={16} />}
              </span>
            )}
            <div className="composer__file-meta">
              <strong>{file.name}</strong>
              <span>{getAttachmentLabel(getFileCampaignMode(file), file.type)}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setFile(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
            >
              Remove
            </button>
          </div>
        )}

        {(voiceMode !== 'idle' || voiceError) && (
          <div className={`composer__voice-review ${voiceMode === 'recording' ? 'is-recording' : ''}`}>
            <div className="composer__voice-pulse">
              <Mic size={16} />
            </div>
            <div className="composer__voice-copy">
              <strong>{voiceMode === 'recording' ? 'Recording...' : 'Voice note paused'}</strong>
              <span>{voiceError || `${formatVoiceDuration(voiceDurationMs)} recorded. Hold mic again to add more.`}</span>
            </div>
            <button type="button" className="composer__voice-clear" onClick={clearVoiceRecording}>
              <Trash2 size={16} />
              <span>Cancel</span>
            </button>
            <button
              type="button"
              className="composer__voice-send"
              onClick={() => void sendVoiceRecording()}
              disabled={voiceChunkCount === 0 || sending || recipientCount === 0}
            >
              Send
            </button>
          </div>
        )}

        {error && (
          <div className="broadcast-composer-error">
            {error}
          </div>
        )}

        {recipientCount === 0 && (
          <div className="broadcast-composer-error">
            This broadcast list has no recipients.
          </div>
        )}

        {broadcastAutocompleteSuggestions.length > 0 && (
          <div className="composer__autocomplete-strip" aria-label="Broadcast autocomplete suggestions">
            {broadcastAutocompleteSuggestions.map((snippet, index) => (
              <button
                key={snippet.label}
                type="button"
                className={`composer__autocomplete-pill ${index === 0 ? 'is-primary' : ''}`}
                onClick={() => applyAutocompleteSnippet(snippet.value)}
                title={snippet.value.trim()}
              >
                {snippet.label}
              </button>
            ))}
          </div>
        )}

        <div className="composer broadcast-composer">
          <div ref={emojiRef} className="composer__emoji-anchor">
            <button
              type="button"
              className="composer__icon-button"
              title="Emoji"
              onClick={() => {
                setEmojiPickerOpen((current) => !current);
                if (shouldAutoFocusComposer()) {
                  textareaRef.current?.focus();
                }
              }}
            >
              <Smile size={19} />
            </button>

            {emojiPickerOpen && (
              <div className="emoji-picker-shell">
                <Suspense fallback={<div className="emoji-picker-loading"><span className="skeleton-line skeleton-line--wide" /></div>}>
                  <EmojiPicker
                    open
                    onEmojiClick={handleEmojiClick}
                    theme={theme}
                    emojiStyle="native"
                    lazyLoadEmojis
                    width={320}
                    height={380}
                    autoFocusSearch={false}
                    searchPlaceholder="Search emoji"
                    previewConfig={{ showPreview: false }}
                  />
                </Suspense>
              </div>
            )}
          </div>

          <label className="composer__attach" title="Attach">
            <Paperclip size={18} />
            <input
              ref={fileInputRef}
              type="file"
              hidden
              disabled={sending || recipientCount === 0}
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
          </label>

          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            placeholder={file ? 'Add caption' : 'Type a broadcast message'}
            onChange={(event) => {
              const nextDraft = event.target.value;
              const nextStart = event.target.selectionStart ?? nextDraft.length;
              const nextEnd = event.target.selectionEnd ?? nextDraft.length;
              const inputType = (event.nativeEvent as InputEvent | undefined)?.inputType || '';
              const nextContext = getComposerLineContext(nextDraft, nextStart, nextEnd);
              const nextSuggestions = getBroadcastAutocompleteSuggestions(nextContext.query);
              const shouldAutoComplete = inputType.startsWith('insert')
                && nextContext.query.length >= 2
                && nextSuggestions.length === 1;

              if (shouldAutoComplete) {
                applyAutocompleteSnippet(nextSuggestions[0].value, {
                  nextDraft,
                  start: nextStart,
                  end: nextEnd,
                });
                return;
              }

              setDraft(nextDraft);
              setDraftSelection({ start: nextStart, end: nextEnd });
            }}
            onClick={(event) => syncDraftSelection(event.currentTarget)}
            onKeyUp={(event) => syncDraftSelection(event.currentTarget)}
            onSelect={(event) => syncDraftSelection(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === 'Tab' && broadcastAutocompleteSuggestions.length > 0) {
                event.preventDefault();
                applyAutocompleteSnippet(broadcastAutocompleteSuggestions[0].value);
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey && shouldSubmitOnEnter()) {
                event.preventDefault();
                void handleSubmit();
              }
            }}
          />

          {draft.trim() || file ? (
            <button type="button" className="composer__send" onClick={() => void handleSubmit()} disabled={sending || recipientCount === 0}>
              <SendHorizonal size={18} />
            </button>
          ) : (
            <button
              type="button"
              className={`composer__send composer__mic ${voiceMode === 'recording' ? 'is-recording' : ''}`}
              onPointerDown={handleMicPointerDown}
              onPointerUp={handleMicPointerEnd}
              onPointerCancel={handleMicPointerEnd}
              onPointerLeave={voiceMode === 'recording' ? handleMicPointerEnd : undefined}
              disabled={sending || recipientCount === 0}
              title={voiceMode === 'review' ? 'Hold to continue recording' : 'Hold to record voice note'}
            >
              <Mic size={18} />
            </button>
          )}
        </div>
      </footer>

      <div className={`bottom-sheet ${infoCampaign ? 'is-open' : ''}`} aria-hidden={!infoCampaign}>
        <div className="bottom-sheet__backdrop" onClick={() => setInfoCampaign(null)} />
        <section className="bottom-sheet__panel frosted-panel" role="dialog" aria-modal="true">
          <header className="bottom-sheet__header">
            <div>
              <span className="bottom-sheet__eyebrow">Broadcast info</span>
              <h2>Message delivery</h2>
            </div>
            <button type="button" className="toolbar-icon-button" onClick={() => setInfoCampaign(null)} title="Close">
              <X size={18} />
            </button>
          </header>

          {infoLoading && <DeliveryGroupsSkeleton />}

          {!infoLoading && infoCampaign && deliveryGroups && (
            <div className="bottom-sheet__body delivery-groups">
              <div className="delivery-info-preview">
                <div className="bubble bubble--outbound broadcast-bubble">
                  <div className="bubble__content">
                    {renderBroadcastPayload({
                      id: infoCampaign.id,
                      mode: infoCampaign.mode,
                      bodyText: isMediaCampaignMode(infoCampaign.mode)
                        ? infoCampaign.bodyText
                        : infoCampaign.bodyText || infoCampaign.templateName || '[Template]',
                      fileName: infoCampaign.fileName,
                      mimeType: infoCampaign.mimeType,
                    })}
                  </div>
                  <div className="bubble__meta bubble__meta--broadcast">
                    <span>{formatBubbleTime(infoCampaign.createdAt)}</span>
                  </div>
                </div>
              </div>

              {infoError && (
                <div className="delivery-info-warning">
                  {infoError}. Showing the last known campaign summary.
                </div>
              )}
              <div className="delivery-groups-scroll" aria-label="Delivery status sections">
                {DELIVERY_GROUP_PAGES.map((page, pageIndex) => (
                  <div
                    key={page.join('-')}
                    className="delivery-groups-page"
                    aria-label={pageIndex === 0 ? 'Read and delivered recipients' : 'Pending and not delivered recipients'}
                  >
                    {page.map((group) => (
                      <section key={group} className={`delivery-group-card delivery-group-card--${group}`}>
                        <div className="delivery-group-card__title">
                          <div>
                            <strong>{groupTitle(group)}</strong>
                            <span>{deliveryGroups[group].length}</span>
                          </div>
                          {groupIcon(group)}
                        </div>
                        <div className="delivery-recipient-list">
                          {deliveryGroups[group].map((recipient) => (
                            <article key={recipient.id} className="delivery-recipient-row">
                              <div className="recipient-avatar recipient-avatar--compact">{getRecipientName(recipient).slice(0, 1).toUpperCase()}</div>
                              <div className="delivery-recipient-row__copy">
                                <strong>{getRecipientName(recipient)}</strong>
                                {group === 'notDelivered' && recipient.status === 'failed' && (
                                  <span className="delivery-recipient-row__reason">
                                    {getRecipientFailureReason(recipient)}
                                  </span>
                                )}
                              </div>
                              <small>
                                {recipient.readAt
                                  ? formatBubbleTime(recipient.readAt)
                                  : recipient.deliveredAt
                                    ? formatBubbleTime(recipient.deliveredAt)
                                    : recipient.sentAt
                                      ? formatBubbleTime(recipient.sentAt)
                                      : recipient.optInRequestedAt
                                        ? formatBubbleTime(recipient.optInRequestedAt)
                                        : ''}
                              </small>
                            </article>
                          ))}
                          {deliveryGroups[group].length === 0 && (
                            <div className="delivery-empty-row">No participants here.</div>
                          )}
                        </div>
                      </section>
                    ))}
                  </div>
                ))}
              </div>
              <div className="delivery-groups-hint">
                <span>Read / delivered</span>
                <span>Swipe for not delivered / opt-in</span>
              </div>
            </div>
          )}
        </section>
      </div>

      <div className={`bottom-sheet ${membersOpen ? 'is-open' : ''}`} aria-hidden={!membersOpen}>
        <div className="bottom-sheet__backdrop" onClick={closeMembersSheet} />
        <section className="bottom-sheet__panel bottom-sheet__panel--wide frosted-panel" role="dialog" aria-modal="true">
          <header className="bottom-sheet__header">
            <div>
              <span className="bottom-sheet__eyebrow">Broadcast list</span>
              {editingName ? (
                <div className="broadcast-name-editor">
                  <input
                    value={listNameDraft}
                    onChange={(event) => setListNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleSaveListName();
                      if (event.key === 'Escape') {
                        setEditingName(false);
                        setListNameDraft(contactList.name);
                      }
                    }}
                    maxLength={120}
                    autoFocus
                  />
                  <button type="button" onClick={() => void handleSaveListName()} disabled={savingName}>
                    {savingName ? 'Saving...' : 'Save'}
                  </button>
                </div>
              ) : (
                <div className="broadcast-name-heading">
                  <h2>{contactList.name}</h2>
                  <button type="button" onClick={() => setEditingName(true)} title="Rename broadcast list">
                    <Pencil size={15} />
                  </button>
                </div>
              )}
              <p>{hasMemberDetails ? `${optedInMembers.length} opted in, ${notOptedInMembers.length} not opted in` : 'Loading participants'}</p>
            </div>
            <button type="button" className="toolbar-icon-button" onClick={closeMembersSheet} title="Close">
              <X size={18} />
            </button>
          </header>

          <div className="bottom-sheet__body members-manager">
            <div className="members-summary-grid">
              <div>
                <span>Total members</span>
                <strong>{displayMemberTotal}</strong>
              </div>
              <div>
                <span>Opted in</span>
                <strong>{optedInMembers.length}</strong>
              </div>
              <div>
                <span>Not opted in</span>
                <strong>{notOptedInMembers.length}</strong>
              </div>
              <div>
                <span>Selected now</span>
                <strong>{selectedContactIds.length}</strong>
              </div>
            </div>

            <label className="contact-search-input members-search">
              <Search size={16} />
              <input
                value={memberSearch}
                onChange={(event) => setMemberSearch(event.target.value)}
                placeholder="Search contacts to add or remove"
              />
            </label>

            <section className="selected-members-card">
              <div className="selected-members-card__header">
                <strong>Participants</strong>
                <span>{selectedContactIds.length}</span>
              </div>

              {selectedContacts.length > 0 ? (
                <div className="selected-members-list">
                  {selectedContacts.map((contact) => (
                    <article key={contact.id} className="selected-member-row">
                      <span className="recipient-avatar">{getContactName(contact).slice(0, 1).toUpperCase()}</span>
                      <span className="selected-member-row__copy">
                        <strong>{getContactName(contact)}</strong>
                        <span>{contact.phoneNumber || contact.waId}</span>
                      </span>
                      <button
                        type="button"
                        className="selected-member-row__remove"
                        onClick={() => removeSelectedContact(contact.id)}
                      >
                        Remove
                      </button>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="contact-picker-list__state">No participants selected.</div>
              )}
            </section>

            <div className="member-picker-list">
              {memberPickerLoading && <ContactRowsSkeleton />}

              {!memberPickerLoading && visibleContacts.map((contact) => {
                const selected = selectedContactIdSet.has(contact.id);

                return (
                  <button
                    key={contact.id}
                    type="button"
                    className={`member-picker-row ${selected ? 'is-selected' : ''}`}
                    onClick={() => toggleContact(contact.id)}
                  >
                    <span className={`contact-picker-row__checkbox ${selected ? 'is-selected' : ''}`}>
                      {selected ? <Check size={14} /> : null}
                    </span>
                    <span className="recipient-avatar">{getContactName(contact).slice(0, 1).toUpperCase()}</span>
                    <span className="member-picker-row__copy">
                      <strong>{getContactName(contact)}</strong>
                      <span>{contact.phoneNumber || contact.waId}</span>
                    </span>
                    <span className={`contact-optin-badge contact-optin-badge--${contact.optInStatus || 'unknown'}`}>
                      {optInLabel(contact.optInStatus)}
                    </span>
                  </button>
                );
              })}

              {!memberPickerLoading && visibleContacts.length === 0 && (
                <div className="contact-picker-list__state">No contacts found.</div>
              )}
            </div>
          </div>

          <footer className="bottom-sheet__footer">
            <button type="button" className="ghost-button" onClick={closeMembersSheet}>
              Cancel
            </button>
            <button type="button" className="primary-button" onClick={() => void handleSaveMembers()} disabled={savingMembers}>
              {savingMembers ? 'Saving...' : 'Save participants'}
            </button>
          </footer>
        </section>
      </div>
    </section>
  );
}
