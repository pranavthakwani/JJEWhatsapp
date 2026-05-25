import { Check, Search, UserPlus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createContact, listContacts } from '../lib/api';
import type { Contact } from '../types';

const CONTACT_FETCH_LIMIT = 50000;

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
  const [startingId, setStartingId] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;

    setSearch('');
    setError('');
    setLoading(true);
    void listContacts('', CONTACT_FETCH_LIMIT)
      .then(setContacts)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Failed to load contacts'))
      .finally(() => setLoading(false));
  }, [open]);

  const visibleContacts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return contacts;

    return contacts.filter((contact) => [
      contact.profileName,
      contact.businessDirectoryName,
      contact.phoneNumber,
      contact.waId,
    ].filter(Boolean).join(' ').toLowerCase().includes(query));
  }, [contacts, search]);

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

          <div className="contact-dialog__list">
            {loading && <ContactRowsSkeleton />}

            {!loading && visibleContacts.map((contact) => (
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

            {!loading && visibleContacts.length === 0 && (
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
