import { BellOff, Check, ChevronDown, Eraser, LogOut, Megaphone, Menu, MessageCircleMore, MessageSquarePlus, Moon, Plus, RefreshCw, Search, ShieldCheck, Star, SunMedium, Trash2, UserPlus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { AuthUser, BusinessNumber, ContactList, Conversation } from '../types';

type Props = {
  theme: 'dark' | 'light';
  currentUser: AuthUser | null;
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
  onOpenStarred: () => void;
  onOpenDevices: () => void;
  onLogout: () => void;
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
type ChatFilterMode = 'all' | 'unread' | 'favorites' | `custom:${string}`;
type ChatFilterMemberKey = `conversation:${number}` | `broadcast:${number}`;

type StoredChatFilter = {
  id: string;
  name: string;
  memberKeys: ChatFilterMemberKey[];
  createdAt: string;
};

type StoredChatFilterState = {
  favoriteKeys: ChatFilterMemberKey[];
  customFilters: StoredChatFilter[];
};

type BusinessNumberWithProfile = BusinessNumber & {
  avatarUrl?: string | null;
  profilePicture?: string | null;
  profilePictureUrl?: string | null;
};

function businessLabel() {
  return 'Jay Jalaram Enterprise';
}

function makeChatFilterStorageKey(phoneNumberId: number | null) {
  return `jjewa-chat-filters:${phoneNumberId || 'default'}`;
}

function makeMemberKey(target: ChatActionTarget): ChatFilterMemberKey {
  return `${target.kind === 'broadcast' ? 'broadcast' : 'conversation'}:${target.id}` as ChatFilterMemberKey;
}

function makeConversationMemberKey(conversationId: number): ChatFilterMemberKey {
  return `conversation:${conversationId}` as ChatFilterMemberKey;
}

function makeBroadcastMemberKey(contactListId: number): ChatFilterMemberKey {
  return `broadcast:${contactListId}` as ChatFilterMemberKey;
}

function loadStoredChatFilters(phoneNumberId: number | null): StoredChatFilterState {
  if (typeof window === 'undefined') return { favoriteKeys: [], customFilters: [] };

  try {
    const saved = window.localStorage.getItem(makeChatFilterStorageKey(phoneNumberId));
    if (!saved) return { favoriteKeys: [], customFilters: [] };

    const parsed = JSON.parse(saved);
    const favoriteKeys = Array.isArray(parsed?.favoriteKeys)
      ? parsed.favoriteKeys.filter((key: unknown): key is ChatFilterMemberKey => typeof key === 'string')
      : [];
    const customFilters = Array.isArray(parsed?.customFilters)
      ? parsed.customFilters
        .filter((filter: unknown): filter is StoredChatFilter => {
          const candidate = filter as StoredChatFilter;
          return Boolean(candidate?.id && candidate?.name && Array.isArray(candidate?.memberKeys));
        })
        .map((filter: StoredChatFilter) => ({
          id: String(filter.id),
          name: String(filter.name),
          memberKeys: filter.memberKeys.filter((key: unknown): key is ChatFilterMemberKey => typeof key === 'string'),
          createdAt: filter.createdAt || new Date().toISOString(),
        }))
      : [];

    return { favoriteKeys, customFilters };
  } catch {
    return { favoriteKeys: [], customFilters: [] };
  }
}

function saveStoredChatFilters(phoneNumberId: number | null, state: StoredChatFilterState) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(makeChatFilterStorageKey(phoneNumberId), JSON.stringify(state));
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
  currentUser,
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
  onOpenStarred,
  onOpenDevices,
  onLogout,
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
  const [chatFilter, setChatFilter] = useState<ChatFilterMode>('all');
  const [favoriteKeys, setFavoriteKeys] = useState<ChatFilterMemberKey[]>([]);
  const [customFilters, setCustomFilters] = useState<StoredChatFilter[]>([]);
  const [filterEditorOpen, setFilterEditorOpen] = useState(false);
  const [editingFilterId, setEditingFilterId] = useState<string | null>(null);
  const [filterName, setFilterName] = useState('');
  const [filterMemberKeys, setFilterMemberKeys] = useState<ChatFilterMemberKey[]>([]);
  const [filterError, setFilterError] = useState('');
  const [actionTarget, setActionTarget] = useState<ChatActionTarget | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerAccountsOpen, setDrawerAccountsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(Boolean(search));
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadLockRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const filterLongPressTimerRef = useRef<number | null>(null);
  const consumedLongPressRef = useRef('');
  const consumedFilterLongPressRef = useRef('');
  const filterStorageHydratingRef = useRef(true);

  const activeCustomFilter = useMemo(() => (
    chatFilter.startsWith('custom:')
      ? customFilters.find((filter) => filter.id === chatFilter.slice('custom:'.length)) || null
      : null
  ), [chatFilter, customFilters]);

  const activeMemberKeySet = useMemo(() => {
    if (chatFilter === 'favorites') return new Set(favoriteKeys);
    if (activeCustomFilter) return new Set(activeCustomFilter.memberKeys);
    return null;
  }, [activeCustomFilter, chatFilter, favoriteKeys]);

  const filteredConversations = useMemo(() => (
    conversations.filter((conversation) => {
      if (chatFilter === 'unread') return conversation.unreadCount > 0;
      if (activeMemberKeySet) return activeMemberKeySet.has(makeConversationMemberKey(conversation.id));
      return true;
    })
  ), [activeMemberKeySet, chatFilter, conversations]);
  const filteredContactLists = useMemo(() => {
    if (chatFilter === 'unread') return [] as ContactList[];

    const query = search.trim().toLowerCase();
    const filteredByMode = activeMemberKeySet
      ? contactLists.filter((list) => activeMemberKeySet.has(makeBroadcastMemberKey(list.id)))
      : contactLists;

    if (!query) return filteredByMode;

    return filteredByMode.filter((list) => list.name.toLowerCase().includes(query));
  }, [activeMemberKeySet, chatFilter, contactLists, search]);
  const visibleChatCount = filteredConversations.length + filteredContactLists.length;
  const selectedNumber = numbers.find((number) => number.id === selectedPhoneNumberId) || null;
  const selectedNumberWithProfile = selectedNumber as BusinessNumberWithProfile | null;
  const selectedNumberProfileUrl = selectedNumberWithProfile?.profilePictureUrl
    || selectedNumberWithProfile?.profilePicture
    || selectedNumberWithProfile?.avatarUrl
    || null;
  const selectedNumberLabel = selectedNumber?.displayName || businessLabel();
  const filterTargets = useMemo(() => [
    ...conversations.map((conversation) => ({
      key: makeConversationMemberKey(conversation.id),
      title: conversation.contactName,
      subtitle: conversation.contactPhone || conversation.contactWaId,
      kind: 'chat' as const,
    })),
    ...contactLists.map((list) => ({
      key: makeBroadcastMemberKey(list.id),
      title: list.name,
      subtitle: `Broadcast list - ${list.memberCount ?? list.members?.length ?? 0} recipients`,
      kind: 'broadcast' as const,
    })),
  ], [contactLists, conversations]);

  useEffect(() => {
    filterStorageHydratingRef.current = true;
    const stored = loadStoredChatFilters(selectedPhoneNumberId);
    setFavoriteKeys(stored.favoriteKeys);
    setCustomFilters(stored.customFilters);
    setChatFilter('all');
  }, [selectedPhoneNumberId]);

  useEffect(() => {
    if (filterStorageHydratingRef.current) {
      filterStorageHydratingRef.current = false;
      return;
    }

    saveStoredChatFilters(selectedPhoneNumberId, { favoriteKeys, customFilters });
  }, [customFilters, favoriteKeys, selectedPhoneNumberId]);

  useEffect(() => {
    if (search.trim()) {
      setSearchOpen(true);
    }
  }, [search]);

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

  function clearFilterLongPressTimer() {
    if (filterLongPressTimerRef.current) {
      window.clearTimeout(filterLongPressTimerRef.current);
      filterLongPressTimerRef.current = null;
    }
  }

  function openActionDialog(target: ChatActionTarget) {
    clearLongPressTimer();
    setActionTarget(target);
    setConfirmAction(null);
    setActionError('');
  }

  function openFilterEditor(filter?: StoredChatFilter | null) {
    clearFilterLongPressTimer();
    setEditingFilterId(filter?.id || null);
    setFilterName(filter?.name || '');
    setFilterMemberKeys(filter?.memberKeys || []);
    setFilterError('');
    setFilterEditorOpen(true);
  }

  function closeFilterEditor() {
    setFilterEditorOpen(false);
    setEditingFilterId(null);
    setFilterName('');
    setFilterMemberKeys([]);
    setFilterError('');
  }

  function toggleFilterMember(key: ChatFilterMemberKey) {
    setFilterMemberKeys((current) => (
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    ));
  }

  function saveFilterEditor() {
    const name = filterName.trim();
    if (!name) {
      setFilterError('Add a filter name.');
      return;
    }

    if (filterMemberKeys.length === 0) {
      setFilterError('Select at least one chat.');
      return;
    }

    if (editingFilterId) {
      setCustomFilters((current) => current.map((filter) => (
        filter.id === editingFilterId
          ? { ...filter, name, memberKeys: filterMemberKeys }
          : filter
      )));
      setChatFilter(`custom:${editingFilterId}`);
    } else {
      const id = `${Date.now()}`;
      setCustomFilters((current) => [
        ...current,
        {
          id,
          name,
          memberKeys: filterMemberKeys,
          createdAt: new Date().toISOString(),
        },
      ]);
      setChatFilter(`custom:${id}`);
    }

    closeFilterEditor();
  }

  function deleteEditingFilter() {
    if (!editingFilterId) return;

    setCustomFilters((current) => current.filter((filter) => filter.id !== editingFilterId));
    setChatFilter((current) => (current === `custom:${editingFilterId}` ? 'all' : current));
    closeFilterEditor();
  }

  function toggleFavoriteTarget(target: ChatActionTarget) {
    const key = makeMemberKey(target);
    setFavoriteKeys((current) => (
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    ));
  }

  function isFavoriteTarget(target: ChatActionTarget | null) {
    return Boolean(target && favoriteKeys.includes(makeMemberKey(target)));
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

  function handleFilterPressStart(event: PointerEvent<HTMLButtonElement>, filter: StoredChatFilter) {
    if (event.pointerType !== 'touch') return;

    clearFilterLongPressTimer();
    filterLongPressTimerRef.current = window.setTimeout(() => {
      consumedFilterLongPressRef.current = filter.id;
      openFilterEditor(filter);
    }, 600);
  }

  function handleFilterPressEnd() {
    clearFilterLongPressTimer();
  }

  function shouldSkipClick(target: ChatActionTarget) {
    const targetKey = `${target.kind}:${target.id}`;
    if (consumedLongPressRef.current !== targetKey) return false;

    consumedLongPressRef.current = '';
    return true;
  }

  function shouldSkipFilterClick(filterId: string) {
    if (consumedFilterLongPressRef.current !== filterId) return false;

    consumedFilterLongPressRef.current = '';
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

  function runDrawerAction(action: () => void) {
    action();
    setDrawerOpen(false);
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
        <header className="sidebar__toolbar sidebar__toolbar--home">
          <button
            type="button"
            className="toolbar-icon-button sidebar__drawer-trigger"
            onClick={() => setDrawerOpen(true)}
            title="Open menu"
          >
            <Menu size={22} />
          </button>
          <strong className="sidebar__home-title">Jay Jalaram Enterprise</strong>
          <div className="sidebar__toolbar-actions">
            <button
              type="button"
              className={`toolbar-icon-button ${searchOpen ? 'is-active' : ''}`}
              onClick={() => setSearchOpen((current) => !current)}
              title="Search chats"
            >
              <Search size={18} />
            </button>
            <button
              type="button"
              className="toolbar-icon-button"
              onClick={onRefresh}
              title="Refresh"
            >
              <RefreshCw size={18} />
            </button>
          </div>
        </header>

        <div className={`app-drawer ${drawerOpen ? 'is-open' : ''}`} aria-hidden={!drawerOpen}>
          <div className="app-drawer__backdrop" onClick={() => setDrawerOpen(false)} />
          <section className="app-drawer__panel" role="dialog" aria-modal="true" aria-label="JJE menu">
            <header className="app-drawer__profile">
              <button
                type="button"
                className="app-drawer__theme-button"
                onClick={onToggleTheme}
                title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {theme === 'dark' ? <SunMedium size={29} /> : <Moon size={29} />}
              </button>

              <div className="app-drawer__avatar" aria-label="Jay Jalaram Enterprise profile">
                {selectedNumberProfileUrl ? (
                  <img src={selectedNumberProfileUrl} alt="JJE" />
                ) : (
                  <span>JJE</span>
                )}
              </div>

              <div className="app-drawer__profile-copy">
                <strong>{selectedNumberLabel}</strong>
                <span>{selectedNumber?.phoneNumber || 'Select number'}</span>
              </div>

              <button
                type="button"
                className={`app-drawer__account-toggle ${drawerAccountsOpen ? 'is-open' : ''}`}
                onClick={() => setDrawerAccountsOpen((current) => !current)}
                title="Change account"
              >
                <ChevronDown size={25} />
              </button>
            </header>

            {(drawerAccountsOpen || numbers.length > 1) && (
              <div className="app-drawer__accounts" aria-label="Business accounts">
                {numbers.map((number) => (
                <button
                  key={number.id}
                  type="button"
                  className={`app-drawer__account ${number.id === selectedPhoneNumberId ? 'is-active' : ''}`}
                  onClick={() => {
                    onSelectPhoneNumber(number.id);
                    setDrawerAccountsOpen(false);
                  }}
                >
                  <span className="app-drawer__account-avatar">
                    {(number.displayName || businessLabel()).slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    <strong>{number.displayName || businessLabel()}</strong>
                    <small>{number.phoneNumber}</small>
                  </span>
                  {number.id === selectedPhoneNumberId && <Check size={17} />}
                </button>
                ))}
              </div>
            )}

            <nav className="app-drawer__actions" aria-label="App actions">
              <button type="button" onClick={() => runDrawerAction(onOpenStarred)}>
                <Star size={21} />
                <span>Starred messages</span>
              </button>
              <button type="button" onClick={() => runDrawerAction(onComposeCampaign)}>
                <Megaphone size={21} />
                <span>New broadcast</span>
              </button>
              <button type="button" onClick={() => runDrawerAction(onStartChat)}>
                <MessageSquarePlus size={21} />
                <span>Start chat</span>
              </button>
              <button type="button" onClick={() => runDrawerAction(onAddContact)}>
                <UserPlus size={21} />
                <span>Add contact</span>
              </button>
              {currentUser?.role === 'admin' && (
                <button type="button" onClick={() => runDrawerAction(onOpenDevices)}>
                  <ShieldCheck size={21} />
                  <span>Devices</span>
                </button>
              )}
              <button type="button" onClick={() => runDrawerAction(onLogout)}>
                <LogOut size={21} />
                <span>Logout</span>
              </button>
            </nav>
          </section>
        </div>

        {searchOpen && (
          <label className="searchbox">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search or start a new chat"
            />
            {search && (
              <button type="button" onClick={() => onSearchChange('')} title="Clear search">
                <X size={16} />
              </button>
            )}
          </label>
        )}

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
          <button
            type="button"
            className={`sidebar-filter-pill ${chatFilter === 'favorites' ? 'is-active' : ''}`}
            onClick={() => setChatFilter('favorites')}
          >
            Favourites {favoriteKeys.length || ''}
          </button>
          {customFilters.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className={`sidebar-filter-pill ${chatFilter === `custom:${filter.id}` ? 'is-active' : ''}`}
              onClick={() => {
                if (shouldSkipFilterClick(filter.id)) return;
                setChatFilter(`custom:${filter.id}`);
              }}
              onPointerDown={(event) => handleFilterPressStart(event, filter)}
              onPointerUp={handleFilterPressEnd}
              onPointerCancel={handleFilterPressEnd}
              onPointerLeave={handleFilterPressEnd}
              onContextMenu={(event) => {
                event.preventDefault();
                openFilterEditor(filter);
              }}
              title="Long press or right-click to edit"
            >
              {filter.name}
            </button>
          ))}
          <button
            type="button"
            className="sidebar-filter-pill sidebar-filter-pill--icon"
            onClick={() => openFilterEditor()}
            title="Create chat filter"
          >
            <Plus size={18} />
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
                  <div className="conversation-card__top-meta">
                    {favoriteKeys.includes(makeBroadcastMemberKey(list.id)) && (
                      <Star size={13} className="conversation-card__favorite-indicator" />
                    )}
                    <span>{formatTime(list.updatedAt || list.createdAt)}</span>
                  </div>
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
                    {favoriteKeys.includes(makeConversationMemberKey(conversation.id)) && (
                      <Star size={13} className="conversation-card__favorite-indicator" />
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
              <button type="button" onClick={() => actionTarget && toggleFavoriteTarget(actionTarget)}>
                <Star size={18} className={isFavoriteTarget(actionTarget) ? 'is-starred' : ''} />
                <span>{isFavoriteTarget(actionTarget) ? 'Remove from Favourites' : 'Add to Favourites'}</span>
              </button>
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

      <div className={`dialog-layer filter-editor-layer ${filterEditorOpen ? 'is-open' : ''}`} aria-hidden={!filterEditorOpen}>
        <div className="dialog-layer__backdrop" onClick={closeFilterEditor} />
        <section className="filter-editor-dialog frosted-panel" role="dialog" aria-modal="true">
          <header className="filter-editor-dialog__header">
            <div>
              <span className="bottom-sheet__eyebrow">Chat filter</span>
              <h2>{editingFilterId ? 'Edit filter' : 'New filter'}</h2>
              <p>Select chats to show under this filter.</p>
            </div>
            <button type="button" className="toolbar-icon-button" onClick={closeFilterEditor} title="Close">
              <X size={18} />
            </button>
          </header>

          <div className="filter-editor-dialog__body">
            <label className="filter-editor-name">
              <span>Filter name</span>
              <input
                value={filterName}
                onChange={(event) => setFilterName(event.target.value)}
                placeholder="Example: Dealers"
              />
            </label>

            <div className="filter-editor-summary">
              <strong>{filterMemberKeys.length}</strong>
              <span>selected chats</span>
            </div>

            {filterError && <div className="form-error">{filterError}</div>}

            <div className="filter-editor-list">
              {filterTargets.map((target) => {
                const selected = filterMemberKeys.includes(target.key);

                return (
                  <button
                    key={target.key}
                    type="button"
                    className={`filter-editor-row ${selected ? 'is-selected' : ''}`}
                    onClick={() => toggleFilterMember(target.key)}
                  >
                    <span className={`contact-picker-row__checkbox ${selected ? 'is-selected' : ''}`}>
                      {selected ? <Check size={14} /> : null}
                    </span>
                    <span className={`conversation-card__avatar ${target.kind === 'broadcast' ? 'conversation-card__avatar--broadcast' : ''}`}>
                      {target.kind === 'broadcast' ? <Megaphone size={16} /> : target.title.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="filter-editor-row__copy">
                      <strong>{target.title}</strong>
                      <span>{target.subtitle}</span>
                    </span>
                  </button>
                );
              })}

              {filterTargets.length === 0 && (
                <div className="contact-picker-list__state">No chats available yet.</div>
              )}
            </div>
          </div>

          <footer className="filter-editor-dialog__footer">
            {editingFilterId && (
              <button type="button" className="ghost-button ghost-button--danger" onClick={deleteEditingFilter}>
                Delete filter
              </button>
            )}
            <span className="filter-editor-dialog__footer-spacer" />
            <button type="button" className="ghost-button" onClick={closeFilterEditor}>
              Cancel
            </button>
            <button type="button" className="primary-button" onClick={saveFilterEditor}>
              Save
            </button>
          </footer>
        </section>
      </div>
    </aside>
  );
}
