import { Check, Search, UserPlus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UIEvent } from 'react';
import { createContact, listContactsPage } from '../lib/api';
import type { Contact } from '../types';

const CONTACT_FETCH_LIMIT = 300;

type StartChatDialogProps = {
  open: boolean;
  onClose: () => void;
  onStartChat: (contact: Contact) => Promise<void>;
};

type AddContactDialogProps = {
  open: boolean;
  onClose: () => void;
  onContactCreated: (contact: Contact) => Promise<void>;
};

function getContactName(contact: Contact) {
  return contact.profileName || contact.businessDirectoryName || contact.phoneNumber || contact.waId;
}

function isAlphabeticContact(contact: Contact) {
  return /^[a-z]/i.test(getContactName(contact).trim());
}

function compareContacts(left: Contact, right: Contact) {
  const leftName = getContactName(left).trim();
  const rightName = getContactName(right).trim();
  const leftIsAlpha = isAlphabeticContact(left);
  const rightIsAlpha = isAlphabeticContact(right);

  if (leftIsAlpha !== rightIsAlpha) {
    return leftIsAlpha ? -1 : 1;
  }

  const nameCompare = leftName.localeCompare(rightName, 'en', {
    numeric: true,
    sensitivity: 'base',
  });

  if (nameCompare !== 0) return nameCompare;
  return left.waId.localeCompare(right.waId, 'en', { numeric: true });
}

function mergeContacts(existingContacts: Contact[], nextContacts: Contact[]) {
  const byId = new Map<number, Contact>();
  existingContacts.forEach((contact) => byId.set(contact.id, contact));
  nextContacts.forEach((contact) => byId.set(contact.id, contact));
  return Array.from(byId.values()).sort(compareContacts);
}

function ContactRowsSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="skeleton-list" aria-label="Loading contacts">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="start-chat-row skeleton-contact-row">
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

