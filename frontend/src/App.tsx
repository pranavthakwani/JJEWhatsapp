import { Check, Forward, Star, X } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { CampaignComposer } from './components/CampaignComposer';
import { ChatWindow } from './components/ChatWindow';
import { ConversationList } from './components/ConversationList';
import { BroadcastWorkspace } from './components/BroadcastWorkspace';
import { AuthLoadingScreen, PendingDeviceScreen } from './components/AuthScreens';
import { AddContactDialog, StartChatDialog } from './components/ContactDialogs';
import { DeviceManagerDialog } from './components/DeviceManagerDialog';
import {
  cacheMessageMedia,
  cacheMessageSnapshot,
  clearContactList,
  clearCachedConversationData,
  clearCachedMessageMedia,
  clearConversation,
  createCampaign,
  deleteContactList,
  deleteConversation,
  deleteMessage,
  getBootstrap,
  getAuthStatus,
  getCachedBootstrap,
  getCachedConversations,
  getCachedMessages,
  getContactList,
  getContactLists,
  getConversations,
  getMessages,
  getStarredMessages,
  listAuthDevices,
  logout as logoutAuth,
  markConversationRead,
  renameContact,
  sendConversationOptInTemplate,
  sendConversationMessage,
  starMessage,
  startConversation,
  unstarMessage,
  updateAuthDevice,
  uploadMedia,
} from './lib/api';
import { socket } from './lib/socket';
import type { AuthDevice, AuthStatus, BootstrapPayload, Campaign, Contact, ContactList, Conversation, Message, StarredMessage } from './types';

type BroadcastSendPayload = {
  bodyText: string;
  file?: File | null;
};

const LOCAL_MEDIA_LABELS: Record<string, string> = {
  image: '[Image]',
  document: '[Document]',
  video: '[Video]',
  audio: '[Audio]',
};

function upsertConversation(items: Conversation[], incoming: Conversation) {
  const next = [incoming, ...items.filter((item) => item.id !== incoming.id)];
  return next.sort((a, b) => {
    const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bTime - aTime;
  });
}

function upsertContactList(items: ContactList[], incoming: ContactList) {
  const next = [incoming, ...items.filter((item) => item.id !== incoming.id)];
  return next.sort((a, b) => {
    const aTime = new Date(a.updatedAt || a.createdAt).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt).getTime();
    return bTime - aTime;
  });
}

function resolveInitialTheme() {
  if (typeof window === 'undefined') return 'dark';
  const saved = window.localStorage.getItem('jjewa-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveMutedConversationIds() {
  if (typeof window === 'undefined') return [] as number[];

  try {
    const saved = window.localStorage.getItem('jjewa-muted-conversations');
    if (!saved) return [] as number[];

    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed.filter((value) => Number.isInteger(value)) : [];
  } catch {
    return [] as number[];
  }
}

function buildOptimisticPreview(messageType: string, textBody?: string | null, caption?: string | null) {
  const text = textBody?.trim() || caption?.trim();
  if (text) return text.slice(0, 240);
  return LOCAL_MEDIA_LABELS[messageType] || '[Message]';
}

function getMessageForwardText(message: Message) {
  return message.textBody || message.caption || message.templateName || message.fileName || LOCAL_MEDIA_LABELS[message.messageType] || '[Message]';
}

function getMessageListPreview(message: Message) {
  const text = message.textBody || message.caption || message.templateName || message.fileName;
  if (text) return text;
  return LOCAL_MEDIA_LABELS[message.messageType] || '[Message]';
}

function formatCompactDateTime(value: string | null) {
  if (!value) return '';
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).toLowerCase();
}

const MESSAGE_STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

function resolveIsMobileLayout() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(max-width: 720px)').matches;
}

function isKeyboardFocusTarget(element: Element | null) {
  return element instanceof HTMLElement
    && (
      element.tagName === 'TEXTAREA'
      || element.tagName === 'INPUT'
      || element.isContentEditable
    );
}

function resolveViewportShellHeight() {
  if (typeof window === 'undefined') return 0;

  const innerHeight = window.innerHeight || 0;
  const visualViewportHeight = window.visualViewport?.height || 0;
  const keyboardLikelyOpen = isKeyboardFocusTarget(document.activeElement)
    && visualViewportHeight > 0
    && innerHeight > 0
    && visualViewportHeight < innerHeight - 120;

  if (keyboardLikelyOpen) {
    return visualViewportHeight;
  }

  return innerHeight || visualViewportHeight;
}

function resetMobileViewportShell() {
  if (typeof window === 'undefined') return;

  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && activeElement !== document.body) {
    activeElement.blur();
  }

  const applyViewport = () => {
    const height = resolveViewportShellHeight();
    document.documentElement.style.setProperty('--jjewa-viewport-height', `${height}px`);
    document.documentElement.style.setProperty('--jjewa-viewport-offset-top', '0px');
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  };

  applyViewport();
  window.requestAnimationFrame(applyViewport);
  window.setTimeout(applyViewport, 120);
}

function mergeMessageUpdate(existing: Message, incoming: Message) {
  const existingRank = MESSAGE_STATUS_RANK[existing.status] ?? -1;
  const incomingRank = MESSAGE_STATUS_RANK[incoming.status] ?? -1;

  if (existing.status !== 'failed' && incoming.status !== 'failed' && existingRank > incomingRank) {
    return {
      ...incoming,
      status: existing.status,
      sentAt: existing.sentAt || incoming.sentAt,
      deliveredAt: existing.deliveredAt || incoming.deliveredAt,
      readAt: existing.readAt || incoming.readAt,
    };
  }

  return incoming;
}

