import {
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Clock3,
  Download,
  FileText,
  Forward,
  Megaphone,
  Mic,
  MoreVertical,
  Paperclip,
  Pencil,
  Play,
  Plus,
  Reply,
  Search,
  SendHorizonal,
  Smile,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react';
import { cacheMessageMedia, getCachedMessageMedia, getMediaUrl } from '../lib/api';
import type { Conversation, Message } from '../types';
import type { EmojiClickData } from 'emoji-picker-react';

const EmojiPicker = lazy(() => import('emoji-picker-react'));
const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const COMPOSER_MAX_TEXTAREA_HEIGHT = 176;
const OLDER_MESSAGES_AUTOLOAD_OFFSET_PX = 320;
const VOICE_RECORDER_MIME_TYPES = [
  'audio/ogg;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
];

type Props = {
  theme: 'dark' | 'light';
  conversation: Conversation | null;
  messages: Message[];
  muted: boolean;
  hasOlderMessages: boolean;
  loading: boolean;
  sending: boolean;
  onLoadOlder: () => void;
  onSendText: (text: string, replyToWaMessageId?: string | null) => Promise<void>;
  onSendAttachment: (file: File, caption: string, replyToWaMessageId?: string | null) => Promise<void>;
  onSendReaction: (message: Message, emoji: string) => Promise<void>;
  onToggleStar: (message: Message) => Promise<void>;
  onDeleteMessage: (message: Message) => Promise<void>;
  onForwardMessage: (message: Message) => void;
  onSendOptInTemplate: (templateKind: 'auto' | 'intro' | 'followup') => Promise<void>;
  onRenameContact: (name: string) => Promise<void>;
  onToggleMute: () => void;
  onBack?: () => void;
};

type MediaViewerState = {
  messageId: number;
  type: 'image' | 'video' | 'audio' | 'document';
  src: string;
  caption: string | null;
  fileName: string | null;
  mimeType: string | null;
};

type MediaDownloadState = {
  progress: number | null;
};

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '🙏'];

const REACTION_SHORTCUTS = ['\u{1F44D}', '\u2764\uFE0F', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F64F}'];

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

function normalizeForSearch(message: Message) {
  return [
    message.textBody,
    message.caption,
    message.templateName,
    message.fileName,
  ].filter(Boolean).join(' ').toLowerCase();
}

function renderStatus(status: string, direction: string) {
  if (direction !== 'outbound') return null;
  if (status === 'queued') return <Clock3 size={15} className="bubble__status bubble__status--queued" />;
  if (status === 'read') return <CheckCheck size={15} className="bubble__status bubble__status--read" />;
  if (status === 'delivered') return <CheckCheck size={15} className="bubble__status" />;
  return <Check size={15} className="bubble__status" />;
}

function highlightText(text: string, query: string) {
  if (!query.trim()) return text;

  const normalizedQuery = query.toLowerCase();
  const normalizedText = text.toLowerCase();
  const parts: Array<string | JSX.Element> = [];

  let cursor = 0;
  let matchIndex = normalizedText.indexOf(normalizedQuery, cursor);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }

    const endIndex = matchIndex + query.length;
    parts.push(
      <mark key={`${matchIndex}-${endIndex}`} className="chat-search-highlight">
        {text.slice(matchIndex, endIndex)}
      </mark>,
    );

    cursor = endIndex;
    matchIndex = normalizedText.indexOf(normalizedQuery, cursor);
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return parts;
}

function isPreviewableDocumentTarget(mimeType: string | null, fileName: string | null) {
  const mime = (mimeType || '').toLowerCase();
  const name = (fileName || '').toLowerCase();
  return mime.includes('pdf') || name.endsWith('.pdf');
}

function getMediaSource(message: Message, localMediaUrl?: string | null) {
  return localMediaUrl || message.mediaUrl || getMediaUrl(message.id);
}

function getMediaCacheHydrationKey(message: Message) {
  return `${message.id}:${message.messageType}:${message.mediaId || message.storagePath || message.mediaUrl || ''}`;
}

function isMediaDownloaded(message: Message, localMediaUrl?: string | null) {
  return message.direction !== 'inbound' || Boolean(localMediaUrl || message.mediaUrl || message.storagePath);
}

