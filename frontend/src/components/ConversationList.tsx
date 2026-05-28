import { BellOff, Eraser, Megaphone, MessageCircleMore, MessageSquarePlus, Moon, RefreshCw, Search, SunMedium, Trash2, UserPlus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { BusinessNumber, ContactList, Conversation } from '../types';

type Props = {
  theme: 'dark' | 'light';
  numbers: BusinessNumber[];
  selectedPhoneNumberId: number | null;
  conversations: Conversation[];
  contactLists: ContactList[];
  activeConversationId: number | null;
  activeContactListId: number | null;
  mutedConversationIds: number[];
  search: string;
  onSearchChange: (value: string) => void;
  onToggleTheme: () => void;
  onSelectPhoneNumber: (phoneNumberId: number) => void;
  onSelectConversation: (conversationId: number) => void;
  onSelectContactList: (contactListId: number) => void;
  onRefresh: () => void;
  onComposeCampaign: () => void;
  onStartChat: () => void;
  onAddContact: () => void;
  onClearConversation: (conversationId: number) => Promise<void>;
  onDeleteConversation: (conversationId: number) => Promise<void>;
  onClearContactList: (contactListId: number) => Promise<void>;
  onDeleteContactList: (contactListId: number) => Promise<void>;
  onLoadMore: () => void;
  hasMore: boolean;
  loading: boolean;
};

type ChatActionTarget =
  | { kind: 'conversation'; id: number; title: string }
  | { kind: 'broadcast'; id: number; title: string };

type ConfirmAction = 'clear' | 'delete';

function businessLabel() {
  return 'Jay Jalaram Enterprise';
}

function formatTime(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  const now = new Date();
  const isSameDay = date.toDateString() === now.toDateString();

  if (isSameDay) {
    return date.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
    }).toLowerCase();
  }

  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
}

