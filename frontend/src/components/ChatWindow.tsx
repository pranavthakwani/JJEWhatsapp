import {
  Bell,
  BellOff,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Clock3,
  Download,
  FileText,
  Megaphone,
  MoreVertical,
  Paperclip,
  Play,
  Reply,
  Search,
  SendHorizonal,
  Smile,
  X,
} from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { getMediaUrl } from '../lib/api';
import type { Conversation, Message } from '../types';
import type { EmojiClickData } from 'emoji-picker-react';

const EmojiPicker = lazy(() => import('emoji-picker-react'));
const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  onSendOptInTemplate: (templateKind: 'auto' | 'intro' | 'followup') => Promise<void>;
  onToggleMute: () => void;
};

type MediaViewerState = {
  type: 'image' | 'video' | 'audio' | 'document';
  src: string;
  caption: string | null;
  fileName: string | null;
  mimeType: string | null;
};

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '🙏'];

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

function getMediaSource(message: Message) {
  return message.mediaUrl || getMediaUrl(message.id);
}

function isMediaLikeMessage(message: Message) {
  return ['image', 'video', 'audio', 'document'].includes(message.messageType);
}

function getMediaCaption(message: Message) {
  return message.caption || (isMediaLikeMessage(message) ? message.textBody : null) || null;
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
}: {
  message: Message;
  query: string;
  onOpenMedia: (viewer: MediaViewerState) => void;
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
          type: 'image',
          src: getMediaSource(message),
          caption: mediaCaption,
          fileName: message.fileName || 'Image',
          mimeType: message.mimeType || null,
        })}
      >
        <span className={`bubble__media-frame bubble__media-frame--image is-${variant} ${loaded ? 'is-loaded' : 'is-loading'}`}>
          <img
            loading="lazy"
            decoding="async"
            src={getMediaSource(message)}
            alt={mediaCaption || 'Image'}
            onLoad={(event) => {
              setVariant(getPreviewVariant(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight));
              setLoaded(true);
            }}
          />
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
}: {
  message: Message;
  query: string;
  onOpenMedia: (viewer: MediaViewerState) => void;
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
          type: 'video',
          src: getMediaSource(message),
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
            src={getMediaSource(message)}
            onLoadedMetadata={(event) => {
              setVariant(getPreviewVariant(event.currentTarget.videoWidth, event.currentTarget.videoHeight));
              setLoaded(true);
            }}
          />
          <span className="bubble__media-play">
            <Play size={18} />
          </span>
        </span>
      </button>
      {mediaCaption && <p className="bubble__media-caption">{highlightText(mediaCaption, query)}</p>}
    </div>
  );
}