function sortMessages(items: Message[]) {
  return [...items].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

function removeReplacedReaction(items: Message[], parentWaMessageId: string | null, direction: Message['direction'], keepId?: number) {
  if (!parentWaMessageId) return items;

  return items.filter((item) => !(
    item.id !== keepId
    && item.messageType === 'reaction'
    && item.parentWaMessageId === parentWaMessageId
    && item.direction === direction
  ));
}

function isMessageAfterConversationClear(message: Message, conversation: Conversation | null) {
  if (!conversation?.clearedAt) return true;
  return new Date(message.createdAt).getTime() > new Date(conversation.clearedAt).getTime();
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(resolveInitialTheme);
  const [themeTransitioning, setThemeTransitioning] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [deviceManagerOpen, setDeviceManagerOpen] = useState(false);
  const [devices, setDevices] = useState<AuthDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState('');
  const [mutedConversationIds, setMutedConversationIds] = useState<number[]>(resolveMutedConversationIds);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [numbers, setNumbers] = useState<BootstrapPayload['businessNumbers']>([]);
  const [selectedPhoneNumberId, setSelectedPhoneNumberId] = useState<number | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [contactLists, setContactLists] = useState<ContactList[]>([]);
  const [conversationCursor, setConversationCursor] = useState<string | null>(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [activeContactListId, setActiveContactListId] = useState<number | null>(null);
  const [activeContactList, setActiveContactList] = useState<ContactList | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [messageLoading, setMessageLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [startChatOpen, setStartChatOpen] = useState(false);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [starredOpen, setStarredOpen] = useState(false);
  const [starredMessages, setStarredMessages] = useState<StarredMessage[]>([]);
  const [starredLoading, setStarredLoading] = useState(false);
  const [forwardTarget, setForwardTarget] = useState<Message | null>(null);
  const [forwardSelectedIds, setForwardSelectedIds] = useState<number[]>([]);
  const [forwarding, setForwarding] = useState(false);
  const [forwardError, setForwardError] = useState('');
  const [isMobileLayout, setIsMobileLayout] = useState(resolveIsMobileLayout);
  const deferredSearch = useDeferredValue(search);
  const optimisticMessageIdRef = useRef(-1);
  const readInFlightRef = useRef<number | null>(null);
  const themeTransitionTimeoutRef = useRef<number | null>(null);
  const authStatusPromiseRef = useRef<Promise<AuthStatus | null> | null>(null);
  const messageLoadRequestRef = useRef(0);
  const isChatOpen = Boolean(activeConversation || activeContactListId);
  const canUseApp = authStatus?.canUseApp === true;

  function clearUnreadLocally(conversationId: number) {
    setConversations((current) => current.map((conversation) => (
      conversation.id === conversationId
        ? { ...conversation, unreadCount: 0 }
        : conversation
    )));
    setActiveConversation((current) => (
      current?.id === conversationId
        ? { ...current, unreadCount: 0 }
        : current
    ));
  }

  async function markConversationReadSmart(conversationId: number) {
    clearUnreadLocally(conversationId);
    if (readInFlightRef.current === conversationId) return;
    readInFlightRef.current = conversationId;
    try {
      await markConversationRead(conversationId);
    } finally {
      if (readInFlightRef.current === conversationId) {
        readInFlightRef.current = null;
      }
    }
  }

  function resetRuntimeState() {
    setBootstrapped(false);
    setNumbers([]);
    setSelectedPhoneNumberId(null);
    setConversations([]);
    setContactLists([]);
    setConversationCursor(null);
    setConversationLoading(false);
    setSearch('');
    setActiveConversation(null);
    setActiveContactListId(null);
    setActiveContactList(null);
    setMessages([]);
    setMessageCursor(null);
    setMessageLoading(false);
    setCampaignOpen(false);
    setStartChatOpen(false);
    setAddContactOpen(false);
    setStarredOpen(false);
    setStarredMessages([]);
    setForwardTarget(null);
    setForwardSelectedIds([]);
  }

  async function refreshAuthStatus(showLoading = true) {
    if (authStatusPromiseRef.current) return authStatusPromiseRef.current;

    if (showLoading) setAuthLoading(true);
    setAuthError('');

    const statusPromise = (async () => {
      try {
        const status = await getAuthStatus();
        setAuthStatus(status);
        if (!status.canUseApp) {
          socket.disconnect();
          resetRuntimeState();
        }
        return status;
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : 'Unable to check device status.');
        setAuthStatus(null);
        socket.disconnect();
        resetRuntimeState();
        return null;
      } finally {
        authStatusPromiseRef.current = null;
        setAuthLoading(false);
      }
    })();

    authStatusPromiseRef.current = statusPromise;
    return statusPromise;
  }

  async function handleResetDevice() {
    try {
      await logoutAuth();
    } finally {
      socket.disconnect();
      resetRuntimeState();
      setAuthStatus(null);
      setDeviceManagerOpen(false);
      void refreshAuthStatus();
    }
  }

  async function loadDevices() {
    setDevicesLoading(true);
    setDevicesError('');

    try {
      setDevices(await listAuthDevices());
    } catch (error) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setDevicesError(message || (error instanceof Error ? error.message : 'Unable to load devices.'));
    } finally {
      setDevicesLoading(false);
    }
  }

  async function handleUpdateDeviceStatus(deviceId: number, status: 'pending' | 'approved' | 'blocked') {
    setDevicesError('');
    try {
      const updatedDevice = await updateAuthDevice(deviceId, { status });
      setDevices((current) => current.map((device) => (device.id === deviceId ? updatedDevice : device)));
      if (updatedDevice.isCurrent) {
        void refreshAuthStatus(false);
      }
    } catch (error) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setDevicesError(message || (error instanceof Error ? error.message : 'Unable to update device.'));
    }
  }

  function applyBootstrap(data: BootstrapPayload) {
    setNumbers(data.businessNumbers);
    setSelectedPhoneNumberId((current) => current ?? data.defaultPhoneNumberId);
    setBootstrapped(true);
  }

  async function loadBootstrap() {
    const data = await getBootstrap();
    applyBootstrap(data);
  }

  function toggleTheme() {
    if (themeTransitionTimeoutRef.current) {
      window.clearTimeout(themeTransitionTimeoutRef.current);
    }

    setThemeTransitioning(false);
    window.requestAnimationFrame(() => {
      setThemeTransitioning(true);
      setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
      themeTransitionTimeoutRef.current = window.setTimeout(() => {
        setThemeTransitioning(false);
        themeTransitionTimeoutRef.current = null;
      }, 640);
    });
  }

  async function loadConversations(reset = true) {
    if (!selectedPhoneNumberId) return;
    const params = {
      phoneNumberId: selectedPhoneNumberId,
      search: deferredSearch,
      cursor: reset ? null : conversationCursor,
      limit: 20,
    };

    let showedCached = false;
    if (reset) {
      const cachedPayload = getCachedConversations(params);
      if (cachedPayload) {
        showedCached = true;
        setConversations(cachedPayload.items);
        setConversationCursor(cachedPayload.nextCursor);

        if (activeContactListId) {
          setActiveConversation(null);
        } else if (cachedPayload.items.length === 0) {
          setActiveConversation(null);
        } else {
          setActiveConversation((current) => current && current.phoneNumberId === selectedPhoneNumberId
            ? cachedPayload.items.find((item) => item.id === current.id) || cachedPayload.items[0]
            : isMobileLayout ? null : cachedPayload.items[0]);
        }
      }
    }

    setConversationLoading(!showedCached);

    try {
      const payload = await getConversations(params);

      setConversations((current) => (reset ? payload.items : [...current, ...payload.items]));
      setConversationCursor(payload.nextCursor);

      if (reset) {
        if (activeContactListId) {
          setActiveConversation(null);
        } else if (payload.items.length === 0) {
          setActiveConversation(null);
        } else {
          setActiveConversation((current) => current && current.phoneNumberId === selectedPhoneNumberId
            ? payload.items.find((item) => item.id === current.id) || payload.items[0]
            : isMobileLayout ? null : payload.items[0]);
        }
      }
    } finally {
      setConversationLoading(false);
    }
  }

  async function loadContactLists(phoneNumberId: number, preferredListId?: number | null) {
    const lists = await getContactLists(phoneNumberId);
    setContactLists(lists);

    if (!preferredListId) return;

    setActiveConversation(null);
    setActiveContactListId(preferredListId);
    const selected = await getContactList(preferredListId);
    setActiveContactList(selected);
  }

  async function loadMessages(conversationId: number, reset = true) {
    const requestId = ++messageLoadRequestRef.current;
    let showedCached = false;
    if (reset) {
      setMessages([]);
      setMessageCursor(null);

      const cachedPayload = await getCachedMessages(conversationId);
      if (messageLoadRequestRef.current !== requestId) return;

      if (cachedPayload) {
        showedCached = true;
        setMessages(cachedPayload.items);
        setMessageCursor(cachedPayload.nextCursor);
      }
    }

    setMessageLoading(!showedCached);
    try {
      const payload = await getMessages(conversationId, {
        cursor: reset ? null : messageCursor,
        limit: 30,
      });
      if (messageLoadRequestRef.current !== requestId) return;

      setMessages((current) => (reset ? payload.items : [...payload.items, ...current]));
      setMessageCursor(payload.nextCursor);
    } finally {
      if (messageLoadRequestRef.current === requestId) {
        setMessageLoading(false);
      }
    }
  }

  useEffect(() => {
    window.localStorage.setItem('jjewa-theme', theme);
    document.documentElement.dataset.jjewaTheme = theme;
    document.body.dataset.jjewaTheme = theme;
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem('jjewa-muted-conversations', JSON.stringify(mutedConversationIds));
  }, [mutedConversationIds]);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 720px)');
    const handleChange = () => setIsMobileLayout(query.matches);

    handleChange();
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    function syncViewportHeight() {
      const height = resolveViewportShellHeight();
      const offsetTop = 0;
      document.documentElement.style.setProperty('--jjewa-viewport-height', `${height}px`);
      document.documentElement.style.setProperty('--jjewa-viewport-offset-top', `${offsetTop}px`);
    }

    syncViewportHeight();
    window.visualViewport?.addEventListener('resize', syncViewportHeight);
    window.visualViewport?.addEventListener('scroll', syncViewportHeight);
    window.addEventListener('resize', syncViewportHeight);

    return () => {
      window.visualViewport?.removeEventListener('resize', syncViewportHeight);
      window.visualViewport?.removeEventListener('scroll', syncViewportHeight);
      window.removeEventListener('resize', syncViewportHeight);
      document.documentElement.style.removeProperty('--jjewa-viewport-height');
      document.documentElement.style.removeProperty('--jjewa-viewport-offset-top');
    };
  }, []);

  useEffect(() => {
    void refreshAuthStatus();

    return () => {
      if (themeTransitionTimeoutRef.current) {
        window.clearTimeout(themeTransitionTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isMobileLayout || (!activeConversation && !activeContactListId)) return;

    resetMobileViewportShell();
  }, [isMobileLayout, activeConversation?.id, activeContactListId]);

  useEffect(() => {
    if (canUseApp) {
      if (!socket.connected) socket.connect();
      return;
    }

    socket.disconnect();
  }, [canUseApp]);

  useEffect(() => {
    if (deviceManagerOpen) {
      void loadDevices();
    }
  }, [deviceManagerOpen]);

  useEffect(() => {
    if (!canUseApp) return;

    const cachedBootstrap = getCachedBootstrap();
    if (cachedBootstrap) {
      applyBootstrap(cachedBootstrap);
    }

    void loadBootstrap();
  }, [canUseApp]);

  useEffect(() => {
    if (!canUseApp || !bootstrapped || !selectedPhoneNumberId) return;
    void loadConversations(true);
  }, [canUseApp, bootstrapped, selectedPhoneNumberId, deferredSearch]);

  useEffect(() => {
    if (!canUseApp || !bootstrapped || !selectedPhoneNumberId) return;
    void loadContactLists(selectedPhoneNumberId);
  }, [canUseApp, bootstrapped, selectedPhoneNumberId]);

  useEffect(() => {
    if (!activeConversation) return;
    void loadMessages(activeConversation.id, true);
    void markConversationReadSmart(activeConversation.id);
  }, [activeConversation?.id]);

  useEffect(() => {
    if (!activeConversation || messages.length === 0) return;
    if (messages.some((message) => message.conversationId !== activeConversation.id)) return;

    cacheMessageSnapshot(activeConversation.id, messages, messageCursor);
  }, [activeConversation?.id, messages, messageCursor]);

  useEffect(() => {
    function handleConversationUpdated(conversation: Conversation) {
      if (conversation.phoneNumberId !== selectedPhoneNumberId) return;

      if (conversation.isArchived) {
        setConversations((current) => current.filter((item) => item.id !== conversation.id));
        setActiveConversation((current) => (current?.id === conversation.id ? null : current));
        return;
      }

      const shouldAutoRead = activeConversation?.id === conversation.id;
      const nextConversation = shouldAutoRead
        ? { ...conversation, unreadCount: 0 }
        : conversation;

      setConversations((current) => upsertConversation(current, nextConversation));
      setActiveConversation((current) => (current?.id === conversation.id ? nextConversation : current));

      if (shouldAutoRead && conversation.unreadCount > 0) {
        void markConversationReadSmart(conversation.id);
      }
    }

    function handleMessageCreated(message: Message) {
      if (message.deletedAt) return;

      const isActiveConversationMessage = message.conversationId === activeConversation?.id;
      if (isActiveConversationMessage && !isMessageAfterConversationClear(message, activeConversation)) {
        return;
      }

      if (isActiveConversationMessage) {
        setMessages((current) => {
          if (current.some((item) => item.id === message.id)) return current;
          const withoutReplacedReaction = message.messageType === 'reaction'
            ? removeReplacedReaction(current, message.parentWaMessageId, message.direction, message.id)
            : current;
          const withoutOptimisticMedia = message.direction === 'outbound' && ['image', 'video', 'audio', 'document'].includes(message.messageType)
            ? withoutReplacedReaction.filter((item) => !(
              item.id < 0
              && item.direction === 'outbound'
              && item.messageType === message.messageType
              && item.status === 'queued'
            ))
            : withoutReplacedReaction;
          return sortMessages([...withoutOptimisticMedia, message]);
        });

        if (message.direction === 'inbound') {
          void markConversationReadSmart(message.conversationId);
        }
      }
    }

    function handleMessageStatus(message: Message) {
      if (message.deletedAt) {
        clearCachedMessageMedia(message.id);
        setMessages((current) => current.filter((item) => item.id !== message.id));
        return;
      }

      if (message.conversationId === activeConversation?.id && !isMessageAfterConversationClear(message, activeConversation)) {
        return;
      }

      setMessages((current) => {
        const existingIndex = current.findIndex((item) => (
          item.id === message.id
          || Boolean(item.waMessageId && message.waMessageId && item.waMessageId === message.waMessageId)
        ));

        if (existingIndex === -1) {
          return message.conversationId === activeConversation?.id ? sortMessages([...current, message]) : current;
        }

        const next = [...current];
        next[existingIndex] = mergeMessageUpdate(next[existingIndex], message);
        return next;
      });
    }

    function handleMessageDeleted(message: Message) {
      clearCachedMessageMedia(message.id);
      setMessages((current) => current.filter((item) => item.id !== message.id));
    }

    function handleConversationDeleted(payload: { id: number; phoneNumberId: number }) {
      if (payload.phoneNumberId !== selectedPhoneNumberId) return;
      clearCachedConversationData(payload.id);
      setConversations((current) => current.filter((conversation) => conversation.id !== payload.id));
      setActiveConversation((current) => (current?.id === payload.id ? null : current));
      if (activeConversation?.id === payload.id) {
        setMessages([]);
        setMessageCursor(null);
      }
    }

    function handleContactListUpdated(list: ContactList) {
      if (list.phoneNumberId !== selectedPhoneNumberId) return;
      if (list.isArchived) {
        setContactLists((current) => current.filter((item) => item.id !== list.id));
        setActiveContactListId((current) => (current === list.id ? null : current));
        setActiveContactList((current) => (current?.id === list.id ? null : current));
        return;
      }

      setContactLists((current) => upsertContactList(current, list));
      setActiveContactList((current) => (current?.id === list.id ? list : current));
    }

    function handleContactUpdated(contact: Contact) {
      const contactName = contact.businessDirectoryName || contact.profileName || contact.phoneNumber || contact.waId;

      setConversations((current) => current.map((conversation) => (
        conversation.contactId === contact.id
          ? {
              ...conversation,
              contactName,
              contactPhone: contact.phoneNumber,
              contactWaId: contact.waId,
              contactOptInStatus: contact.optInStatus,
              contactOptInUpdatedAt: contact.optInUpdatedAt,
              contactLastOptInTemplateName: contact.lastOptInTemplateName,
              contactLastOptInPromptAt: contact.lastOptInPromptAt,
              contactLastInboundAt: contact.lastInboundAt,
              contactLastOutboundAt: contact.lastOutboundAt,
            }
          : conversation
      )));
      setActiveConversation((current) => (
        current?.contactId === contact.id
          ? {
              ...current,
              contactName,
              contactPhone: contact.phoneNumber,
              contactWaId: contact.waId,
              contactOptInStatus: contact.optInStatus,
              contactOptInUpdatedAt: contact.optInUpdatedAt,
              contactLastOptInTemplateName: contact.lastOptInTemplateName,
              contactLastOptInPromptAt: contact.lastOptInPromptAt,
              contactLastInboundAt: contact.lastInboundAt,
              contactLastOutboundAt: contact.lastOutboundAt,
            }
          : current
      ));

      const updateListContact = (list: ContactList) => ({
        ...list,
        members: list.members?.map((member) => (
          member.contact.id === contact.id ? { ...member, contact } : member
        )),
      });
      setContactLists((current) => current.map(updateListContact));
      setActiveContactList((current) => (current ? updateListContact(current) : current));
    }

    function handleContactListDeleted(payload: { id: number; phoneNumberId: number }) {
      if (payload.phoneNumberId !== selectedPhoneNumberId) return;
      setContactLists((current) => current.filter((list) => list.id !== payload.id));
      setActiveContactListId((current) => (current === payload.id ? null : current));
      setActiveContactList((current) => (current?.id === payload.id ? null : current));
    }

    socket.on('conversation:updated', handleConversationUpdated);
    socket.on('conversation:deleted', handleConversationDeleted);
    socket.on('message:created', handleMessageCreated);
    socket.on('message:status', handleMessageStatus);
    socket.on('message:deleted', handleMessageDeleted);
    socket.on('contact:updated', handleContactUpdated);
    socket.on('contact-list:updated', handleContactListUpdated);
    socket.on('contact-list:deleted', handleContactListDeleted);

    return () => {
      socket.off('conversation:updated', handleConversationUpdated);
      socket.off('conversation:deleted', handleConversationDeleted);
      socket.off('message:created', handleMessageCreated);
      socket.off('message:status', handleMessageStatus);
      socket.off('message:deleted', handleMessageDeleted);
      socket.off('contact:updated', handleContactUpdated);
      socket.off('contact-list:updated', handleContactListUpdated);
      socket.off('contact-list:deleted', handleContactListDeleted);
    };
  }, [activeConversation, selectedPhoneNumberId]);

  async function handleSendText(text: string, replyToWaMessageId?: string | null) {
    if (!activeConversation) return;
    const optimisticId = optimisticMessageIdRef.current--;
    const nowIso = new Date().toISOString();
    const optimisticMessage: Message = {
      id: optimisticId,
      conversationId: activeConversation.id,
      phoneNumberId: activeConversation.phoneNumberId,
      contactId: activeConversation.contactId,
      direction: 'outbound',
      messageType: 'text',
      waMessageId: `local-${Math.abs(optimisticId)}`,
      parentWaMessageId: null,
      textBody: text,
      caption: null,
      mediaId: null,
      mediaUrl: null,
      mimeType: null,
      fileName: null,
      templateName: null,
      templateLanguage: null,
      templateParams: null,
      campaignId: null,
      status: 'queued',
      errorMessage: null,
      waTimestamp: nowIso,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
      starredAt: null,
      deletedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const optimisticConversation: Conversation = {
      ...activeConversation,
      lastMessageId: optimisticId,
      lastMessagePreview: buildOptimisticPreview('text', text, null),
      lastMessageAt: nowIso,
    };

    setMessages((current) => [...current, optimisticMessage]);
    setConversations((current) => upsertConversation(current, optimisticConversation));
    setActiveConversation(optimisticConversation);
    setSending(true);
    try {
      const sentMessage = await sendConversationMessage(activeConversation.id, {
        type: 'text',
        text,
        replyToWaMessageId: replyToWaMessageId || null,
      });
      setMessages((current) => {
        const withoutOptimistic = current.filter((item) => item.id !== optimisticId);
        if (withoutOptimistic.some((item) => item.id === sentMessage.id)) {
          return withoutOptimistic;
        }

        return [...withoutOptimistic, sentMessage];
      });
    } catch (error) {
      setMessages((current) => current.map((item) => (
        item.id === optimisticId
          ? {
              ...item,
              status: 'failed',
              errorMessage: error instanceof Error ? error.message : 'Send failed',
              failedAt: new Date().toISOString(),
            }
          : item
      )));
      throw error;
    } finally {
      setSending(false);
    }
  }

  async function handleSendAttachment(file: File, caption: string, replyToWaMessageId?: string | null) {
    if (!activeConversation) return;
    const optimisticId = optimisticMessageIdRef.current--;
    const nowIso = new Date().toISOString();
    const localPreviewUrl = URL.createObjectURL(file);
    const mediaType = file.type.startsWith('image/')
      ? 'image'
      : file.type.startsWith('video/')
        ? 'video'
        : file.type.startsWith('audio/')
          ? 'audio'
          : 'document';

    const optimisticMessage: Message = {
      id: optimisticId,
      conversationId: activeConversation.id,
      phoneNumberId: activeConversation.phoneNumberId,
      contactId: activeConversation.contactId,
      direction: 'outbound',
      messageType: mediaType,
      waMessageId: `local-${Math.abs(optimisticId)}`,
      parentWaMessageId: null,
      textBody: null,
      caption: caption || null,
      mediaId: null,
      mediaUrl: localPreviewUrl,
      uploadProgress: 0,
      mimeType: file.type || null,
      fileName: file.name,
      templateName: null,
      templateLanguage: null,
      templateParams: null,
      campaignId: null,
      status: 'queued',
      errorMessage: null,
      waTimestamp: nowIso,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
      starredAt: null,
      deletedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const optimisticConversation: Conversation = {
      ...activeConversation,
      lastMessageId: optimisticId,
      lastMessagePreview: buildOptimisticPreview(mediaType, null, caption),
      lastMessageAt: nowIso,
    };

    setMessages((current) => [...current, optimisticMessage]);
    setConversations((current) => upsertConversation(current, optimisticConversation));
    setActiveConversation(optimisticConversation);
    setSending(true);

    try {
      const upload = await uploadMedia(activeConversation.phoneNumberId, file, (progress) => {
        setMessages((current) => current.map((item) => (
          item.id === optimisticId
            ? { ...item, uploadProgress: progress }
            : item
        )));
      });
      const sentMessage = await sendConversationMessage(activeConversation.id, {
        type: mediaType,
        mediaId: upload.mediaId,
        caption,
        mimeType: upload.mimeType || file.type,
        fileName: upload.fileName || file.name,
        replyToWaMessageId: replyToWaMessageId || null,
      });
      cacheMessageMedia(sentMessage, file, localPreviewUrl);
      URL.revokeObjectURL(localPreviewUrl);
      setMessages((current) => {
        const withoutOptimistic = current.filter((item) => item.id !== optimisticId);
        if (withoutOptimistic.some((item) => item.id === sentMessage.id)) {
          return withoutOptimistic;
        }

        return [...withoutOptimistic, sentMessage];
      });
    } catch (error) {
      URL.revokeObjectURL(localPreviewUrl);
      setMessages((current) => current.map((item) => (
        item.id === optimisticId
          ? {
              ...item,
              status: 'failed',
              errorMessage: error instanceof Error ? error.message : 'Send failed',
              failedAt: new Date().toISOString(),
            }
          : item
      )));
      throw error;
    } finally {
      setSending(false);
    }
  }

  async function handleSendReaction(targetMessage: Message, emoji: string) {
    if (!activeConversation || !targetMessage.waMessageId) return;
    const optimisticId = optimisticMessageIdRef.current--;
    const nowIso = new Date().toISOString();
    const optimisticMessage: Message = {
      id: optimisticId,
      conversationId: activeConversation.id,
      phoneNumberId: activeConversation.phoneNumberId,
      contactId: activeConversation.contactId,
      direction: 'outbound',
      messageType: 'reaction',
      waMessageId: `local-${Math.abs(optimisticId)}`,
      parentWaMessageId: targetMessage.waMessageId,
      textBody: emoji,
      caption: null,
      mediaId: null,
      mediaUrl: null,
      mimeType: null,
      fileName: null,
      templateName: null,
      templateLanguage: null,
      templateParams: null,
      campaignId: null,
      status: 'queued',
      errorMessage: null,
      waTimestamp: nowIso,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
      starredAt: null,
      deletedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    setMessages((current) => sortMessages([
      ...removeReplacedReaction(current, targetMessage.waMessageId, 'outbound'),
      optimisticMessage,
    ]));

    try {
      const sentMessage = await sendConversationMessage(activeConversation.id, {
        type: 'reaction',
        emoji,
        replyToWaMessageId: targetMessage.waMessageId,
      });
      setMessages((current) => {
        const withoutOptimistic = removeReplacedReaction(
          current.filter((item) => item.id !== optimisticId),
          targetMessage.waMessageId,
          'outbound',
          sentMessage.id,
        );
        if (withoutOptimistic.some((item) => item.id === sentMessage.id)) {
          return withoutOptimistic;
        }
        return sortMessages([...withoutOptimistic, sentMessage]);
      });
    } catch (error) {
      setMessages((current) => current.filter((item) => item.id !== optimisticId));
      throw error;
    }
  }

  async function handleToggleMessageStar(message: Message) {
    if (message.id < 0) return;
    const nextStarredAt = message.starredAt ? null : new Date().toISOString();

    setMessages((current) => current.map((item) => (
      item.id === message.id ? { ...item, starredAt: nextStarredAt } : item
    )));

    try {
      const updatedMessage = message.starredAt
        ? await unstarMessage(message.id)
        : await starMessage(message.id);

      setMessages((current) => current.map((item) => (
        item.id === updatedMessage.id ? mergeMessageUpdate(item, updatedMessage) : item
      )));
    } catch (error) {
      setMessages((current) => current.map((item) => (
        item.id === message.id ? { ...item, starredAt: message.starredAt } : item
      )));
      throw error;
    }
  }

  async function handleDeleteMessage(message: Message) {
    if (message.id < 0) {
      setMessages((current) => current.filter((item) => item.id !== message.id));
      return;
    }

    const previousMessages = messages;
    setMessages((current) => current.filter((item) => item.id !== message.id));

    try {
      const result = await deleteMessage(message.id);
      clearCachedMessageMedia(result.message.id);
      setMessages((current) => current.filter((item) => item.id !== result.message.id));
      setConversations((current) => upsertConversation(current, result.conversation));
      setActiveConversation((current) => (
        current?.id === result.conversation.id ? result.conversation : current
      ));
    } catch (error) {
      setMessages(previousMessages);
      throw error;
    }
  }

  async function openStarredMessages() {
    setStarredOpen(true);
    setStarredLoading(true);
    try {
      setStarredMessages(await getStarredMessages(selectedPhoneNumberId));
    } finally {
      setStarredLoading(false);
    }
  }

  function openForwardDialog(message: Message) {
    setForwardTarget(message);
    setForwardSelectedIds([]);
    setForwardError('');
  }

  function closeForwardDialog() {
    if (forwarding) return;
    setForwardTarget(null);
    setForwardSelectedIds([]);
    setForwardError('');
  }

  function buildForwardPayload(message: Message) {
    if (['image', 'video', 'audio', 'document'].includes(message.messageType) && message.mediaId) {
      return {
        type: message.messageType,
        mediaId: message.mediaId,
        caption: message.caption || message.textBody || '',
        mimeType: message.mimeType || undefined,
        fileName: message.fileName || undefined,
      };
    }

    return {
      type: 'text',
      text: getMessageForwardText(message),
    };
  }

  async function sendForwardedMessage() {
    if (!forwardTarget || forwardSelectedIds.length === 0) return;

    setForwarding(true);
    setForwardError('');
    try {
      const payload = buildForwardPayload(forwardTarget);
      await Promise.all(forwardSelectedIds.map((conversationId) => sendConversationMessage(conversationId, payload)));
      setForwardTarget(null);
      setForwardSelectedIds([]);
      setForwardError('');
      void loadConversations(true);
    } catch (error) {
      setForwardError(error instanceof Error ? error.message : 'Forward failed');
    } finally {
      setForwarding(false);
    }
  }

  async function handleStartChat(contact: Contact) {
    if (!selectedPhoneNumberId) {
      throw new Error('Select a business number first');
    }

    const conversation = await startConversation({
      phoneNumberId: selectedPhoneNumberId,
      contactId: contact.id,
    });

    resetMobileViewportShell();
    setActiveContactListId(null);
    setActiveContactList(null);
    setActiveConversation(conversation);
    setConversations((current) => upsertConversation(current, conversation));
  }

  async function handleSendOptInTemplate(templateKind: 'auto' | 'intro' | 'followup') {
    if (!activeConversation) return;

    setSending(true);
    try {
      const result = await sendConversationOptInTemplate(activeConversation.id, templateKind);
      setMessages((current) => (
        current.some((message) => message.id === result.message.id)
          ? current
          : [...current, result.message]
      ));
      setActiveConversation(result.conversation);
      setConversations((current) => upsertConversation(current, result.conversation));
    } finally {
      setSending(false);
    }
  }

  async function handleSendBroadcast(contactList: ContactList, payload: BroadcastSendPayload): Promise<Campaign> {
    const bodyText = payload.bodyText.trim();
    const file = payload.file || null;
    let mode: Campaign['mode'] = 'text';
    let mediaId: string | undefined;
    let mimeType: string | undefined;
    let fileName: string | undefined;

    if (file) {
      mode = file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('video/')
          ? 'video'
          : file.type.startsWith('audio/')
            ? 'audio'
            : 'document';

      const upload = await uploadMedia(contactList.phoneNumberId, file);
      mediaId = upload.mediaId;
      mimeType = upload.mimeType || file.type;
      fileName = upload.fileName || file.name;
    }

    return createCampaign({
      phoneNumberId: contactList.phoneNumberId,
      contactListId: contactList.id,
      title: contactList.name,
      mode,
      bodyText,
      mediaId,
      mimeType,
      fileName,
      recipients: [],
    });
  }

  async function handleClearConversation(conversationId: number) {
    const updatedConversation = await clearConversation(conversationId);
    clearCachedConversationData(conversationId);
    setConversations((current) => upsertConversation(current, updatedConversation));
    setActiveConversation((current) => (current?.id === conversationId ? updatedConversation : current));

    if (activeConversation?.id === conversationId) {
      setMessages([]);
      setMessageCursor(null);
    }
  }

  async function handleDeleteConversation(conversationId: number) {
    await deleteConversation(conversationId);
    clearCachedConversationData(conversationId);
    setConversations((current) => current.filter((conversation) => conversation.id !== conversationId));

    if (activeConversation?.id === conversationId) {
      setActiveConversation(null);
      setMessages([]);
      setMessageCursor(null);
    }
  }

  async function handleClearContactList(contactListId: number) {
    const updatedList = await clearContactList(contactListId);
    setContactLists((current) => upsertContactList(current, updatedList));
    setActiveContactList((current) => (current?.id === contactListId ? updatedList : current));
  }

  async function handleDeleteContactList(contactListId: number) {
    await deleteContactList(contactListId);
    setContactLists((current) => current.filter((list) => list.id !== contactListId));

    if (activeContactListId === contactListId) {
      setActiveContactListId(null);
      setActiveContactList(null);
    }
  }

  function handleBackToMobileList() {
    resetMobileViewportShell();
    setActiveConversation(null);
    setActiveContactListId(null);
    setActiveContactList(null);
    setMessages([]);
    setMessageCursor(null);
  }

  if (authLoading && !authStatus) {
    return (
      <div className={`wa-page theme-${theme} ${themeTransitioning ? 'is-theme-transitioning' : ''}`}>
        <AuthLoadingScreen />
      </div>
    );
  }

  if (!authStatus) {
    return (
      <div className={`wa-page theme-${theme} ${themeTransitioning ? 'is-theme-transitioning' : ''}`}>
        <PendingDeviceScreen
          authStatus={{
            authenticated: false,
            canUseApp: false,
            user: null,
            device: null,
          }}
          loading={authLoading}
          error={authError}
          onRefresh={() => void refreshAuthStatus()}
          onResetDevice={() => void handleResetDevice()}
        />
      </div>
    );
  }

  if (!authStatus.canUseApp) {
    return (
      <div className={`wa-page theme-${theme} ${themeTransitioning ? 'is-theme-transitioning' : ''}`}>
        <PendingDeviceScreen
          authStatus={authStatus}
          loading={authLoading}
          error={authError}
          onRefresh={() => void refreshAuthStatus()}
          onResetDevice={() => void handleResetDevice()}
        />
      </div>
    );
  }

  return (
    <div className={`wa-page theme-${theme} ${themeTransitioning ? 'is-theme-transitioning' : ''}`}>
      <div className={`wa-app-shell ${isChatOpen ? 'wa-app-shell--chat-open' : 'wa-app-shell--list-open'}`}>
        <ConversationList
          theme={theme}
          numbers={numbers}
          selectedPhoneNumberId={selectedPhoneNumberId}
          conversations={conversations}
          contactLists={contactLists}
          activeConversationId={activeConversation?.id ?? null}
          activeContactListId={activeContactListId}
          mutedConversationIds={mutedConversationIds}
          search={search}
          onSearchChange={setSearch}
          onToggleTheme={toggleTheme}
          onSelectPhoneNumber={(phoneNumberId) => {
            resetMobileViewportShell();
            setSelectedPhoneNumberId(phoneNumberId);
            setActiveConversation(null);
            setActiveContactListId(null);
            setActiveContactList(null);
          }}
          onSelectConversation={(conversationId) => {
            const selected = conversations.find((conversation) => conversation.id === conversationId) || null;
            resetMobileViewportShell();
            setActiveContactListId(null);
            setActiveContactList(null);
            setActiveConversation(selected);
          }}
          onSelectContactList={(contactListId) => {
            const selected = contactLists.find((list) => list.id === contactListId) || null;
            resetMobileViewportShell();
            setActiveConversation(null);
            setActiveContactListId(contactListId);
            setActiveContactList(selected);
          }}
          onOpenStarred={() => void openStarredMessages()}
          onOpenDevices={() => setDeviceManagerOpen(true)}
          onResetDevice={() => void handleResetDevice()}
          onRefresh={() => {
            void loadConversations(true);
            if (selectedPhoneNumberId) {
              void loadContactLists(selectedPhoneNumberId);
            }
          }}
          onComposeCampaign={() => setCampaignOpen(true)}
          onStartChat={() => setStartChatOpen(true)}
          onAddContact={() => setAddContactOpen(true)}
          onClearConversation={handleClearConversation}
          onDeleteConversation={handleDeleteConversation}
          onClearContactList={handleClearContactList}
          onDeleteContactList={handleDeleteContactList}
          onLoadMore={() => void loadConversations(false)}
          hasMore={Boolean(conversationCursor)}
          loading={conversationLoading}
        />

        <main className="main-panel">
          {activeContactListId ? (
            <BroadcastWorkspace
              theme={theme}
              contactList={activeContactList}
              onBack={handleBackToMobileList}
              onSendBroadcast={handleSendBroadcast}
              onContactListUpdated={(updatedList) => {
                setActiveContactList(updatedList);
                setContactLists((current) => upsertContactList(current, updatedList));
              }}
            />
          ) : (
            <ChatWindow
              theme={theme}
              conversation={activeConversation}
              messages={messages}
              muted={Boolean(activeConversation && mutedConversationIds.includes(activeConversation.id))}
              hasOlderMessages={Boolean(messageCursor)}
              loading={messageLoading}
              sending={sending}
              onBack={handleBackToMobileList}
              onLoadOlder={() => activeConversation && void loadMessages(activeConversation.id, false)}
              onSendText={handleSendText}
              onSendAttachment={handleSendAttachment}
              onSendReaction={handleSendReaction}
              onToggleStar={handleToggleMessageStar}
              onDeleteMessage={handleDeleteMessage}
              onForwardMessage={openForwardDialog}
              onSendOptInTemplate={handleSendOptInTemplate}
              onRenameContact={async (name) => {
                if (!activeConversation) return;

                const contact = await renameContact(activeConversation.contactId, name);
                const contactName = contact.businessDirectoryName || contact.profileName || contact.phoneNumber || contact.waId;
                setConversations((current) => current.map((conversation) => (
                  conversation.contactId === contact.id ? { ...conversation, contactName } : conversation
                )));
                setActiveConversation((current) => (
                  current?.contactId === contact.id ? { ...current, contactName } : current
                ));
                setContactLists((current) => current.map((list) => ({
                  ...list,
                  members: list.members?.map((member) => (
                    member.contact.id === contact.id ? { ...member, contact } : member
                  )),
                })));
                setActiveContactList((current) => current
                  ? {
                      ...current,
                      members: current.members?.map((member) => (
                        member.contact.id === contact.id ? { ...member, contact } : member
                      )),
                    }
                  : current);
              }}
              onToggleMute={() => {
                if (!activeConversation) return;
                setMutedConversationIds((current) => (
                  current.includes(activeConversation.id)
                    ? current.filter((conversationId) => conversationId !== activeConversation.id)
                    : [...current, activeConversation.id]
                ));
              }}
            />
          )}
        </main>
      </div>

      <CampaignComposer
        open={campaignOpen}
        numbers={numbers}
        defaultPhoneNumberId={selectedPhoneNumberId}
        onClose={() => setCampaignOpen(false)}
        onCreateContactList={async ({ phoneNumberId, list }) => {
          setContactLists((current) => upsertContactList(current, list));
          setActiveConversation(null);
          setActiveContactListId(list.id);
          setActiveContactList(list);
          await loadContactLists(phoneNumberId, list.id);
          setCampaignOpen(false);
        }}
      />

      <StartChatDialog
        open={startChatOpen}
        onClose={() => setStartChatOpen(false)}
        onStartChat={handleStartChat}
      />

      <AddContactDialog
        open={addContactOpen}
        onClose={() => setAddContactOpen(false)}
        onContactCreated={handleStartChat}
      />

      <DeviceManagerDialog
        open={deviceManagerOpen}
        devices={devices}
        loading={devicesLoading}
        error={devicesError}
        onClose={() => setDeviceManagerOpen(false)}
        onRefresh={() => void loadDevices()}
        onUpdateStatus={(deviceId, status) => void handleUpdateDeviceStatus(deviceId, status)}
      />

      <div className={`bottom-sheet starred-sheet ${starredOpen ? 'is-open' : ''}`} aria-hidden={!starredOpen}>
        <div className="bottom-sheet__backdrop" onClick={() => setStarredOpen(false)} />
        <section className="bottom-sheet__panel frosted-panel" role="dialog" aria-modal="true">
          <header className="bottom-sheet__header">
            <div>
              <span className="bottom-sheet__eyebrow">Starred</span>
              <h2>Starred messages</h2>
              <p>Saved messages from all chats.</p>
            </div>
            <button type="button" className="toolbar-icon-button" onClick={() => setStarredOpen(false)} title="Close">
              <X size={18} />
            </button>
          </header>
          <div className="bottom-sheet__body starred-message-list">
            {starredLoading && (
              <div className="skeleton-list">
                {[0, 1, 2, 3].map((item) => (
                  <div key={item} className="starred-message-row skeleton-contact-row">
                    <span className="skeleton-avatar" />
                    <span className="skeleton-contact-row__copy">
                      <span className="skeleton-line skeleton-line--medium" />
                      <span className="skeleton-line skeleton-line--short" />
                    </span>
                  </div>
                ))}
              </div>
            )}

            {!starredLoading && starredMessages.map((message) => (
              <button
                key={message.id}
                type="button"
                className="starred-message-row"
                onClick={() => {
                  const target = conversations.find((conversation) => conversation.id === message.conversationId);
                  if (target) {
                    setActiveContactListId(null);
                    setActiveContactList(null);
                    setActiveConversation(target);
                  }
                  setStarredOpen(false);
                }}
              >
                <span className="starred-message-row__icon">
                  <Star size={16} />
                </span>
                <span className="starred-message-row__copy">
                  <strong>{message.contactName}</strong>
                  <span>{getMessageListPreview(message)}</span>
                </span>
                <span className="starred-message-row__meta">
                  <small>{formatCompactDateTime(message.createdAt)}</small>
                  <small>starred {formatCompactDateTime(message.starredAt)}</small>
                </span>
              </button>
            ))}

            {!starredLoading && starredMessages.length === 0 && (
              <div className="contact-picker-list__state">No starred messages yet.</div>
            )}
          </div>
        </section>
      </div>

      <div className={`dialog-layer forward-layer ${forwardTarget ? 'is-open' : ''}`} aria-hidden={!forwardTarget}>
        <div className="dialog-layer__backdrop" onClick={closeForwardDialog} />
        <section className="forward-dialog frosted-panel" role="dialog" aria-modal="true">
          <header className="forward-dialog__header">
            <div>
              <span className="bottom-sheet__eyebrow">Forward</span>
              <h2>Forward message</h2>
              <p>{forwardTarget ? getMessageListPreview(forwardTarget) : ''}</p>
            </div>
            <button type="button" className="toolbar-icon-button" onClick={closeForwardDialog} title="Close">
              <X size={18} />
            </button>
          </header>

          {forwardError && <div className="form-error">{forwardError}</div>}

          <div className="forward-dialog__list">
            {conversations.map((conversation) => {
              const selected = forwardSelectedIds.includes(conversation.id);

              return (
                <button
                  key={conversation.id}
                  type="button"
                  className={`forward-target-row ${selected ? 'is-selected' : ''}`}
                  onClick={() => setForwardSelectedIds((current) => (
                    current.includes(conversation.id)
                      ? current.filter((id) => id !== conversation.id)
                      : [...current, conversation.id]
                  ))}
                >
                  <span className="conversation-card__avatar">
                    {conversation.contactName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="forward-target-row__copy">
                    <strong>{conversation.contactName}</strong>
                    <span>{conversation.contactPhone || conversation.contactWaId}</span>
                  </span>
                  <span className={`contact-picker-row__checkbox ${selected ? 'is-selected' : ''}`}>
                    {selected ? <Check size={14} /> : null}
                  </span>
                </button>
              );
            })}
          </div>

          <footer className="forward-dialog__footer">
            <button type="button" className="ghost-button" onClick={closeForwardDialog} disabled={forwarding}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => void sendForwardedMessage()}
              disabled={forwarding || forwardSelectedIds.length === 0}
            >
              <Forward size={16} />
              {forwarding ? 'Forwarding...' : `Forward ${forwardSelectedIds.length || ''}`}
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}