function ConversationRowsSkeleton({ count = 7 }: { count?: number }) {
  return (
    <div className="skeleton-list conversation-skeleton-list" aria-label="Loading chats">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="conversation-card skeleton-contact-row">
          <span className="skeleton-avatar" />
          <span className="skeleton-contact-row__copy">
            <span className="skeleton-line skeleton-line--medium" />
            <span className="skeleton-line skeleton-line--short" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function ConversationList({
  theme,
  numbers,
  selectedPhoneNumberId,
  conversations,
  contactLists,
  activeConversationId,
  activeContactListId,
  mutedConversationIds,
  search,
  onSearchChange,
  onToggleTheme,
  onSelectPhoneNumber,
  onSelectConversation,
  onSelectContactList,
  onRefresh,
  onComposeCampaign,
  onStartChat,
  onAddContact,
  onClearConversation,
  onDeleteConversation,
  onClearContactList,
  onDeleteContactList,
  onLoadMore,
  hasMore,
  loading,
}: Props) {
  const [chatFilter, setChatFilter] = useState<'all' | 'unread'>('all');
  const [actionTarget, setActionTarget] = useState<ChatActionTarget | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadLockRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const consumedLongPressRef = useRef('');

  const filteredConversations = useMemo(() => (
    chatFilter === 'unread'
      ? conversations.filter((conversation) => conversation.unreadCount > 0)
      : conversations
  ), [chatFilter, conversations]);
  const filteredContactLists = useMemo(() => {
    if (chatFilter === 'unread') return [] as ContactList[];

    const query = search.trim().toLowerCase();
    if (!query) return contactLists;

    return contactLists.filter((list) => list.name.toLowerCase().includes(query));
  }, [chatFilter, contactLists, search]);
  const visibleChatCount = filteredConversations.length + filteredContactLists.length;

  useEffect(() => {
    if (!loading) {
      loadLockRef.current = false;
    }
  }, [loading]);

  useEffect(() => {
    if (!hasMore || loading || !listRef.current) return;
    if (listRef.current.scrollHeight <= listRef.current.clientHeight + 24) {
      loadLockRef.current = true;
      onLoadMore();
    }
  }, [hasMore, loading, visibleChatCount, onLoadMore]);

  function handleListScroll() {
    if (!hasMore || loading || loadLockRef.current || !listRef.current) return;
    const remaining = listRef.current.scrollHeight - (listRef.current.scrollTop + listRef.current.clientHeight);
    if (remaining <= 160) {
      loadLockRef.current = true;
      onLoadMore();
    }
  }

  function closeActionDialog() {
    if (actionBusy) return;
    setActionTarget(null);
    setConfirmAction(null);
    setActionError('');
  }

  function clearLongPressTimer() {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function openActionDialog(target: ChatActionTarget) {
    clearLongPressTimer();
    setActionTarget(target);
    setConfirmAction(null);
    setActionError('');
  }

  function handlePressStart(event: PointerEvent<HTMLButtonElement>, target: ChatActionTarget) {
    if (event.pointerType !== 'touch') return;

    clearLongPressTimer();
    const targetKey = `${target.kind}:${target.id}`;
    longPressTimerRef.current = window.setTimeout(() => {
      consumedLongPressRef.current = targetKey;
      openActionDialog(target);
    }, 600);
  }

  function handlePressEnd() {
    clearLongPressTimer();
  }

  function shouldSkipClick(target: ChatActionTarget) {
    const targetKey = `${target.kind}:${target.id}`;
    if (consumedLongPressRef.current !== targetKey) return false;

    consumedLongPressRef.current = '';
    return true;
  }

  async function runConfirmedAction() {
    if (!actionTarget || !confirmAction) return;

    setActionBusy(true);
    setActionError('');
    try {
      if (actionTarget.kind === 'conversation') {
        if (confirmAction === 'clear') {
          await onClearConversation(actionTarget.id);
        } else {
          await onDeleteConversation(actionTarget.id);
        }
      } else if (confirmAction === 'clear') {
        await onClearContactList(actionTarget.id);
      } else {
        await onDeleteContactList(actionTarget.id);
      }

      setActionTarget(null);
      setConfirmAction(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setActionBusy(false);
    }
  }

  const confirmTitle = confirmAction === 'delete'
    ? `Delete ${actionTarget?.kind === 'broadcast' ? 'broadcast' : 'chat'}?`
    : `Clear ${actionTarget?.kind === 'broadcast' ? 'broadcast' : 'chat'}?`;
  const confirmBody = confirmAction === 'delete'
    ? 'This removes it from the chat list. Existing records stay in the database.'
    : 'This starts the chat fresh by hiding older history. Existing records stay in the database.';

  return (
    <aside className="sidebar">
      <div className="sidebar__rail">
        <button type="button" className="rail-icon-button is-active" title="Chats">
          <MessageCircleMore size={20} />
        </button>

        <div className="sidebar__rail-spacer" />

        <button type="button" className="rail-icon-button" onClick={onToggleTheme} title="Toggle theme">
          {theme === 'dark' ? <SunMedium size={20} /> : <Moon size={20} />}
        </button>
      </div>

      <div className="sidebar__panel">
        <header className="sidebar__toolbar">
          <div className="sidebar__identity">
            <div className="sidebar__identity-avatar">J</div>
            <div className="sidebar__identity-copy">
              <strong>Jay Jalaram Enterprise</strong>
              <span>Chats</span>
            </div>
          </div>
          <div className="sidebar__toolbar-actions">
            <button
              type="button"
              className="toolbar-icon-button"
              onClick={onRefresh}
              title="Refresh chats"
            >
              <RefreshCw size={18} />
            </button>
            <button
              type="button"
              className="toolbar-icon-button mobile-theme-toggle"
              onClick={onToggleTheme}
              title="Toggle theme"
            >
              {theme === 'dark' ? <SunMedium size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </header>

        <div className="sidebar__number-switcher">
          <select
            value={selectedPhoneNumberId ?? ''}
            onChange={(event) => onSelectPhoneNumber(Number(event.target.value))}
          >
            {numbers.map((number) => (
              <option key={number.id} value={number.id}>
                {businessLabel()} ({number.phoneNumber})
              </option>
            ))}
          </select>
        </div>

        <label className="searchbox">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search or start a new chat"
          />
        </label>

        <div className="sidebar__filters">
          <button
            type="button"
            className={`sidebar-filter-pill ${chatFilter === 'all' ? 'is-active' : ''}`}
            onClick={() => setChatFilter('all')}
          >
            All
          </button>
          <button
            type="button"
            className={`sidebar-filter-pill ${chatFilter === 'unread' ? 'is-active' : ''}`}
            onClick={() => setChatFilter('unread')}
          >
            Unread {conversations.filter((conversation) => conversation.unreadCount > 0).length || ''}
          </button>
        </div>

        <div className="sidebar__section-label">
          <span>Chats</span>
          <span>{visibleChatCount}</span>
        </div>

        <div ref={listRef} className="conversation-list" onScroll={handleListScroll}>
          {filteredContactLists.map((list) => (
            <button
              key={`broadcast:${list.id}`}
              type="button"
              className={`conversation-card conversation-card--broadcast ${list.id === activeContactListId ? 'is-active' : ''}`}
              onClick={() => {
                const target = { kind: 'broadcast' as const, id: list.id, title: list.name };
                if (shouldSkipClick(target)) return;
                onSelectContactList(list.id);
              }}
              onPointerDown={(event) => handlePressStart(event, { kind: 'broadcast', id: list.id, title: list.name })}
              onPointerUp={handlePressEnd}
              onPointerCancel={handlePressEnd}
              onPointerLeave={handlePressEnd}
              onContextMenu={(event) => {
                event.preventDefault();
                openActionDialog({ kind: 'broadcast', id: list.id, title: list.name });
              }}
            >
              <div className="conversation-card__avatar conversation-card__avatar--broadcast">
                <Megaphone size={18} />
              </div>
              <div className="conversation-card__body">
                <div className="conversation-card__top">
                  <strong>{list.name}</strong>
                  <span>{formatTime(list.updatedAt || list.createdAt)}</span>
                </div>
                <div className="conversation-card__bottom">
                  <span>Broadcast list • {list.memberCount ?? list.members?.length ?? 0} recipients</span>
                </div>
              </div>
            </button>
          ))}

          {filteredConversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className={`conversation-card ${conversation.id === activeConversationId ? 'is-active' : ''}`}
              onClick={() => {
                const target = { kind: 'conversation' as const, id: conversation.id, title: conversation.contactName };
                if (shouldSkipClick(target)) return;
                onSelectConversation(conversation.id);
              }}
              onPointerDown={(event) => handlePressStart(event, { kind: 'conversation', id: conversation.id, title: conversation.contactName })}
              onPointerUp={handlePressEnd}
              onPointerCancel={handlePressEnd}
              onPointerLeave={handlePressEnd}
              onContextMenu={(event) => {
                event.preventDefault();
                openActionDialog({ kind: 'conversation', id: conversation.id, title: conversation.contactName });
              }}
            >
              <div className="conversation-card__avatar">
                {conversation.contactName.slice(0, 1).toUpperCase()}
              </div>
              <div className="conversation-card__body">
                <div className="conversation-card__top">
                  <strong>{conversation.contactName}</strong>
                  <div className="conversation-card__top-meta">
                    {mutedConversationIds.includes(conversation.id) && (
                      <BellOff size={14} className="conversation-card__mute-indicator" />
                    )}
                    <span>{formatTime(conversation.lastMessageAt)}</span>
                  </div>
                </div>
                <div className="conversation-card__bottom">
                  <span>{conversation.lastMessagePreview || 'No messages yet'}</span>
                  {conversation.unreadCount > 0 && (
                    <span className="conversation-card__badge">{conversation.unreadCount}</span>
                  )}
                </div>
              </div>
            </button>
          ))}

          {loading && visibleChatCount === 0 && <ConversationRowsSkeleton />}

          {!loading && visibleChatCount === 0 && (
            <div className="conversation-empty">
              <MessageCircleMore size={18} />
              <span>No conversations found</span>
            </div>
          )}
        </div>

        {hasMore && (
          <button
            type="button"
            className="ghost-button sidebar__load-more"
            onClick={() => {
              if (loadLockRef.current) return;
              loadLockRef.current = true;
              onLoadMore();
            }}
          >
            Load older chats
          </button>
        )}

        <div className="sidebar__footer-action">
          <button type="button" className="sidebar-action-tile" onClick={onComposeCampaign}>
            <Megaphone size={16} />
            <span>New broadcast</span>
          </button>
          <button type="button" className="sidebar-action-tile" onClick={onStartChat}>
            <MessageSquarePlus size={16} />
            <span>Start chat</span>
          </button>
          <button type="button" className="sidebar-action-tile" onClick={onAddContact}>
            <UserPlus size={16} />
            <span>Add contact</span>
          </button>
        </div>
      </div>

      <div className={`dialog-layer chat-action-layer ${actionTarget ? 'is-open' : ''}`} aria-hidden={!actionTarget}>
        <div className="dialog-layer__backdrop" onClick={closeActionDialog} />
        <section className="chat-action-sheet frosted-panel" role="dialog" aria-modal="true">
          <header className="chat-action-sheet__header">
            <div>
              <span className="bottom-sheet__eyebrow">
                {actionTarget?.kind === 'broadcast' ? 'Broadcast list' : 'Chat'}
              </span>
              <h2>{confirmAction ? confirmTitle : actionTarget?.title}</h2>
              {confirmAction && <p>{confirmBody}</p>}
            </div>
            <button type="button" className="toolbar-icon-button" onClick={closeActionDialog} title="Close">
              <X size={18} />
            </button>
          </header>

          {actionError && <div className="form-error chat-action-sheet__error">{actionError}</div>}

          {!confirmAction ? (
            <div className="chat-action-sheet__actions">
              <button type="button" onClick={() => setConfirmAction('clear')}>
                <Eraser size={18} />
                <span>Clear {actionTarget?.kind === 'broadcast' ? 'broadcast' : 'chat'}</span>
              </button>
              <button type="button" className="is-danger" onClick={() => setConfirmAction('delete')}>
                <Trash2 size={18} />
                <span>Delete {actionTarget?.kind === 'broadcast' ? 'broadcast' : 'chat'}</span>
              </button>
            </div>
          ) : (
            <footer className="chat-action-sheet__confirm">
              <button type="button" className="ghost-button" onClick={() => setConfirmAction(null)} disabled={actionBusy}>
                Cancel
              </button>
              <button
                type="button"
                className={`primary-button ${confirmAction === 'delete' ? 'primary-button--danger' : ''}`}
                onClick={() => void runConfirmedAction()}
                disabled={actionBusy}
              >
                {actionBusy ? 'Working...' : confirmAction === 'delete' ? 'Yes, delete' : 'Yes, clear'}
              </button>
            </footer>
          )}
        </section>
      </div>
    </aside>
  );
}