function renderBody(message: Message, query: string, onOpenMedia: (viewer: MediaViewerState) => void) {
  const mediaCaption = getMediaCaption(message);

  if (message.messageType === 'template') {
    return (
      <>
        <div className="bubble__template-tag">Template</div>
        <p>{highlightText(message.templateName || '', query)}</p>
      </>
    );
  }

  if (message.messageType === 'document') {
    return (
      <div className="bubble__media">
        <button
          type="button"
          className="bubble__media-button bubble__media-button--document"
          onClick={() => onOpenMedia({
            type: 'document',
            src: getMediaSource(message),
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
          </div>
        </button>
        {mediaCaption && <p className="bubble__media-caption">{highlightText(mediaCaption, query)}</p>}
      </div>
    );
  }

  if (message.messageType === 'image') {
    return <ImagePreviewBubble message={message} query={query} onOpenMedia={onOpenMedia} />;
  }

  if (message.messageType === 'video') {
    return <VideoPreviewBubble message={message} query={query} onOpenMedia={onOpenMedia} />;
  }

  if (message.messageType === 'audio') {
    return (
      <div className="bubble__media">
        <button
          type="button"
          className="bubble__media-button bubble__media-button--audio"
          onClick={() => onOpenMedia({
            type: 'audio',
            src: getMediaSource(message),
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
  const mediaSource = isMediaLikeMessage(source) ? getMediaSource(source) : null;

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
  onSendOptInTemplate,
  onToggleMute,
}: Props) {
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [replyTarget, setReplyTarget] = useState<Message | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [viewer, setViewer] = useState<MediaViewerState | null>(null);
  const [reactionTargetWaId, setReactionTargetWaId] = useState<string | null>(null);
  const [composerPreviewUrl, setComposerPreviewUrl] = useState<string | null>(null);
  const [jumpHighlightId, setJumpHighlightId] = useState<number | null>(null);
  const [optInSendingKind, setOptInSendingKind] = useState<'intro' | 'followup' | null>(null);
  const [optInError, setOptInError] = useState('');
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
  const isNormalChatLocked = Boolean(conversation && (!isOptedIn || !hasOpenCustomerWindow));
  const hasPendingOptIn = Boolean(conversation && ['pending_initial', 'pending_followup'].includes(conversation.contactOptInStatus));
  const hasSentIntroTemplate = Boolean(
    conversation?.contactLastOptInPromptAt ||
    conversation?.contactLastOptInTemplateName ||
    hasPendingOptIn ||
    isOptedIn,
  );
  const recommendedTemplateKind: 'intro' | 'followup' = hasSentIntroTemplate ? 'followup' : 'intro';
  const recommendedTemplateLabel = recommendedTemplateKind === 'followup' ? 'Send Followup Message' : 'Send Intro Message';
  const lockTitle = isOptedIn ? '24-hour chat window is closed' : hasPendingOptIn ? 'Waiting for customer opt-in' : 'Customer has not opted in';
  const lockDescription = isOptedIn
    ? 'Send a follow-up template first. When the customer replies or taps Yes, normal chat opens again.'
    : hasPendingOptIn
      ? 'Normal messages stay locked until the customer accepts the opt-in request.'
      : recommendedTemplateKind === 'followup'
        ? 'Intro message was already sent. Send the follow-up template to reopen the customer reply flow.'
        : 'Send the intro template so the customer can accept and start normal chat.';

  const visibleMessages = useMemo(
    () => messages.filter((message) => message.messageType !== 'reaction'),
    [messages],
  );

  const lastMessageId = messages[messages.length - 1]?.id;

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
    const next = new Map<string, Array<{ emoji: string; count: number }>>();

    for (const message of messages) {
      if (message.messageType !== 'reaction' || !message.parentWaMessageId || !message.textBody) continue;

      const grouped = next.get(message.parentWaMessageId) || [];
      const existing = grouped.find((item) => item.emoji === message.textBody);
      if (existing) {
        existing.count += 1;
      } else {
        grouped.push({ emoji: message.textBody, count: 1 });
      }
      next.set(message.parentWaMessageId, grouped);
    }

    return next;
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
    setReplyTarget(null);
    setReactionTargetWaId(null);
  }, [conversation?.id]);

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

  function handleEmojiClick(emojiData: EmojiClickData) {
    setDraft((current) => `${current}${emojiData.emoji}`);
    textareaRef.current?.focus();
  }

  async function handleReactionClick(message: Message, emoji: string) {
    setReactionTargetWaId(null);
    try {
      await onSendReaction(message, emoji);
    } catch {
      // non-blocking
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
    if (messagesViewportRef.current.scrollTop <= 120) {
      requestOlderMessages();
    }
  }

  async function handleSendOptInClick() {
    if (optInSendingKind) return;

    setOptInSendingKind(recommendedTemplateKind);
    setOptInError('');
    try {
      await onSendOptInTemplate('auto');
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
      <header className="chat-pane__header">
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
          <button type="button" className="chat-pane__older" onClick={requestOlderMessages}>
            Load older messages
          </button>
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
                className={`bubble ${item.message.direction === 'outbound' ? 'bubble--outbound' : 'bubble--inbound'} ${isMediaLikeMessage(item.message) ? 'bubble--media-message' : ''} ${searchMatches[activeMatchIndex] === item.message.id ? 'bubble--search-active' : ''}`}
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
                      onClick={() => setReactionTargetWaId((current) => current === item.message.waMessageId ? null : item.message.waMessageId)}
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
                  </div>
                )}
                {reactionTargetWaId === item.message.waMessageId && (
                  <div className="bubble__reaction-picker">
                    {QUICK_REACTIONS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        className="bubble__reaction-option"
                        onClick={() => void handleReactionClick(item.message, emoji)}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}
                <div className="bubble__content">{renderBody(item.message, searchQuery, setViewer)}</div>
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
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSubmit();
              }
            }}
          />

          <button type="button" className="composer__send" onClick={() => void handleSubmit()} disabled={sending || isNormalChatLocked}>
            <SendHorizonal size={18} />
          </button>
        </div>
      </footer>

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
