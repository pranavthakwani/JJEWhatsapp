import { Check, Search, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createContactList, listContacts } from '../lib/api';
import type { BusinessNumber, Contact, ContactList } from '../types';

type RecipientDraft = {
  key: string;
  waId: string;
  name: string | null;
  phoneNumber?: string | null;
  contactId?: number | null;
  businessDirectoryName?: string | null;
};

type Props = {
  open: boolean;
  numbers: BusinessNumber[];
  defaultPhoneNumberId: number | null;
  onClose: () => void;
  onCreateContactList: (payload: { phoneNumberId: number; list: ContactList }) => Promise<void>;
};

const CONTACT_FETCH_LIMIT = 50000;

function businessLabel() {
  return 'Jay Jalaram Enterprise';
}

function ContactRowsSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div className="skeleton-list" aria-label="Loading contacts">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="contact-picker-row skeleton-contact-row">
          <span className="skeleton-checkbox" />
          <span className="skeleton-contact-row__copy">
            <span className="skeleton-line skeleton-line--medium" />
            <span className="skeleton-line skeleton-line--short" />
          </span>
        </div>
      ))}
    </div>
  );
}

function normalizeDigits(value: string) {
  return value.replace(/\D/g, '');
}

function dedupeRecipients(items: RecipientDraft[]) {
  const byWaId = new Map<string, RecipientDraft>();

  for (const item of items) {
    const waId = normalizeDigits(item.waId || item.phoneNumber || '');
    if (!waId) continue;

    byWaId.set(waId, {
      ...item,
      waId,
    });
  }

  return [...byWaId.values()];
}

function getContactName(contact: Contact) {
  return contact.profileName || contact.businessDirectoryName || contact.phoneNumber || contact.waId;
}

function buildContactRecipient(contact: Contact): RecipientDraft {
  return {
    key: `contact:${contact.id}`,
    waId: contact.waId,
    name: contact.profileName || contact.businessDirectoryName || null,
    phoneNumber: contact.phoneNumber,
    contactId: contact.id,
    businessDirectoryName: contact.businessDirectoryName,
  };
}

