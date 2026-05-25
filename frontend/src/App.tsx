import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { CampaignComposer } from './components/CampaignComposer';
import { ChatWindow } from './components/ChatWindow';
import { ConversationList } from './components/ConversationList';
import { BroadcastWorkspace } from './components/BroadcastWorkspace';
import { AddContactDialog, StartChatDialog } from './components/ContactDialogs';
import {
  createCampaign,
  getBootstrap,
  getContactList,
  getContactLists,
  getConversations,
  getMessages,
  markConversationRead,
  sendConversationOptInTemplate,
  sendConversationMessage,
  startConversation,
  uploadMedia,
} from './lib/api';
import { socket } from './lib/socket';
import type { BootstrapPayload, Campaign, Contact, ContactList, Conversation, Message } from './types';

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

const MESSAGE_STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

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

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(resolveInitialTheme);
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
  const deferredSearch = useDeferredValue(search);
  const optimisticMessageIdRef = useRef(-1);
  const readInFlightRef = useRef<number | null>(null);

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

  async function loadBootstrap() {
    const data = await getBootstrap();
    setNumbers(data.businessNumbers);
    setSelectedPhoneNumberId((current) => current ?? data.defaultPhoneNumberId);
    setBootstrapped(true);
  }

  async function loadConversations(reset = true) {
    if (!selectedPhoneNumberId) return;
    setConversationLoading(true);

    try {
      const payload = await getConversations({
        phoneNumberId: selectedPhoneNumberId,
        search: deferredSearch,
        cursor: reset ? null : conversationCursor,
        limit: 20,
      });

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
            : payload.items[0]);
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
    setMessageLoading(true);
    try {
      const payload = await getMessages(conversationId, {
        cursor: reset ? null : messageCursor,
        limit: 30,
      });

      setMessages((current) => (reset ? payload.items : [...payload.items, ...current]));
      setMessageCursor(payload.nextCursor);
    } finally {
      setMessageLoading(false);
    }
  }

  useEffect(() => {
    window.localStorage.setItem('jjewa-theme', theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem('jjewa-muted-conversations', JSON.stringify(mutedConversationIds));
  }, [mutedConversationIds]);

  useEffect(() => {
    void loadBootstrap();
  }, []);

  useEffect(() => {
    if (!bootstrapped || !selectedPhoneNumberId) return;
    void loadConversations(true);
  }, [bootstrapped, selectedPhoneNumberId, deferredSearch]);

  useEffect(() => {
    if (!bootstrapped || !selectedPhoneNumberId) return;
    void loadContactLists(selectedPhoneNumberId);
  }, [bootstrapped, selectedPhoneNumberId]);

  useEffect(() => {
    if (!activeConversation) return;
    void loadMessages(activeConversation.id, true);
    void markConversationReadSmart(activeConversation.id);
  }, [activeConversation?.id]);

  useEffect(() => {
    function handleConversationUpdated(conversation: Conversation) {
      if (conversation.phoneNumberId !== selectedPhoneNumberId) return;

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
      const isActiveConversationMessage = message.conversationId === activeConversation?.id;
      if (isActiveConversationMessage) {
        setMessages((current) => (
          current.some((item) => item.id === message.id) ? current : [...current, message]
        ));

        if (message.direction === 'inbound') {
          void markConversationReadSmart(message.conversationId);
        }
      }
    }

    function handleMessageStatus(message: Message) {
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

    socket.on('conversation:updated', handleConversationUpdated);
    socket.on('message:created', handleMessageCreated);
    socket.on('message:status', handleMessageStatus);

    return () => {
      socket.off('conversation:updated', handleConversationUpdated);
      socket.off('message:created', handleMessageCreated);
      socket.off('message:status', handleMessageStatus);
    };
  }, [activeConversation?.id, selectedPhoneNumberId]);

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
      const upload = await uploadMedia(activeConversation.phoneNumberId, file);
      const sentMessage = await sendConversationMessage(activeConversation.id, {
        type: mediaType,
        mediaId: upload.mediaId,
        caption,
        mimeType: file.type,
        fileName: file.name,
        replyToWaMessageId: replyToWaMessageId || null,
      });
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
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    setMessages((current) => [...current, optimisticMessage]);

    try {
      const sentMessage = await sendConversationMessage(activeConversation.id, {
        type: 'reaction',
        emoji,
        replyToWaMessageId: targetMessage.waMessageId,
      });
      setMessages((current) => {
        const withoutOptimistic = current.filter((item) => item.id !== optimisticId);
        if (withoutOptimistic.some((item) => item.id === sentMessage.id)) {
          return withoutOptimistic;
        }
        return [...withoutOptimistic, sentMessage];
      });
    } catch (error) {
      setMessages((current) => current.filter((item) => item.id !== optimisticId));
      throw error;
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

  async function handleSendBroadcast(contactList: ContactList, bodyText: string): Promise<Campaign> {
    return createCampaign({
      phoneNumberId: contactList.phoneNumberId,
      contactListId: contactList.id,
      title: contactList.name,
      mode: 'text',
      bodyText,
      recipients: [],
    });
  }

  return (
    <div className={`wa-page theme-${theme}`}>
      <div className="wa-app-shell">
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
          onToggleTheme={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          onSelectPhoneNumber={(phoneNumberId) => {
            setSelectedPhoneNumberId(phoneNumberId);
            setActiveConversation(null);
            setActiveContactListId(null);
            setActiveContactList(null);
          }}
          onSelectConversation={(conversationId) => {
            const selected = conversations.find((conversation) => conversation.id === conversationId) || null;
            setActiveContactListId(null);
            setActiveContactList(null);
            setActiveConversation(selected);
          }}
          onSelectContactList={(contactListId) => {
            const selected = contactLists.find((list) => list.id === contactListId) || null;
            setActiveConversation(null);
            setActiveContactListId(contactListId);
            setActiveContactList(selected);
          }}
          onRefresh={() => {
            void loadConversations(true);
            if (selectedPhoneNumberId) {
              void loadContactLists(selectedPhoneNumberId);
            }
          }}
          onComposeCampaign={() => setCampaignOpen(true)}
          onStartChat={() => setStartChatOpen(true)}
          onAddContact={() => setAddContactOpen(true)}
          onLoadMore={() => void loadConversations(false)}
          hasMore={Boolean(conversationCursor)}
          loading={conversationLoading}
        />

        <main className="main-panel">
          {activeContactListId ? (
            <BroadcastWorkspace
              contactList={activeContactList}
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
              onLoadOlder={() => activeConversation && void loadMessages(activeConversation.id, false)}
              onSendText={handleSendText}
              onSendAttachment={handleSendAttachment}
              onSendReaction={handleSendReaction}
              onSendOptInTemplate={handleSendOptInTemplate}
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
    </div>
  );
}