function formatMediaSize(size?: number | null) {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function isMediaUploading(message: Message) {
  return message.direction === 'outbound' && isMediaLikeMessage(message) && !message.mediaId && message.status === 'queued';
}

function MediaTransferOverlay({
  direction,
  progress,
}: {
  direction: 'download' | 'upload';
  progress: number;
}) {
  return (
    <span
      className={`bubble__transfer-pill bubble__transfer-pill--${direction}`}
      style={{ '--download-progress': `${Math.max(0, Math.min(progress, 1)) * 360}deg` } as CSSProperties}
    >
      {direction === 'upload' ? <Upload size={22} /> : <Download size={18} />}
    </span>
  );
}

function isMediaLikeMessage(message: Message) {
  return ['image', 'video', 'audio', 'document'].includes(message.messageType);
}

function getMediaCaption(message: Message) {
  return message.caption || (isMediaLikeMessage(message) ? message.textBody : null) || null;
}

function isDuplicateMediaTimestampMessage(message: Message, previousMessage: Message | null) {
  if (!previousMessage || !isMediaLikeMessage(previousMessage)) return false;
  if (message.messageType !== 'text' || message.deletedAt) return false;
  if (message.conversationId !== previousMessage.conversationId || message.direction !== previousMessage.direction) return false;

  const text = (message.textBody || message.caption || '').trim().toLowerCase();
  if (!text) return false;

  const previousTime = formatBubbleTime(previousMessage.createdAt).trim().toLowerCase();
  const messageTime = formatBubbleTime(message.createdAt).trim().toLowerCase();
  if (text !== previousTime && text !== messageTime) return false;

  const previousCreatedAt = new Date(previousMessage.createdAt).getTime();
  const messageCreatedAt = new Date(message.createdAt).getTime();
  return Number.isFinite(previousCreatedAt)
    && Number.isFinite(messageCreatedAt)
    && Math.abs(messageCreatedAt - previousCreatedAt) <= 60 * 1000;
}

function getMessagePreviewCopy(message: Message) {
  if (message.messageType === 'reaction') {
    return `${message.textBody || ''} Reacted`;
  }

  if (message.messageType === 'image') return getMediaCaption(message) || '[Image]';
  if (message.messageType === 'video') return getMediaCaption(message) || '[Video]';
  if (message.messageType === 'audio') return getMediaCaption(message) || '[Audio]';
  if (message.messageType === 'document') return getMediaCaption(message) || message.fileName || '[Document]';
  if (message.messageType === 'template') return message.templateName || '[Template]';
  return message.textBody || message.caption || '[Message]';
}

function getPreviewVariant(width: number, height: number) {
  if (!width || !height) return 'square';
  const ratio = width / height;
  if (ratio >= 1.18) return 'landscape';
  if (ratio <= 0.82) return 'portrait';
  return 'square';
}

function ImagePreviewBubble({
  message,
  query,
  onOpenMedia,
  localMediaUrl,
}: {
  message: Message;
  query: string;
  onOpenMedia: (viewer: MediaViewerState) => void;
  localMediaUrl?: string | null;
}) {
  const [loaded, setLoaded] = useState(false);
  const [variant, setVariant] = useState<'portrait' | 'square' | 'landscape'>('landscape');
  const mediaCaption = getMediaCaption(message);

  return (
    <div className="bubble__media">
      <button
        type="button"
        className="bubble__media-button"
        onClick={() => onOpenMedia({
          messageId: message.id,
          type: 'image',
          src: getMediaSource(message, localMediaUrl),
          caption: mediaCaption,
          fileName: message.fileName || 'Image',
          mimeType: message.mimeType || null,
        })}
      >
        <span className={`bubble__media-frame bubble__media-frame--image is-${variant} ${loaded ? 'is-loaded' : 'is-loading'}`}>
          <img
            loading="lazy"
            decoding="async"
            src={getMediaSource(message, localMediaUrl)}
            alt={mediaCaption || 'Image'}
            onLoad={(event) => {
              setVariant(getPreviewVariant(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight));
              setLoaded(true);
            }}
          />
          {isMediaUploading(message) && <MediaTransferOverlay direction="upload" progress={message.uploadProgress ?? 0} />}
        </span>
      </button>
      {mediaCaption && <p className="bubble__media-caption">{highlightText(mediaCaption, query)}</p>}
    </div>
  );
}

function VideoPreviewBubble({
  message,
  query,
  onOpenMedia,
  localMediaUrl,
}: {
  message: Message;
  query: string;
  onOpenMedia: (viewer: MediaViewerState) => void;
  localMediaUrl?: string | null;
}) {
  const [loaded, setLoaded] = useState(false);
  const [variant, setVariant] = useState<'portrait' | 'square' | 'landscape'>('landscape');
  const mediaCaption = getMediaCaption(message);

  return (
    <div className="bubble__media">
      <button
        type="button"
        className="bubble__media-button"
        onClick={() => onOpenMedia({
          messageId: message.id,
          type: 'video',
          src: getMediaSource(message, localMediaUrl),
          caption: mediaCaption,
          fileName: message.fileName || 'Video',
          mimeType: message.mimeType || null,
        })}
      >
        <span className={`bubble__media-frame bubble__media-frame--video is-${variant} ${loaded ? 'is-loaded' : 'is-loading'}`}>
          <video
            muted
            playsInline
            preload="metadata"
            src={getMediaSource(message, localMediaUrl)}
            onLoadedMetadata={(event) => {
              setVariant(getPreviewVariant(event.currentTarget.videoWidth, event.currentTarget.videoHeight));
              setLoaded(true);
            }}
          />
          <span className="bubble__media-play">
            <Play size={18} />
          </span>
          {isMediaUploading(message) && <MediaTransferOverlay direction="upload" progress={message.uploadProgress ?? 0} />}
        </span>
      </button>
      {mediaCaption && <p className="bubble__media-caption">{highlightText(mediaCaption, query)}</p>}
    </div>
  );
}

function MediaDownloadPlaceholder({
  message,
  query,
  downloadState,
  onDownloadMedia,
}: {
  message: Message;
  query: string;
  downloadState?: MediaDownloadState;
  onDownloadMedia: (message: Message) => void;
}) {
  const mediaCaption = getMediaCaption(message);
  const mediaType = isMediaLikeMessage(message) ? message.messageType as MediaViewerState['type'] : 'document';
  const fallbackName = mediaType === 'image' ? 'Image' : mediaType === 'video' ? 'Video' : mediaType === 'audio' ? 'Audio' : 'Document';
  const isDownloading = Boolean(downloadState);
  const progress = downloadState?.progress ?? 0;
  const progressLabel = `${Math.round(progress * 100)}%`;

  return (
    <div className="bubble__media">
      <button
        type="button"
        className={`bubble__download-placeholder bubble__download-placeholder--${mediaType} ${isDownloading ? 'is-downloading' : ''}`}
        onClick={() => onDownloadMedia(message)}
        title={isDownloading ? 'Cancel download' : `Download ${fallbackName.toLowerCase()}`}
      >
        <span className="bubble__download-blur" />
        <span
          className="bubble__download-pill"
          style={isDownloading ? { '--download-progress': `${progress * 360}deg` } as CSSProperties : undefined}
        >
          {isDownloading ? <X size={22} /> : <Download size={18} />}
          {(isDownloading || formatMediaSize(message.mediaSize)) && (
            <span>{isDownloading ? progressLabel : formatMediaSize(message.mediaSize)}</span>
          )}
        </span>
      </button>
      {mediaCaption && <p className="bubble__media-caption">{highlightText(mediaCaption, query)}</p>}
    </div>
  );
}

function renderBody(
  message: Message,
  query: string,
  onOpenMedia: (viewer: MediaViewerState) => void,
  localMediaUrls: Record<number, string>,
  downloadStates: Record<number, MediaDownloadState>,
  onDownloadMedia: (message: Message) => void,
) {
  const mediaCaption = getMediaCaption(message);
  const localMediaUrl = localMediaUrls[message.id] || null;
  const downloadState = downloadStates[message.id];

  if (message.messageType === 'template') {
    return (
      <>
        <div className="bubble__template-tag">Template</div>
        <p>{highlightText(message.templateName || '', query)}</p>
      </>
    );
  }

  if (message.messageType === 'document') {
    if (!isMediaDownloaded(message, localMediaUrl)) {
      return <MediaDownloadPlaceholder message={message} query={query} downloadState={downloadState} onDownloadMedia={onDownloadMedia} />;
    }

    return (
      <div className="bubble__media">
        <button
          type="button"
          className="bubble__media-button bubble__media-button--document"
          onClick={() => onOpenMedia({
            messageId: message.id,
            type: 'document',
            src: getMediaSource(message, localMediaUrl),
            caption: mediaCaption,
            fileName: message.fileName || 'Document',
            mimeType: message.mimeType || null,
          })}
        >
          <div className="bubble__document-card">
            <div className="bubble__document-icon">
              <FileText size={28} />
            </div>
            <div className="bubble__document-copy">
              <strong>{highlightText(message.fileName || 'Document', query)}</strong>
              <span>{message.mimeType || 'Document file'}</span>
            </div>
            <Download size={18} className="bubble__document-action" />
            {isMediaUploading(message) && <MediaTransferOverlay direction="upload" progress={message.uploadProgress ?? 0} />}
          </div>
        </button>
        {mediaCaption && <p className="bubble__media-caption">{highlightText(mediaCaption, query)}</p>}
      </div>
    );
  }

  if (message.messageType === 'image') {
    if (!isMediaDownloaded(message, localMediaUrl)) {
      return <MediaDownloadPlaceholder message={message} query={query} downloadState={downloadState} onDownloadMedia={onDownloadMedia} />;
    }

    return <ImagePreviewBubble message={message} query={query} onOpenMedia={onOpenMedia} localMediaUrl={localMediaUrl} />;
  }

  if (message.messageType === 'video') {
    if (!isMediaDownloaded(message, localMediaUrl)) {
      return <MediaDownloadPlaceholder message={message} query={query} downloadState={downloadState} onDownloadMedia={onDownloadMedia} />;
    }

    return <VideoPreviewBubble message={message} query={query} onOpenMedia={onOpenMedia} localMediaUrl={localMediaUrl} />;
  }

  if (message.messageType === 'audio') {
    if (!isMediaDownloaded(message, localMediaUrl)) {
      return <MediaDownloadPlaceholder message={message} query={query} downloadState={downloadState} onDownloadMedia={onDownloadMedia} />;
    }

    return (
      <div className="bubble__media">
        <button
          type="button"
          className="bubble__media-button bubble__media-button--audio"
          onClick={() => onOpenMedia({
            messageId: message.id,
            type: 'audio',
            src: getMediaSource(message, localMediaUrl),
            caption: mediaCaption,
            fileName: message.fileName || 'Audio',
            mimeType: message.mimeType || 'audio/mpeg',
          })}
        >
          <div className="bubble__audio-card">
            <div className="bubble__audio-icon">
              <Play size={16} />
            </div>
            <div className="bubble__audio-copy">
              <strong>{highlightText(message.fileName || 'Audio', query)}</strong>
              <span>{message.mimeType || 'Audio file'}</span>
            </div>
            <Download size={18} className="bubble__document-action" />
            {isMediaUploading(message) && <MediaTransferOverlay direction="upload" progress={message.uploadProgress ?? 0} />}
          </div>
        </button>
        {mediaCaption && <p className="bubble__media-caption">{highlightText(mediaCaption, query)}</p>}
      </div>
    );
  }

  return <p>{highlightText(message.textBody || message.caption || '', query)}</p>;
}

function renderQuotedSnippet(source: Message | null, query: string, senderLabel: string, onJump: () => void) {
  if (!source) return null;

  const previewCopy = highlightText(getMessagePreviewCopy(source), query);
  const mediaSource = isMediaLikeMessage(source) && isMediaDownloaded(source) ? getMediaSource(source) : null;

  return (
    <button
      type="button"
      className={`bubble__quote bubble__quote--${source.direction} ${mediaSource ? 'bubble__quote--media' : ''}`}
      onClick={onJump}
      title="Jump to quoted message"
    >
      {source.messageType === 'image' && mediaSource && (
        <img className="bubble__quote-thumb" src={mediaSource} alt={getMediaCaption(source) || 'Quoted image'} />
      )}
      {source.messageType === 'video' && mediaSource && (
        <div className="bubble__quote-thumb bubble__quote-thumb--video">
          <video muted playsInline preload="metadata" src={mediaSource} />
          <span className="bubble__quote-thumb-play">
            <Play size={11} />
          </span>
        </div>
      )}
      {source.messageType === 'document' && (
        <div className="bubble__quote-thumb bubble__quote-thumb--icon">
          <FileText size={16} />
        </div>
      )}
      {source.messageType === 'audio' && (
        <div className="bubble__quote-thumb bubble__quote-thumb--icon">
          <Play size={14} />
        </div>
      )}
      <div className="bubble__quote-copy">
        <strong>{senderLabel}</strong>
        <span>{previewCopy}</span>
      </div>
    </button>
  );
}

function MessageSkeleton() {
  return (
    <div className="chat-skeleton-list" aria-label="Loading messages">
      {[0, 1, 2, 3, 4].map((item) => (
        <div key={item} className={`message-row ${item % 2 === 0 ? 'message-row--inbound' : 'message-row--outbound'}`}>
          <div className="bubble skeleton-bubble">
            <span className="skeleton-line skeleton-line--wide" />
            <span className="skeleton-line skeleton-line--short skeleton-line--meta" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChatWindow({
  theme,
  conversation,
  messages,
  muted,
  hasOlderMessages,
  loading,
  sending,
  onLoadOlder,
  onSendText,
  onSendAttachment,
  onSendReaction,
  onToggleStar,
  onDeleteMessage,
  onForwardMessage,
  onSendOptInTemplate,
  onRenameContact,
  onToggleMute,
  onBack,
}: Props) {
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [replyTarget, setReplyTarget] = useState<Message | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [contactEditorOpen, setContactEditorOpen] = useState(false);
  const [contactNameDraft, setContactNameDraft] = useState('');
  const [contactNameSaving, setContactNameSaving] = useState(false);
  const [contactNameError, setContactNameError] = useState('');
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [viewer, setViewer] = useState<MediaViewerState | null>(null);
  const [downloadedMediaUrls, setDownloadedMediaUrls] = useState<Record<number, string>>({});
  const [mediaDownloadStates, setMediaDownloadStates] = useState<Record<number, MediaDownloadState>>({});
  const [mediaDownloadError, setMediaDownloadError] = useState('');
  const [reactionTargetWaId, setReactionTargetWaId] = useState<string | null>(null);
  const [reactionLibraryWaId, setReactionLibraryWaId] = useState<string | null>(null);
  const [composerPreviewUrl, setComposerPreviewUrl] = useState<string | null>(null);
  const [jumpHighlightId, setJumpHighlightId] = useState<number | null>(null);
  const [optInSendingKind, setOptInSendingKind] = useState<'intro' | 'followup' | null>(null);
  const [optInError, setOptInError] = useState('');
  const [actionMessage, setActionMessage] = useState<Message | null>(null);
  const [deleteConfirmMessage, setDeleteConfirmMessage] = useState<Message | null>(null);
  const [voiceMode, setVoiceMode] = useState<'idle' | 'recording' | 'review'>('idle');
  const [voiceDurationMs, setVoiceDurationMs] = useState(0);
  const [voiceChunkCount, setVoiceChunkCount] = useState(0);
  const [voiceError, setVoiceError] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesViewportRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const emojiRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const submitLockRef = useRef(false);
  const pendingOlderScrollRestoreRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const olderLoadRequestRef = useRef(false);
  const jumpHighlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const downloadedMediaUrlsRef = useRef<Record<number, string>>({});
  const mediaCacheHydrationKeysRef = useRef<Set<string>>(new Set());
  const mediaDownloadAbortRefs = useRef<Record<number, AbortController>>({});
  const activeMessageIdsRef = useRef<Set<number>>(new Set());
  const voiceStartedAtRef = useRef(0);
  const voiceAccumulatedMsRef = useRef(0);

  const headerSubtitle = useMemo(() => {
    if (!conversation) return '';
    return conversation.contactPhone || conversation.contactWaId;
  }, [conversation]);
  const lastInboundAtMs = conversation?.contactLastInboundAt
    ? new Date(conversation.contactLastInboundAt).getTime()
    : 0;
  const hasOpenCustomerWindow = Boolean(
    lastInboundAtMs && Number.isFinite(lastInboundAtMs) && Date.now() - lastInboundAtMs < CUSTOMER_SERVICE_WINDOW_MS,
  );
  const isOptedIn = conversation?.contactOptInStatus === 'opted_in';
  const isNormalChatLocked = Boolean(conversation && !hasOpenCustomerWindow);
  const hasPendingOptIn = Boolean(conversation && ['pending_initial', 'pending_followup'].includes(conversation.contactOptInStatus));
  const hasSentIntroTemplate = Boolean(
    conversation?.contactLastOptInPromptAt ||
    conversation?.contactLastOptInTemplateName ||
    hasPendingOptIn ||
    isOptedIn,
  );
  const recommendedTemplateKind: 'intro' | 'followup' = hasSentIntroTemplate ? 'followup' : 'intro';
  const recommendedTemplateLabel = recommendedTemplateKind === 'followup' ? 'Send Followup Message' : 'Send Intro Message';
  const lockTitle = '24-hour chat window is closed';
  const lockDescription = isOptedIn
    ? 'Send a follow-up template first. When the customer replies, normal chat opens again.'
    : hasPendingOptIn
      ? 'The customer has not replied inside the active window. Send the follow-up template to reopen the reply flow.'
      : recommendedTemplateKind === 'followup'
        ? 'Intro message was already sent. Send the follow-up template to reopen the customer reply flow.'
        : 'Send the intro template first. When the customer replies, normal chat opens for 24 hours.';

  const visibleMessages = useMemo(
    () => {
      const nonReactionMessages = messages.filter((message) => message.messageType !== 'reaction');
      return nonReactionMessages.filter((message, index) => !isDuplicateMediaTimestampMessage(
        message,
        index > 0 ? nonReactionMessages[index - 1] : null,
      ));
    },
    [messages],
  );

  const lastMessageId = messages[messages.length - 1]?.id;

  useEffect(() => {
    setContactNameDraft(conversation?.contactName || '');
    setContactNameError('');
    setContactEditorOpen(false);
  }, [conversation?.id, conversation?.contactName]);

  useEffect(() => {
    activeMessageIdsRef.current = new Set(messages.map((message) => message.id));
  }, [messages]);

  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return [];
    return visibleMessages
      .filter((message) => normalizeForSearch(message).includes(searchQuery.trim().toLowerCase()))
      .map((message) => message.id);
  }, [visibleMessages, searchQuery]);

  const messageByWaId = useMemo(
    () => new Map(visibleMessages.filter((message) => message.waMessageId).map((message) => [message.waMessageId as string, message])),
    [visibleMessages],
  );

  const reactionMap = useMemo(() => {
    const latestByActor = new Map<string, Message>();

    for (const message of messages) {
      if (message.deletedAt || message.messageType !== 'reaction' || !message.parentWaMessageId || !message.textBody) continue;

      const actorKey = `${message.parentWaMessageId}:${message.direction}:${message.contactId}`;
      const existing = latestByActor.get(actorKey);
      if (!existing || new Date(message.createdAt).getTime() >= new Date(existing.createdAt).getTime()) {
        latestByActor.set(actorKey, message);
      }
    }

    const next = new Map<string, Array<{ emoji: string; count: number }>>();

    for (const message of latestByActor.values()) {
      if (!message.parentWaMessageId || !message.textBody) continue;
      const grouped = next.get(message.parentWaMessageId) || [];
      const existing = grouped.find((item) => item.emoji === message.textBody);
      if (existing) {
        existing.count += 1;
      } else {
        grouped.push({ emoji: message.textBody, count: 1 });
      }
      next.set(message.parentWaMessageId, grouped.slice(0, 3));
    }

    return next;
  }, [messages]);

  const outboundReactionByMessageId = useMemo(() => {
    const latest = new Map<string, Message>();

    for (const message of messages) {
      if (message.deletedAt || message.messageType !== 'reaction' || message.direction !== 'outbound' || !message.parentWaMessageId) continue;

      const existing = latest.get(message.parentWaMessageId);
      if (!existing || new Date(message.createdAt).getTime() >= new Date(existing.createdAt).getTime()) {
        latest.set(message.parentWaMessageId, message);
      }
    }

    return latest;
  }, [messages]);

  const timeline = useMemo(() => {
    let lastDateLabel = '';

    return visibleMessages.flatMap((message) => {
      const currentDateLabel = formatDateLabel(message.createdAt);
      const items: Array<
        | { type: 'date'; key: string; label: string }
        | { type: 'message'; key: string; message: Message }
      > = [];

      if (currentDateLabel !== lastDateLabel) {
        items.push({
          type: 'date',
          key: `date-${currentDateLabel}-${message.id}`,
          label: currentDateLabel,
        });
        lastDateLabel = currentDateLabel;
      }

      items.push({
        type: 'message',
        key: `message-${message.id}`,
        message,
      });

      return items;
    });
  }, [visibleMessages]);

  function storeDownloadedMediaUrl(messageId: number, objectUrl: string) {
    setDownloadedMediaUrls((current) => {
      if (current[messageId]) {
        URL.revokeObjectURL(objectUrl);
        return current;
      }

      const next = {
        ...current,
        [messageId]: objectUrl,
      };
      downloadedMediaUrlsRef.current = next;
      return next;
    });
  }

  async function loadCachedMediaObjectUrl(message: Message) {
    const existingUrl = downloadedMediaUrlsRef.current[message.id];
    if (existingUrl) return existingUrl;

    const cachedMedia = await getCachedMessageMedia(message);
    if (!cachedMedia) return null;
    if (!activeMessageIdsRef.current.has(message.id)) return null;

    const objectUrl = URL.createObjectURL(cachedMedia.blob);
    const latestUrl = downloadedMediaUrlsRef.current[message.id];
    if (latestUrl) {
      URL.revokeObjectURL(objectUrl);
      return latestUrl;
    }

    storeDownloadedMediaUrl(message.id, objectUrl);
    return objectUrl;
  }

  async function warmMessageMediaCache(message: Message, sourceUrl = getMediaSource(message)) {
    if (!isMediaLikeMessage(message) || message.id < 0 || downloadedMediaUrlsRef.current[message.id]) return;

    const cachedUrl = await loadCachedMediaObjectUrl(message);
    if (cachedUrl) {
      setViewer((current) => (
        current?.messageId === message.id && current.src !== cachedUrl
          ? { ...current, src: cachedUrl }
          : current
      ));
      return;
    }

    try {
      const response = await fetch(sourceUrl, {
        credentials: 'include',
      });
      if (!response.ok) return;

      const blob = await response.blob();
      cacheMessageMedia(message, blob, sourceUrl);
      if (!activeMessageIdsRef.current.has(message.id)) return;

      const objectUrl = URL.createObjectURL(blob);
      storeDownloadedMediaUrl(message.id, objectUrl);
      setViewer((current) => (
        current?.messageId === message.id
          ? { ...current, src: objectUrl }
          : current
      ));
    } catch {
      // Warming the browser cache is opportunistic; visible media can keep using the live URL.
    }
  }

  function handleOpenMedia(nextViewer: MediaViewerState) {
    setViewer(nextViewer);

    const sourceMessage = messages.find((message) => message.id === nextViewer.messageId);
    if (sourceMessage && !downloadedMediaUrlsRef.current[sourceMessage.id]) {
      void warmMessageMediaCache(sourceMessage, nextViewer.src);
    }
  }

  function getSenderLabel(message: Message) {
    if (message.direction === 'outbound') return 'You';
    if (message.direction === 'inbound') {
      return conversation?.contactName || conversation?.contactPhone || conversation?.contactWaId || 'Customer';
    }

    return 'System';
  }

  function jumpToMessage(message: Message) {
    const target = messageRefs.current[message.id];
    if (!target) return;

    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setJumpHighlightId(message.id);

    if (jumpHighlightTimeoutRef.current) {
      clearTimeout(jumpHighlightTimeoutRef.current);
    }

    jumpHighlightTimeoutRef.current = setTimeout(() => {
      setJumpHighlightId(null);
      jumpHighlightTimeoutRef.current = null;
    }, 1800);
  }

  useEffect(() => {
    if (!messagesViewportRef.current) return;

    if (pendingOlderScrollRestoreRef.current) {
      const viewport = messagesViewportRef.current;
      const previous = pendingOlderScrollRestoreRef.current;
      viewport.scrollTop = viewport.scrollHeight - previous.scrollHeight + previous.scrollTop;
      pendingOlderScrollRestoreRef.current = null;
      olderLoadRequestRef.current = false;
      return;
    }

    messagesViewportRef.current.scrollTop = messagesViewportRef.current.scrollHeight;
  }, [conversation?.id, lastMessageId]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (searchMatches.length === 0) {
      setActiveMatchIndex(0);
      return;
    }

    if (activeMatchIndex >= searchMatches.length) {
      setActiveMatchIndex(0);
    }
  }, [searchMatches.length, activeMatchIndex]);

  useEffect(() => {
    if (!searchMatches.length) return;
    const activeMessageId = searchMatches[activeMatchIndex];
    const activeNode = messageRefs.current[activeMessageId];
    activeNode?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeMatchIndex, searchMatches]);

  useEffect(() => () => {
    if (jumpHighlightTimeoutRef.current) {
      clearTimeout(jumpHighlightTimeoutRef.current);
    }
    if (messageLongPressTimerRef.current) {
      clearTimeout(messageLongPressTimerRef.current);
    }
    if (voiceHoldTimerRef.current) {
      clearTimeout(voiceHoldTimerRef.current);
    }
    if (voiceTimerRef.current) {
      clearInterval(voiceTimerRef.current);
    }
    if (voiceRecorderRef.current?.state === 'recording') {
      voiceRecorderRef.current.stop();
    }
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;

      if (menuRef.current && !menuRef.current.contains(target)) {
        setMenuOpen(false);
      }

      if (emojiRef.current && !emojiRef.current.contains(target)) {
        setEmojiPickerOpen(false);
      }

      if (!(target instanceof HTMLElement && target.closest('.bubble'))) {
        setReactionTargetWaId(null);
        setReactionLibraryWaId(null);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setViewer(null);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!loading) {
      olderLoadRequestRef.current = false;
    }
  }, [loading]);

  useEffect(() => {
    if (!file || (!file.type.startsWith('image/') && !file.type.startsWith('video/'))) {
      setComposerPreviewUrl(null);
      return;
    }

    const url = URL.createObjectURL(file);
    setComposerPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    let cancelled = false;
    const mediaMessages = messages
      .filter((message) => isMediaLikeMessage(message) && message.id > 0 && !downloadedMediaUrlsRef.current[message.id])
      .slice(-80);

    for (const message of mediaMessages) {
      const hydrationKey = getMediaCacheHydrationKey(message);
      if (mediaCacheHydrationKeysRef.current.has(hydrationKey)) continue;

      mediaCacheHydrationKeysRef.current.add(hydrationKey);
      void getCachedMessageMedia(message)
        .then((cachedMedia) => {
          if (cancelled || !cachedMedia || downloadedMediaUrlsRef.current[message.id]) return;

          const objectUrl = URL.createObjectURL(cachedMedia.blob);
          storeDownloadedMediaUrl(message.id, objectUrl);
        })
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
    };
  }, [conversation?.id, messages]);

  useEffect(() => {
    resizeComposerTextarea(textareaRef.current);
  }, [draft, file, replyTarget, isNormalChatLocked]);

  useEffect(() => () => {
    Object.values(downloadedMediaUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    Object.values(mediaDownloadAbortRefs.current).forEach((controller) => controller.abort());
  }, []);

  useEffect(() => {
    if (!mediaDownloadError) return undefined;

    const timeout = setTimeout(() => setMediaDownloadError(''), 4200);
    return () => clearTimeout(timeout);
  }, [mediaDownloadError]);

  useEffect(() => {
    Object.values(downloadedMediaUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    Object.values(mediaDownloadAbortRefs.current).forEach((controller) => controller.abort());
    downloadedMediaUrlsRef.current = {};
    mediaDownloadAbortRefs.current = {};
    mediaCacheHydrationKeysRef.current.clear();
    setDownloadedMediaUrls({});
    setMediaDownloadStates({});
    setMediaDownloadError('');
    setViewer(null);
    setReplyTarget(null);
    setReactionTargetWaId(null);
    setReactionLibraryWaId(null);
    setActionMessage(null);
    setDeleteConfirmMessage(null);
  }, [conversation?.id]);

  async function handleMediaDownloadRequest(message: Message) {
    const existingAbort = mediaDownloadAbortRefs.current[message.id];
    if (existingAbort) {
      existingAbort.abort();
      delete mediaDownloadAbortRefs.current[message.id];
      setMediaDownloadStates((current) => {
        const next = { ...current };
        delete next[message.id];
        return next;
      });
      return;
    }

    const cachedUrl = await loadCachedMediaObjectUrl(message);
    if (cachedUrl) return;

    const controller = new AbortController();
    mediaDownloadAbortRefs.current[message.id] = controller;
    setMediaDownloadError('');
    setMediaDownloadStates((current) => ({
      ...current,
      [message.id]: { progress: null },
    }));

    try {
      const response = await fetch(getMediaSource(message), {
        credentials: 'include',
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(errorText || `Download failed with status ${response.status}`);
      }

      const total = Number(response.headers.get('content-length') || message.mediaSize || 0);
      let blob: Blob;

      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          chunks.push(value);
          received += value.byteLength;

          if (total > 0) {
            setMediaDownloadStates((current) => ({
              ...current,
              [message.id]: { progress: Math.min(received / total, 1) },
            }));
          }
        }

        blob = new Blob(chunks, { type: response.headers.get('content-type') || message.mimeType || 'application/octet-stream' });
      } else {
        blob = await response.blob();
      }

      cacheMessageMedia(message, blob, getMediaSource(message));
      const objectUrl = URL.createObjectURL(blob);
      setMediaDownloadStates((current) => ({
        ...current,
        [message.id]: { progress: 1 },
      }));
      storeDownloadedMediaUrl(message.id, objectUrl);
    } catch (error) {
      if ((error as { name?: string })?.name !== 'AbortError') {
        setMediaDownloadError(error instanceof Error ? error.message : 'Download failed.');
      }
    } finally {
      delete mediaDownloadAbortRefs.current[message.id];
      window.setTimeout(() => {
        setMediaDownloadStates((current) => {
          const next = { ...current };
          delete next[message.id];
          return next;
        });
      }, 160);
    }
  }

  function handleDownloadMedia() {
    if (!viewer) return;

    const anchor = document.createElement('a');
    anchor.href = viewer.src;
    anchor.download = viewer.fileName || '';
    anchor.rel = 'noreferrer';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }

  async function handleSubmit() {
    if (submitLockRef.current || sending || isNormalChatLocked) return;

    const outgoingFile = file;
    const outgoingDraft = draft.trim();
    const outgoingReplyTarget = replyTarget;
    if (!outgoingFile && !outgoingDraft) return;

    submitLockRef.current = true;

    if (outgoingFile) {
      setFile(null);
      setDraft('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } else {
      setDraft('');
    }
    setReplyTarget(null);

    try {
      if (outgoingFile) {
        await onSendAttachment(outgoingFile, outgoingDraft, outgoingReplyTarget?.waMessageId || null);
      } else {
        await onSendText(outgoingDraft, outgoingReplyTarget?.waMessageId || null);
      }
    } catch {
      if (outgoingFile) {
        setFile(outgoingFile);
      }
      setDraft(outgoingDraft);
      setReplyTarget(outgoingReplyTarget);
    } finally {
      submitLockRef.current = false;
    }
  }

  function handleToggleSearch() {
    setSearchOpen((current) => {
      const next = !current;
      if (!next) {
        setSearchQuery('');
        setActiveMatchIndex(0);
      }
      return next;
    });
    setMenuOpen(false);
  }

  function handleJumpToLatest() {
    messagesViewportRef.current?.scrollTo({
      top: messagesViewportRef.current.scrollHeight,
      behavior: 'smooth',
    });
    setMenuOpen(false);
  }

  function openContactEditor() {
    setContactNameDraft(conversation?.contactName || '');
    setContactNameError('');
    setContactEditorOpen(true);
    setMenuOpen(false);
  }

  async function handleSaveContactName() {
    const normalizedName = contactNameDraft.replace(/\s+/g, ' ').trim();
    if (!normalizedName || contactNameSaving) return;

    setContactNameSaving(true);
    setContactNameError('');
    try {
      await onRenameContact(normalizedName);
      setContactEditorOpen(false);
    } catch (error) {
      setContactNameError(error instanceof Error ? error.message : 'Could not update contact name');
    } finally {
      setContactNameSaving(false);
    }
  }

  function handleEmojiClick(emojiData: EmojiClickData) {
    setDraft((current) => `${current}${emojiData.emoji}`);
    textareaRef.current?.focus();
  }

  async function handleReactionClick(message: Message, emoji: string) {
    const currentReaction = message.waMessageId ? outboundReactionByMessageId.get(message.waMessageId)?.textBody : null;
    const nextReaction = currentReaction === emoji ? '' : emoji;

    setReactionTargetWaId(null);
    setReactionLibraryWaId(null);
    try {
      await onSendReaction(message, nextReaction);
    } catch {
      // non-blocking
    }
  }

  function handleReactionEmojiClick(message: Message, emojiData: EmojiClickData) {
    void handleReactionClick(message, emojiData.emoji);
  }

  function stopReactionPickerEvent(event: SyntheticEvent) {
    event.stopPropagation();
  }

  function clearMessageLongPressTimer() {
    if (messageLongPressTimerRef.current) {
      clearTimeout(messageLongPressTimerRef.current);
      messageLongPressTimerRef.current = null;
    }
  }

  function handleMessagePressStart(message: Message) {
    clearMessageLongPressTimer();
    messageLongPressTimerRef.current = setTimeout(() => {
      if (message.waMessageId) {
        setReactionTargetWaId(message.waMessageId);
        setReactionLibraryWaId(null);
        setActionMessage(null);
        return;
      }

      setActionMessage(message);
      setReactionTargetWaId(null);
    }, 600);
  }

  function handleMessagePressEnd() {
    clearMessageLongPressTimer();
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
    if (isNormalChatLocked || voiceMode === 'recording') return;

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
      voiceTimerRef.current = setInterval(() => {
        setVoiceDurationMs(voiceAccumulatedMsRef.current + Date.now() - voiceStartedAtRef.current);
      }, 250);
    } catch (error) {
      stopVoiceStream();
      setVoiceError(error instanceof Error ? error.message : 'Could not start recording');
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
    if (isNormalChatLocked || file || draft.trim()) return;

    if (voiceHoldTimerRef.current) {
      clearTimeout(voiceHoldTimerRef.current);
    }

    voiceHoldTimerRef.current = setTimeout(() => {
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

  async function sendVoiceRecording() {
    if (voiceMode === 'recording') {
      pauseVoiceRecordingForReview();
    }

    if (voiceChunksRef.current.length === 0) return;

    const mimeType = voiceChunksRef.current[0]?.type || 'audio/ogg';
    const extension = getAudioExtension(mimeType);
    const voiceFile = new File(
      voiceChunksRef.current,
      `voice-note-${Date.now()}.${extension}`,
      { type: mimeType },
    );
    const voiceReplyTarget = replyTarget;

    clearVoiceRecording();
    setReplyTarget(null);

    try {
      await onSendAttachment(voiceFile, '', voiceReplyTarget?.waMessageId || null);
    } catch {
      setReplyTarget(voiceReplyTarget);
    }
  }

  function handleToggleEmojiPicker() {
    setEmojiPickerOpen((current) => !current);
    textareaRef.current?.focus();
  }

  function requestOlderMessages() {
    if (!messagesViewportRef.current || loading || !hasOlderMessages || olderLoadRequestRef.current) return;

    pendingOlderScrollRestoreRef.current = {
      scrollTop: messagesViewportRef.current.scrollTop,
      scrollHeight: messagesViewportRef.current.scrollHeight,
    };
    olderLoadRequestRef.current = true;
    onLoadOlder();
  }

  function handleMessagesScroll() {
    if (!messagesViewportRef.current) return;
    if (messagesViewportRef.current.scrollTop <= OLDER_MESSAGES_AUTOLOAD_OFFSET_PX) {
      requestOlderMessages();
    }
  }

  async function handleSendOptInClick() {
    if (optInSendingKind) return;

    setOptInSendingKind(recommendedTemplateKind);
    setOptInError('');
    try {
      await onSendOptInTemplate(recommendedTemplateKind);
    } catch (error) {
      setOptInError(error instanceof Error ? error.message : 'Failed to send template');
    } finally {
      setOptInSendingKind(null);
    }
  }

  if (!conversation) {
    return (
      <section className="chat-pane chat-pane--empty">
        <div className="chat-pane__empty-state">
          <div className="chat-pane__empty-logo">J</div>
          <h2>Jay Jalaram Enterprise</h2>
          <p>Select a chat from the left to reply inside the active 24-hour WhatsApp window.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="chat-pane">
      {mediaDownloadError && (
        <div className="chat-toast chat-toast--error" role="alert">
          <strong>Download failed</strong>
          <span>{mediaDownloadError}</span>
        </div>
      )}

      <header className="chat-pane__header">
        <button type="button" className="mobile-back-button" onClick={onBack} title="Back to chats">
          <ArrowLeft size={22} />
        </button>
        <div className="chat-pane__contact">
          <div className="chat-pane__avatar">
            {conversation.contactName.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <strong>{conversation.contactName}</strong>
            <div className="chat-pane__subtitle-row">
              <div className="chat-pane__subtitle">{headerSubtitle}</div>
              {muted && (
                <span className="chat-pane__mute-indicator" title="Muted">
                  <BellOff size={14} />
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="chat-pane__header-actions">
          <button type="button" className="toolbar-icon-button" title="Search in chat" onClick={handleToggleSearch}>
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
                <button type="button" onClick={openContactEditor}>
                  <Pencil size={16} />
                  <span>Edit contact name</span>
                </button>
                <button type="button" onClick={() => { onToggleMute(); setMenuOpen(false); }}>
                  {muted ? <Bell size={16} /> : <BellOff size={16} />}
                  <span>{muted ? 'Unmute conversation' : 'Mute conversation'}</span>
                </button>
                <button type="button" onClick={handleToggleSearch}>
                  <Search size={16} />
                  <span>Search in chat</span>
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
            placeholder="Search in chat"
          />
          <span className="chat-pane__searchbar-count">
            {searchMatches.length === 0 ? '0' : `${activeMatchIndex + 1}/${searchMatches.length}`}
          </span>
          <button
            type="button"
            className="toolbar-icon-button"
            onClick={() => setActiveMatchIndex((current) => (current <= 0 ? searchMatches.length - 1 : current - 1))}
            disabled={searchMatches.length === 0}
            title="Previous result"
          >
            <ChevronUp size={16} />
          </button>
          <button
            type="button"
            className="toolbar-icon-button"
            onClick={() => setActiveMatchIndex((current) => (current + 1) % searchMatches.length)}
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

      {isNormalChatLocked && (
        <div className="chat-optin-banner frosted-card">
          <div className="chat-optin-banner__copy">
            <strong>{lockTitle}</strong>
            <span>{lockDescription}</span>
            {optInError && <small>{optInError}</small>}
          </div>
          <div className="chat-optin-banner__actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => void handleSendOptInClick()}
              disabled={Boolean(optInSendingKind)}
            >
              {optInSendingKind ? 'Sending...' : recommendedTemplateLabel}
            </button>
          </div>
        </div>
      )}

      <div ref={messagesViewportRef} className="chat-pane__messages" onScroll={handleMessagesScroll}>
        {hasOlderMessages && (
          <div className="chat-pane__older-sentinel" aria-hidden="true" />
        )}
        {loading && visibleMessages.length > 0 && (
          <div className="chat-pane__older-status" aria-label="Loading older messages">
            <span />
          </div>
        )}

        {loading && visibleMessages.length === 0 && <MessageSkeleton />}

        {timeline.map((item) => (
          item.type === 'date' ? (
            <div key={item.key} className="chat-date-divider">
              <span>{item.label}</span>
            </div>
          ) : (
            <div
              key={item.key}
              ref={(node) => {
                messageRefs.current[item.message.id] = node;
              }}
              className={`message-row message-row--${item.message.direction} ${jumpHighlightId === item.message.id ? 'message-row--jump-active' : ''}`}
            >
              <div
                className={`bubble ${item.message.direction === 'outbound' ? 'bubble--outbound' : 'bubble--inbound'} ${isMediaLikeMessage(item.message) ? 'bubble--media-message' : ''} ${['image', 'video'].includes(item.message.messageType) ? 'bubble--visual-media' : ''} ${isMediaLikeMessage(item.message) && getMediaCaption(item.message) ? 'bubble--has-media-caption' : ''} ${item.message.waMessageId && reactionMap.get(item.message.waMessageId)?.length ? 'bubble--has-reactions' : ''} ${searchMatches[activeMatchIndex] === item.message.id ? 'bubble--search-active' : ''}`}
                onPointerDown={(event) => {
                  if ((event.target as HTMLElement).closest('button, a, input, textarea')) return;
                  handleMessagePressStart(item.message);
                }}
                onPointerUp={handleMessagePressEnd}
                onPointerCancel={handleMessagePressEnd}
                onPointerLeave={handleMessagePressEnd}
                onDoubleClick={() => {
                  if (item.message.waMessageId) {
                    setReactionTargetWaId(item.message.waMessageId);
                    setReactionLibraryWaId(null);
                  }
                }}
              >
                {item.message.parentWaMessageId && (() => {
                  const quotedMessage = messageByWaId.get(item.message.parentWaMessageId) || null;
                  return renderQuotedSnippet(
                    quotedMessage,
                    searchQuery,
                    quotedMessage ? getSenderLabel(quotedMessage) : 'Quoted message',
                    () => {
                      if (quotedMessage) jumpToMessage(quotedMessage);
                    },
                  );
                })()}
                {item.message.waMessageId && (
                  <div className="bubble__quick-actions">
                    <button
                      type="button"
                      className="bubble__action-button"
                      title="React"
                      onClick={() => {
                        setReactionLibraryWaId(null);
                        setReactionTargetWaId((current) => current === item.message.waMessageId ? null : item.message.waMessageId);
                      }}
                    >
                      <Smile size={14} />
                    </button>
                    <button
                      type="button"
                      className="bubble__action-button"
                      title="Reply"
                      onClick={() => {
                        setReplyTarget(item.message);
                        textareaRef.current?.focus();
                      }}
                    >
                      <Reply size={14} />
                    </button>
                    <button
                      type="button"
                      className="bubble__action-button"
                      title={item.message.starredAt ? 'Unstar' : 'Star'}
                      onClick={() => void onToggleStar(item.message)}
                    >
                      <Star size={14} className={item.message.starredAt ? 'is-starred' : ''} />
                    </button>
                    <button
                      type="button"
                      className="bubble__action-button"
                      title="Forward"
                      onClick={() => onForwardMessage(item.message)}
                    >
                      <Forward size={14} />
                    </button>
                  </div>
                )}
                {reactionTargetWaId === item.message.waMessageId && (
                  <div
                    className={`bubble__reaction-picker ${reactionLibraryWaId === item.message.waMessageId ? 'is-expanded' : ''}`}
                    onPointerDown={stopReactionPickerEvent}
                    onMouseDown={stopReactionPickerEvent}
                    onClick={stopReactionPickerEvent}
                  >
                    <div className="bubble__reaction-row">
                      {REACTION_SHORTCUTS.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          className="bubble__reaction-option"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleReactionClick(item.message, emoji);
                          }}
                        >
                          {emoji}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="bubble__reaction-option bubble__reaction-option--icon"
                        title="More reactions"
                        onClick={(event) => {
                          event.stopPropagation();
                          setReactionLibraryWaId((current) => (
                            current === item.message.waMessageId ? null : item.message.waMessageId
                          ));
                        }}
                      >
                        <Plus size={17} />
                      </button>
                    </div>
                    {reactionLibraryWaId === item.message.waMessageId && (
                      <div
                        className="bubble__reaction-library"
                        onPointerDown={stopReactionPickerEvent}
                        onMouseDown={stopReactionPickerEvent}
                        onClick={stopReactionPickerEvent}
                      >
                        <Suspense fallback={<div className="emoji-picker-loading"><span className="skeleton-line skeleton-line--wide" /></div>}>
                          <EmojiPicker
                            open
                            onEmojiClick={(emojiData) => handleReactionEmojiClick(item.message, emojiData)}
                            theme={theme}
                            emojiStyle="native"
                            lazyLoadEmojis
                            width={320}
                            height={360}
                            autoFocusSearch={false}
                            searchPlaceholder="Search reaction"
                            previewConfig={{ showPreview: false }}
                          />
                        </Suspense>
                      </div>
                    )}
                  </div>
                )}
                <div className="bubble__content">{renderBody(item.message, searchQuery, handleOpenMedia, downloadedMediaUrls, mediaDownloadStates, handleMediaDownloadRequest)}</div>
                {item.message.waMessageId && reactionMap.get(item.message.waMessageId)?.length ? (
                  <div className="bubble__reactions">
                    {reactionMap.get(item.message.waMessageId)!.map((reaction) => (
                      <span key={`${item.message.waMessageId}-${reaction.emoji}`} className="bubble__reaction-pill">
                        {reaction.emoji}
                        {reaction.count > 1 ? <small>{reaction.count}</small> : null}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="bubble__meta">
                  {item.message.starredAt && (
                    <Star size={11} className="bubble__star-icon" aria-label="Starred message" />
                  )}
                  {item.message.campaignId && (
                    <Megaphone size={12} className="bubble__broadcast-icon" aria-label="Broadcast message" />
                  )}
                  <span>{formatBubbleTime(item.message.createdAt)}</span>
                  {renderStatus(item.message.status, item.message.direction)}
                </div>
              </div>
            </div>
          )
        ))}
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
              <span>{file.type.startsWith('image/') ? 'Image preview' : file.type.startsWith('video/') ? 'Video preview' : file.type || 'Attachment'}</span>
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

        {replyTarget && (
          <div className="composer__reply-chip">
            <div className="composer__reply-copy">
              <strong>{replyTarget.direction === 'outbound' ? 'Replying to yourself' : `Replying to ${conversation.contactName}`}</strong>
              <span>{getMessagePreviewCopy(replyTarget)}</span>
            </div>
            <button type="button" onClick={() => setReplyTarget(null)}>
              <X size={14} />
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
              disabled={voiceChunkCount === 0}
            >
              Send
            </button>
          </div>
        )}

        <div className="composer">
          <div ref={emojiRef} className="composer__emoji-anchor">
            <button
              type="button"
              className="composer__icon-button"
              title="Emoji"
              onClick={handleToggleEmojiPicker}
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
              disabled={isNormalChatLocked}
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
          </label>

          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            placeholder={isNormalChatLocked ? 'Send a template message first' : file ? 'Add caption' : 'Type a message'}
            disabled={isNormalChatLocked}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && shouldSubmitOnEnter()) {
                event.preventDefault();
                void handleSubmit();
              }
            }}
          />

          {draft.trim() || file ? (
            <button type="button" className="composer__send" onClick={() => void handleSubmit()} disabled={sending || isNormalChatLocked}>
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
              disabled={sending || isNormalChatLocked}
              title={voiceMode === 'review' ? 'Hold to continue recording' : 'Hold to record voice note'}
            >
              <Mic size={18} />
            </button>
          )}
        </div>
      </footer>

      <div className={`dialog-layer message-action-layer ${actionMessage ? 'is-open' : ''}`} aria-hidden={!actionMessage}>
        <div
          className="dialog-layer__backdrop"
          onClick={() => {
            setDeleteConfirmMessage(null);
            setActionMessage(null);
          }}
        />
        <section className="message-action-sheet frosted-panel" role="dialog" aria-modal="true">
          <header className="message-action-sheet__header">
            <div>
              <span className="bottom-sheet__eyebrow">Message</span>
              <h2>{deleteConfirmMessage ? 'Delete message?' : actionMessage ? getMessagePreviewCopy(actionMessage) : ''}</h2>
            </div>
            <button
              type="button"
              className="toolbar-icon-button"
              onClick={() => {
                setDeleteConfirmMessage(null);
                setActionMessage(null);
              }}
              title="Close"
            >
              <X size={18} />
            </button>
          </header>

          {actionMessage && deleteConfirmMessage && (
            <>
              <div className="message-action-sheet__warning">
                This removes the message from this app only. WhatsApp Cloud API cannot delete an already-sent message from the customer phone.
              </div>
              <div className="chat-action-sheet__confirm">
                <button type="button" className="ghost-button" onClick={() => setDeleteConfirmMessage(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => {
                    void onDeleteMessage(deleteConfirmMessage);
                    setDeleteConfirmMessage(null);
                    setActionMessage(null);
                  }}
                >
                  Delete
                </button>
              </div>
            </>
          )}

          {actionMessage && !deleteConfirmMessage && (
            <div className="message-action-sheet__actions">
              {actionMessage.waMessageId && (
                <button
                  type="button"
                  onClick={() => {
                    setReplyTarget(actionMessage);
                    setActionMessage(null);
                    textareaRef.current?.focus();
                  }}
                >
                  <Reply size={18} />
                  <span>Reply</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  onForwardMessage(actionMessage);
                  setActionMessage(null);
                }}
              >
                <Forward size={18} />
                <span>Forward</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  void onToggleStar(actionMessage);
                  setActionMessage(null);
                }}
              >
                <Star size={18} className={actionMessage.starredAt ? 'is-starred' : ''} />
                <span>{actionMessage.starredAt ? 'Unstar message' : 'Star message'}</span>
              </button>
              <button
                type="button"
                className="is-danger"
                onClick={() => setDeleteConfirmMessage(actionMessage)}
              >
                <Trash2 size={18} />
                <span>Delete message</span>
              </button>
            </div>
          )}
        </section>
      </div>

      <div className={`bottom-sheet ${contactEditorOpen ? 'is-open' : ''}`} aria-hidden={!contactEditorOpen}>
        <div className="bottom-sheet__backdrop" onClick={() => setContactEditorOpen(false)} />
        <section className="bottom-sheet__panel bottom-sheet__panel--compact frosted-panel" role="dialog" aria-modal="true">
          <header className="bottom-sheet__header">
            <div>
              <span className="bottom-sheet__eyebrow">Contact</span>
              <h2>Edit contact name</h2>
            </div>
            <button type="button" className="toolbar-icon-button" onClick={() => setContactEditorOpen(false)} title="Close">
              <X size={18} />
            </button>
          </header>
          <div className="bottom-sheet__body name-editor-body">
            <label>
              <span>Name</span>
              <input
                value={contactNameDraft}
                onChange={(event) => setContactNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleSaveContactName();
                  }
                }}
                autoFocus
                maxLength={160}
              />
            </label>
            {contactNameError && <div className="inline-error">{contactNameError}</div>}
          </div>
          <footer className="bottom-sheet__footer">
            <button type="button" className="ghost-button" onClick={() => setContactEditorOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!contactNameDraft.trim() || contactNameSaving}
              onClick={() => void handleSaveContactName()}
            >
              {contactNameSaving ? 'Saving...' : 'Save'}
            </button>
          </footer>
        </section>
      </div>

      {viewer && (
        <div className="media-viewer" role="dialog" aria-modal="true">
          <div className="media-viewer__backdrop" onClick={() => setViewer(null)} />
          <div className="media-viewer__shell">
            <header className="media-viewer__header">
              <div className="media-viewer__copy">
                <strong>{viewer.fileName || (viewer.type === 'image' ? 'Image' : viewer.type === 'video' ? 'Video' : viewer.type === 'audio' ? 'Audio' : 'Document')}</strong>
                {viewer.caption && <span>{viewer.caption}</span>}
              </div>
              <div className="media-viewer__actions">
                <button
                  type="button"
                  className="toolbar-icon-button media-viewer__download"
                  title="Download"
                  onClick={handleDownloadMedia}
                >
                  <Download size={18} />
                </button>
                <button type="button" className="toolbar-icon-button" title="Close" onClick={() => setViewer(null)}>
                  <X size={18} />
                </button>
              </div>
            </header>

            <div className="media-viewer__body">
              {viewer.type === 'image' && (
                <img className="media-viewer__image" src={viewer.src} alt={viewer.caption || viewer.fileName || 'Image'} />
              )}

              {viewer.type === 'video' && (
                <video className="media-viewer__video" controls autoPlay src={viewer.src} />
              )}

              {viewer.type === 'audio' && (
                <div className="media-viewer__document-card media-viewer__audio-card">
                  <Play size={56} />
                  <strong>{viewer.fileName || 'Audio'}</strong>
                  <span>{viewer.mimeType || 'Audio file'}</span>
                  {viewer.caption && <p>{viewer.caption}</p>}
                  <audio className="media-viewer__audio-player" controls autoPlay src={viewer.src} />
                </div>
              )}

              {viewer.type === 'document' && isPreviewableDocumentTarget(viewer.mimeType, viewer.fileName) && (
                <iframe className="media-viewer__document-frame" src={viewer.src} title={viewer.fileName || 'Document'} />
              )}

              {viewer.type === 'document' && !isPreviewableDocumentTarget(viewer.mimeType, viewer.fileName) && (
                <div className="media-viewer__document-card">
                  <FileText size={56} />
                  <strong>{viewer.fileName || 'Document'}</strong>
                  <span>{viewer.mimeType || 'Document file'}</span>
                  {viewer.caption && <p>{viewer.caption}</p>}
                  <a href={viewer.src} target="_blank" rel="noreferrer">
                    Open document
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