export function CampaignComposer({
  open,
  numbers,
  defaultPhoneNumberId,
  onClose,
  onCreateContactList,
}: Props) {
  const [phoneNumberId, setPhoneNumberId] = useState<number | null>(defaultPhoneNumberId);
  const [listName, setListName] = useState('');
  const [contactSearch, setContactSearch] = useState('');
  const [allContacts, setAllContacts] = useState<Contact[]>([]);
  const [selectedRecipients, setSelectedRecipients] = useState<RecipientDraft[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [savingList, setSavingList] = useState(false);
  const [error, setError] = useState('');

  async function loadContacts() {
    setLoadingContacts(true);
    try {
      setAllContacts(await listContacts('', CONTACT_FETCH_LIMIT));
    } finally {
      setLoadingContacts(false);
    }
  }

  useEffect(() => {
    if (!open) return;

    setPhoneNumberId(defaultPhoneNumberId);
    setListName('');
    setContactSearch('');
    setSelectedRecipients([]);
    setError('');

    void loadContacts().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load contacts');
    });
  }, [defaultPhoneNumberId, open]);

  const visibleContacts = useMemo(() => {
    const query = contactSearch.trim().toLowerCase();
    if (!query) return allContacts;

    return allContacts.filter((contact) => {
      const candidate = [
        contact.profileName,
        contact.businessDirectoryName,
        contact.phoneNumber,
        contact.waId,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return candidate.includes(query);
    });
  }, [allContacts, contactSearch]);

  const selectedWaIds = useMemo(
    () => new Set(selectedRecipients.map((recipient) => recipient.waId)),
    [selectedRecipients],
  );

  const allVisibleSelected = useMemo(
    () => visibleContacts.length > 0 && visibleContacts.every((contact) => selectedWaIds.has(contact.waId)),
    [selectedWaIds, visibleContacts],
  );

  const canCreate = Boolean(phoneNumberId && listName.trim() && selectedRecipients.length > 0);

  function toggleContact(contact: Contact) {
    const recipient = buildContactRecipient(contact);

    setSelectedRecipients((current) => (
      current.some((item) => item.waId === recipient.waId)
        ? current.filter((item) => item.waId !== recipient.waId)
        : dedupeRecipients([...current, recipient])
    ));
  }

  function toggleVisibleContacts() {
    if (allVisibleSelected) {
      const visibleWaIds = new Set(visibleContacts.map((contact) => contact.waId));
      setSelectedRecipients((current) => current.filter((recipient) => !visibleWaIds.has(recipient.waId)));
      return;
    }

    setSelectedRecipients((current) => dedupeRecipients([
      ...current,
      ...visibleContacts.map(buildContactRecipient),
    ]));
  }

  async function handleCreateList() {
    if (!phoneNumberId || !listName.trim() || selectedRecipients.length === 0) return;

    setSavingList(true);
    setError('');

    try {
      const created = await createContactList({
        phoneNumberId,
        name: listName.trim(),
        source: 'manual',
        contacts: selectedRecipients.map((recipient) => ({
          contactId: recipient.contactId || null,
          waId: recipient.waId,
          phoneNumber: recipient.phoneNumber || recipient.waId,
          profileName: recipient.name,
          name: recipient.name,
          businessDirectoryName: recipient.businessDirectoryName,
        })),
      });

      await onCreateContactList({
        phoneNumberId,
        list: created,
      });

      onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create broadcast list');
    } finally {
      setSavingList(false);
    }
  }

  return (
    <div className={`campaign-drawer ${open ? 'is-open' : ''}`}>
      <div className="campaign-drawer__panel campaign-drawer__panel--simple">
        <header className="campaign-drawer__header">
          <div>
            <h2>New broadcast</h2>
            <p className="form-hint">Select saved contacts and create a WhatsApp-style broadcast list.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="campaign-drawer__body">
          <div className={numbers.length > 1 ? 'form-grid' : ''}>
            {numbers.length > 1 && (
              <label>
                <span>From</span>
                <select value={phoneNumberId ?? ''} onChange={(event) => setPhoneNumberId(Number(event.target.value))}>
                  {numbers.map((number) => (
                    <option key={number.id} value={number.id}>
                      {businessLabel()} ({number.phoneNumber})
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label>
              <span>List name</span>
              <input
                value={listName}
                onChange={(event) => setListName(event.target.value)}
                placeholder="Broadcast list name"
              />
            </label>
          </div>

          <div className="broadcast-contact-summary">
            <strong>{selectedRecipients.length}</strong>
            <span>selected from {allContacts.length} contacts</span>
          </div>

          <label>
            <span>Contacts</span>
            <div className="contact-search-input">
              <Search size={16} />
              <input
                value={contactSearch}
                onChange={(event) => setContactSearch(event.target.value)}
                placeholder="Search name or number"
              />
            </div>
          </label>

          <div className="contact-picker-toolbar">
            <span>{visibleContacts.length} contacts</span>
            <div className="contact-picker-toolbar__actions">
              <button type="button" className="ghost-button" onClick={toggleVisibleContacts} disabled={visibleContacts.length === 0}>
                {allVisibleSelected ? 'Clear visible' : 'Select visible'}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setSelectedRecipients([])}
                disabled={selectedRecipients.length === 0}
              >
                Clear
              </button>
            </div>
          </div>

          <div className="contact-picker-list contact-picker-list--broadcast">
            {loadingContacts && <ContactRowsSkeleton />}

            {!loadingContacts && visibleContacts.length === 0 && (
              <div className="contact-picker-list__state">
                <span>No contacts found.</span>
              </div>
            )}

            {!loadingContacts && visibleContacts.map((contact) => {
              const isSelected = selectedWaIds.has(contact.waId);

              return (
                <button
                  key={contact.id}
                  type="button"
                  className={`contact-picker-row ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => toggleContact(contact)}
                >
                  <span className={`contact-picker-row__checkbox ${isSelected ? 'is-selected' : ''}`}>
                    {isSelected ? <Check size={14} /> : null}
                  </span>

                  <span className="contact-picker-row__meta">
                    <strong>{getContactName(contact)}</strong>
                    <span>{contact.phoneNumber || contact.waId}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <footer className="campaign-drawer__footer">
          <button type="button" className="ghost-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary-button" onClick={() => void handleCreateList()} disabled={!canCreate || savingList}>
            <Users size={16} />
            {savingList ? 'Creating...' : 'Create broadcast'}
          </button>
        </footer>
      </div>
    </div>
  );
}
