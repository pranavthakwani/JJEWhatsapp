import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCheck,
  Clock3,
  FileText,
  Info,
  Megaphone,
  Mic,
  Paperclip,
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

const DELIVERY_GROUP_PAGES: DeliveryGroupKey[][] = [
  ['seen', 'delivered'],
  ['notDelivered', 'underOptation'],
];

const CONTACT_FETCH_LIMIT = 50000;
const OPT_IN_WAITING_STATUSES = new Set(['optin_initial_sent', 'optin_followup_sent']);
const VOICE_RECORDER_MIME_TYPES = [
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
];

function shouldSubmitOnEnter() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
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

function getRecipientCount(contactList: ContactList) {
  return contactList.memberCount ?? contactList.members?.length ?? 0;
}

function hasCompleteMemberDetails(contactList: ContactList) {
  return Array.isArray(contactList.members) && contactList.members.length >= getRecipientCount(contactList);
}

function getContactName(contact: Contact) {
  return contact.profileName || contact.businessDirectoryName || contact.phoneNumber || contact.waId;
}

function getRecipientName(recipient: CampaignRecipient) {
  return recipient.recipientName || recipient.recipientWaId;
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

    if (recipient.status === 'delivered') {
      groups.delivered.push(recipient);
      continue;
    }

    groups.notDelivered.push(recipient);
  }

  return groups;
}

function getCampaignDeliveryLabel(campaign: Campaign) {
  const groups = buildDeliveryGroups(campaign);
  const total = campaign.recipients?.length || campaign.totalRecipients;

  if (total > 0 && groups.seen.length === total) return `Seen by ${total}`;
  if (groups.seen.length > 0) return `Seen ${groups.seen.length}/${total}`;
  if (groups.delivered.length > 0) return `Delivered ${groups.delivered.length}/${total}`;
  if (groups.underOptation.length > 0) return `Under optation ${groups.underOptation.length}`;
  if (campaign.failedCount > 0) return `${campaign.failedCount} failed`;
  if (campaign.status === 'sending') return `Sending ${campaign.sentCount}/${campaign.totalRecipients}`;
  if (campaign.status === 'completed') return `Sent to ${campaign.sentCount}/${campaign.totalRecipients}`;
  return `Queued for ${campaign.totalRecipients}`;
}

function getCampaignCheckState(campaign: Campaign) {
  const recipients = campaign.recipients || [];
  if (recipients.length === 0) {
    if (campaign.status === 'completed') return 'sent';
    if (campaign.failedCount > 0) return 'failed';
    return 'queued';
  }

  if (recipients.some((recipient) => recipient.status === 'failed')) return 'failed';
  if (recipients.some((recipient) => OPT_IN_WAITING_STATUSES.has(recipient.status) || recipient.status === 'queued')) return 'queued';
  if (recipients.every((recipient) => recipient.status === 'read')) return 'read';
  if (recipients.every((recipient) => recipient.status === 'read' || recipient.status === 'delivered')) return 'delivered';
  if (recipients.every((recipient) => ['sent', 'delivered', 'read'].includes(recipient.status))) return 'sent';
  return 'queued';
}

function isCampaignAfterListClear(campaign: Campaign, contactList: ContactList | null) {
  if (!contactList?.clearedAt) return true;
  return new Date(campaign.createdAt).getTime() > new Date(contactList.clearedAt).getTime();
}

function renderCampaignStatus(campaign: Campaign) {
  const state = getCampaignCheckState(campaign);

  if (state === 'read') return <CheckCheck size={15} className="bubble__status bubble__status--read" />;
  if (state === 'delivered') return <CheckCheck size={15} className="bubble__status" />;
  if (state === 'sent') return <Check size={15} className="bubble__status" />;
  if (state === 'failed') return <AlertCircle size={15} className="bubble__status bubble__status--failed" />;
  return <Clock3 size={15} className="bubble__status bubble__status--queued" />;
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
  const [voiceMode, setVoiceMode] = useState<'idle' | 'recording' | 'review'>('idle');
  const [voiceDurationMs, setVoiceDurationMs] = useState(0);
  const [voiceChunkCount, setVoiceChunkCount] = useState(0);
  const [voiceError, setVoiceError] = useState('');
  const submitLockRef = useRef(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const emojiRef = useRef<HTMLDivElement | null>(null);
  const voiceHoldTimerRef = useRef<number | null>(null);
  const voiceTimerRef = useRef<number | null>(null);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceStartedAtRef = useRef(0);
  const voiceAccumulatedMsRef = useRef(0);

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
      if (!emojiRef.current?.contains(event.target as Node)) {
        setEmojiPickerOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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
    setOptimisticItems([]);
    setCampaigns([]);
    clearVoiceRecording();

    if (!contactList) return;

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
    textareaRef.current?.focus();
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
      setMembersOpen(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to update broadcast members');
    } finally {
      setSavingMembers(false);
    }
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
              </div>
            </div>
          </button>
        </div>
      </header>

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
              <div key={item.key} className="message-row message-row--outbound">
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
                    <button
                      type="button"
                      className="broadcast-info-trigger"
                      onClick={() => void openInfoDrawer(item.campaign)}
                      title="Message info"
                    >
                      <Info size={14} />
                    </button>
                    <span>{formatBubbleTime(item.campaign.createdAt)}</span>
                    {renderCampaignStatus(item.campaign)}
                  </div>
                </div>
              </div>
            );
          }

          return (
            <div key={item.key} className="message-row message-row--outbound">
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

        <div className="composer broadcast-composer">
          <div ref={emojiRef} className="composer__emoji-anchor">
            <button
              type="button"
              className="composer__icon-button"
              title="Emoji"
              onClick={() => {
                setEmojiPickerOpen((current) => !current);
                textareaRef.current?.focus();
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
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
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
                    {renderCampaignStatus(infoCampaign)}
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
        <div className="bottom-sheet__backdrop" onClick={() => setMembersOpen(false)} />
        <section className="bottom-sheet__panel bottom-sheet__panel--wide frosted-panel" role="dialog" aria-modal="true">
          <header className="bottom-sheet__header">
            <div>
              <span className="bottom-sheet__eyebrow">Broadcast list</span>
              <h2>{contactList.name}</h2>
              <p>{hasMemberDetails ? `${optedInMembers.length} opted in, ${notOptedInMembers.length} not opted in` : 'Loading participants'}</p>
            </div>
            <button type="button" className="toolbar-icon-button" onClick={() => setMembersOpen(false)} title="Close">
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
            <button type="button" className="ghost-button" onClick={() => setMembersOpen(false)}>
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
