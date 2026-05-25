import { BellOff, Megaphone, MessageCircleMore, MessageSquarePlus, Moon, RefreshCw, Search, SunMedium, UserPlus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
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
  onLoadMore: () => void;
  hasMore: boolean;
  loading: boolean;
};

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
  onLoadMore,
  hasMore,
  loading,
}: Props) {
  const [chatFilter, setChatFilter] = useState<'all' | 'unread'>('all');
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadLockRef = useRef(false);

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
              onClick={onComposeCampaign}
              title="New broadcast"
            >
              <Megaphone size={18} />
            </button>
            <button
              type="button"
              className="toolbar-icon-button"
              onClick={onRefresh}
              title="Refresh chats"
            >
              <RefreshCw size={18} />
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
              onClick={() => onSelectContactList(list.id)}
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
              onClick={() => onSelectConversation(conversation.id)}
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
    </aside>
  );
}