export function StartChatDialog({ open, onClose, onStartChat }: StartChatDialogProps) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);
  const lastLoadedSearchRef = useRef('');
  const justOpenedRef = useRef(false);
  const pageLoadingRef = useRef(false);

  const loadContacts = useCallback(async (query: string, cursor: string | null, reset: boolean) => {
    if (!reset && pageLoadingRef.current) return;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    pageLoadingRef.current = true;

    if (reset) {
      setContacts([]);
      setNextCursor(null);
      setLoading(true);
      setLoadingMore(false);
    } else {
      setLoadingMore(true);
    }

    setError('');

    try {
      const page = await listContactsPage(query, CONTACT_FETCH_LIMIT, cursor);
      if (requestId !== requestIdRef.current) return;

      lastLoadedSearchRef.current = query;
      setContacts((currentContacts) => (
        reset ? [...page.items].sort(compareContacts) : mergeContacts(currentContacts, page.items)
      ));
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setError(loadError instanceof Error ? loadError.message : 'Failed to load contacts');
    } finally {
      if (requestId !== requestIdRef.current) return;
      pageLoadingRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    justOpenedRef.current = true;
    setSearch('');
    setError('');
    lastLoadedSearchRef.current = '';
    void loadContacts('', null, true);
  }, [loadContacts, open]);

  useEffect(() => {
    if (!open) return;
    if (justOpenedRef.current) {
      justOpenedRef.current = false;
      return;
    }

    const query = search.trim();
    if (query === lastLoadedSearchRef.current) return;

    const debounce = window.setTimeout(() => {
      void loadContacts(query, null, true);
    }, query ? 220 : 0);

    return () => window.clearTimeout(debounce);
  }, [loadContacts, open, search]);

  async function handleStart(contact: Contact) {
    setStartingId(contact.id);
    setError('');

    try {
      await onStartChat(contact);
      onClose();
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Failed to start chat');
    } finally {
      setStartingId(null);
    }
  }

  function handleContactListScroll(event: UIEvent<HTMLDivElement>) {
    if (loading || loadingMore || !nextCursor) return;

    const target = event.currentTarget;
    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (distanceToBottom > 180) return;

    void loadContacts(lastLoadedSearchRef.current, nextCursor, false);
  }

  return (
    <div className={`dialog-layer ${open ? 'is-open' : ''}`} aria-hidden={!open}>
      <div className="dialog-layer__backdrop" onClick={onClose} />
      <section className="contact-dialog frosted-panel" role="dialog" aria-modal="true">
        <header className="contact-dialog__header">
          <div>
            <span className="bottom-sheet__eyebrow">New chat</span>
            <h2>Start chat</h2>
          </div>
          <button type="button" className="toolbar-icon-button" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </header>

        <div className="contact-dialog__body">
          <label className="contact-search-input">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search saved contacts"
            />
          </label>

          {error && <div className="form-error">{error}</div>}

          <div className="contact-dialog__list" onScroll={handleContactListScroll}>
            {loading && contacts.length === 0 && <ContactRowsSkeleton />}

            {contacts.map((contact) => (
              <button
                key={contact.id}
                type="button"
                className="start-chat-row"
                onClick={() => void handleStart(contact)}
                disabled={startingId === contact.id}
              >
                <span className="recipient-avatar">{getContactName(contact).slice(0, 1).toUpperCase()}</span>
                <span className="start-chat-row__copy">
                  <strong>{getContactName(contact)}</strong>
                  <span>{contact.phoneNumber || contact.waId}</span>
                </span>
                <span className={`contact-optin-badge contact-optin-badge--${contact.optInStatus || 'unknown'}`}>
                  {contact.optInStatus === 'opted_in' ? 'Opted in' : 'Not opted in'}
                </span>
              </button>
            ))}

            {loadingMore && <ContactRowsSkeleton count={4} />}

            {!loading && contacts.length === 0 && (
              <div className="contact-picker-list__state">No contacts found.</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

export function AddContactDialog({ open, onClose, onContactCreated }: AddContactDialogProps) {
  const [countryCode, setCountryCode] = useState('91');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setCountryCode('91');
    setPhoneNumber('');
    setName('');
    setError('');
  }, [open]);

  const canSave = phoneNumber.replace(/\D/g, '').length >= 7 && name.trim().length > 0;

  async function handleSave() {
    if (!canSave || saving) return;

    setSaving(true);
    setError('');

    try {
      const contact = await createContact({
        countryCode,
        phoneNumber,
        name: name.trim(),
      });
      await onContactCreated(contact);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save contact');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`dialog-layer ${open ? 'is-open' : ''}`} aria-hidden={!open}>
      <div className="dialog-layer__backdrop" onClick={onClose} />
      <section className="contact-dialog contact-dialog--compact frosted-panel" role="dialog" aria-modal="true">
        <header className="contact-dialog__header">
          <div>
            <span className="bottom-sheet__eyebrow">Saved contact</span>
            <h2>Add contact</h2>
          </div>
          <button type="button" className="toolbar-icon-button" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </header>

        <div className="contact-dialog__body">
          <label>
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Customer name"
            />
          </label>

          <div className="phone-input-grid">
            <label>
              <span>Country</span>
              <select value={countryCode} onChange={(event) => setCountryCode(event.target.value)}>
                <option value="91">IN +91</option>
                <option value="1">US +1</option>
                <option value="44">UK +44</option>
                <option value="971">AE +971</option>
              </select>
            </label>

            <label>
              <span>Phone number</span>
              <input
                value={phoneNumber}
                onChange={(event) => setPhoneNumber(event.target.value)}
                placeholder="98765 43210"
                inputMode="tel"
              />
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}
        </div>

        <footer className="contact-dialog__footer">
          <button type="button" className="ghost-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary-button" onClick={() => void handleSave()} disabled={!canSave || saving}>
            {saving ? <Check size={16} /> : <UserPlus size={16} />}
            {saving ? 'Saving...' : 'Save and start chat'}
          </button>
        </footer>
      </section>
    </div>
  );
}
