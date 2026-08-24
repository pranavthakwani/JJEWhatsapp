import { ChevronDown, Contact as ContactIcon, Loader2, MessageCircleMore, Pencil, Plus, RefreshCw, Search, UserRound } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useState } from 'react';
import { listContactsPage, renameContact } from '../lib/api';
import type { Contact } from '../types';

type Props = {
  onAddContact: () => void;
  onStartConversation: (contact: Contact) => Promise<void>;
};

function contactName(contact: Contact) {
  return contact.businessDirectoryName || contact.profileName || contact.phoneNumber || contact.waId;
}

export function ContactsWorkspace({ onAddContact, onStartConversation }: Props) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const deferredQuery = useDeferredValue(query);

  const load = useCallback(async (append = false) => {
    if (append) setLoadingMore(true); else setLoading(true);
    setError('');
    try {
      const page = await listContactsPage(deferredQuery, 100, append ? cursor : null);
      setContacts((current) => append ? [...current, ...page.items] : page.items);
      setCursor(page.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Contacts could not be loaded.');
    } finally {
      setLoading(false); setLoadingMore(false);
    }
  }, [cursor, deferredQuery]);

  useEffect(() => { void load(false); }, [deferredQuery]);

  async function saveName(contact: Contact) {
    const value = editingName.trim();
    if (!value) return;
    try {
      const updated = await renameContact(contact.id, value);
      setContacts((current) => current.map((item) => item.id === updated.id ? updated : item));
      setEditingId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Contact could not be renamed.');
    }
  }

  return (
    <section className="crm-module contacts-workspace">
      <header className="crm-module-header">
        <div><span className="crm-eyebrow">Customer directory</span><h1>Contacts</h1><p>One shared directory for conversations, broadcasts, and lead intelligence.</p></div>
        <div className="crm-header-actions"><button type="button" className="crm-icon-button" onClick={() => void load(false)} title="Refresh"><RefreshCw size={17} /></button><button type="button" className="crm-primary-button" onClick={onAddContact}><Plus size={17} /> Add contact</button></div>
      </header>
      <div className="crm-module-toolbar">
        <label className="crm-search-control"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or phone number" /></label>
        <span className="crm-result-count">{contacts.length.toLocaleString('en-IN')} loaded</span>
      </div>
      {error && <div className="crm-inline-error">{error}</div>}
      <div className="crm-table-wrap">
        <table className="crm-data-table contacts-table">
          <thead><tr><th>Contact</th><th>Phone</th><th>Opt-in</th><th>Last activity</th><th className="crm-table-actions">Actions</th></tr></thead>
          <tbody>
            {loading ? Array.from({ length: 9 }).map((_, index) => <tr className="crm-skeleton-row" key={index}><td><span /></td><td><span /></td><td><span /></td><td><span /></td><td /></tr>) : contacts.map((contact) => (
              <tr key={contact.id}>
                <td><div className="crm-person-cell"><span className="crm-avatar"><UserRound size={17} /></span><div>{editingId === contact.id ? <form onSubmit={(event) => { event.preventDefault(); void saveName(contact); }}><input autoFocus value={editingName} onChange={(event) => setEditingName(event.target.value)} onBlur={() => setEditingId(null)} /></form> : <><strong>{contactName(contact)}</strong><small>{contact.profileName && contact.businessDirectoryName ? `WhatsApp: ${contact.profileName}` : `ID ${contact.id}`}</small></>}</div></div></td>
                <td><span className="crm-mono">{contact.phoneNumber || contact.waId}</span></td>
                <td><span className={`crm-status crm-status--${contact.optInStatus}`}><i />{contact.optInStatus.replace('_', ' ')}</span></td>
                <td>{contact.lastInboundAt || contact.lastOutboundAt ? new Date(contact.lastInboundAt || contact.lastOutboundAt || '').toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'No activity'}</td>
                <td className="crm-table-actions"><button type="button" title="Rename" onClick={() => { setEditingId(contact.id); setEditingName(contactName(contact)); }}><Pencil size={15} /></button><button type="button" title="Open conversation" onClick={() => void onStartConversation(contact)}><MessageCircleMore size={16} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && contacts.length === 0 && <div className="crm-empty-state"><ContactIcon size={28} /><h2>No contacts found</h2><p>Try another search or add a new customer.</p></div>}
      </div>
      {cursor && <button type="button" className="crm-load-more" disabled={loadingMore} onClick={() => void load(true)}>{loadingMore ? <Loader2 className="is-spinning" size={16} /> : <ChevronDown size={16} />} Load more contacts</button>}
    </section>
  );
}
