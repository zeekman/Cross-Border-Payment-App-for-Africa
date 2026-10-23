import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { truncateAddress } from '../../utils/currency';
import api from '../../utils/api';
import ImportContactsModal from '../ImportContactsModal';

export default function ContactsSection() {
  const { t } = useTranslation();

  const [contacts, setContacts] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(true);
  const [showAddContact, setShowAddContact] = useState(false);
  const [showImportContacts, setShowImportContacts] = useState(false);
  const [newContact, setNewContact] = useState({
    name: '',
    wallet_address: '',
    notes: '',
    memo_required: false,
    default_memo: '',
    tags: '',
  });
  const [tagFilter, setTagFilter] = useState('');

  const [deleteContactPending, setDeleteContactPending] = useState(null); // { id, name }

  const addContact = async (e) => {
    e.preventDefault();
    try {
      const tags = newContact.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const res = await api.post('/contacts', { ...newContact, tags });
      setContacts([...contacts, res.data.contact]);
      setNewContact({
        name: '',
        wallet_address: '',
        notes: '',
        memo_required: false,
        default_memo: '',
        tags: '',
      });
      setShowAddContact(false);
      toast.success(t('profile.contact_added'));
    } catch {
      toast.error(t('profile.contact_error'));
    }
  };

  const deleteContact = async () => {
    const { id } = deleteContactPending;
    setDeleteContactPending(null);
    try {
      await api.delete(`/contacts/${id}`);
      setContacts(contacts.filter((c) => c.id !== id));
      toast.success('Contact deleted');
    } catch {
      toast.error('Failed to delete contact');
    }
  };

  React.useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/contacts');
        setContacts(res.data.contacts || []);
      } catch {
        toast.error('Failed to load contacts');
      } finally {
        setContactsLoading(false);
      }
    })();
  }, []);

  return (
    <>
      {/* Contacts */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-white">{t('profile.frequent_contacts')}</h3>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowImportContacts(true)}
              className="text-primary-500 hover:text-primary-400 text-sm"
            >
              {t('contacts_import.open')}
            </button>
            <button
              onClick={() => setShowAddContact(!showAddContact)}
              className="text-primary-500 hover:text-primary-400 flex items-center gap-1 text-sm"
            >
              <Plus size={16} /> {t('common.add')}
            </button>
          </div>
        </div>

        <ImportContactsModal
          isOpen={showImportContacts}
          onClose={() => setShowImportContacts(false)}
          onImported={() =>
            api
              .get('/wallet/contacts')
              .then((res) => setContacts(res.data.contacts || []))
              .catch(() => {})
          }
        />

        {showAddContact && (
          <form onSubmit={addContact} className="mb-4 space-y-2 bg-gray-800 rounded-xl p-3">
            <input
              type="text"
              required
              placeholder={t('profile.contact_name_placeholder')}
              value={newContact.name}
              onChange={(e) => setNewContact({ ...newContact, name: e.target.value })}
              className="w-full bg-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            <input
              type="text"
              required
              placeholder={t('profile.contact_address_placeholder')}
              value={newContact.wallet_address}
              onChange={(e) => setNewContact({ ...newContact, wallet_address: e.target.value })}
              className="w-full bg-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 font-mono focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            <textarea
              placeholder="Notes (optional)"
              value={newContact.notes}
              onChange={(e) => setNewContact({ ...newContact, notes: e.target.value })}
              rows={2}
              maxLength={500}
              className="w-full bg-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-primary-500 resize-none"
            />
            <input
              type="text"
              placeholder="Default memo (optional)"
              value={newContact.default_memo}
              onChange={(e) => setNewContact({ ...newContact, default_memo: e.target.value })}
              maxLength={64}
              className="w-full bg-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 font-mono focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            <input
              type="text"
              placeholder="Tags (comma-separated, e.g. business,exchange)"
              value={newContact.tags}
              onChange={(e) => setNewContact({ ...newContact, tags: e.target.value })}
              className="w-full bg-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={newContact.memo_required}
                onChange={(e) => setNewContact({ ...newContact, memo_required: e.target.checked })}
                className="accent-primary-500"
              />
              Memo required for this contact
            </label>
            <button
              type="submit"
              className="w-full bg-primary-500 text-white text-sm py-2 rounded-lg hover:bg-primary-600 transition-colors"
            >
              {t('common.save')}
            </button>
          </form>
        )}

        {/* Tag filter */}
        {contacts.length > 0 && (
          <div className="flex gap-2 flex-wrap mb-3">
            {['', ...Array.from(new Set(contacts.flatMap((c) => c.tags || [])))].map((tag) => (
              <button
                key={tag || '__all__'}
                onClick={() => setTagFilter(tag)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  tagFilter === tag
                    ? 'border-primary-500 text-primary-400 bg-primary-500/10'
                    : 'border-gray-700 text-gray-400 hover:border-gray-500'
                }`}
              >
                {tag || 'All'}
              </button>
            ))}
          </div>
        )}

        {contactsLoading ? (
          <p className="text-gray-500 text-sm text-center py-4" data-testid="contacts-loading">
            Loading…
          </p>
        ) : contacts.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">{t('profile.no_contacts')}</p>
        ) : (
          <div className="space-y-2" data-testid="contacts-list">
            {contacts
              .filter((c) => !tagFilter || (c.tags || []).includes(tagFilter))
              .map((c) => (
                <div key={c.id} className="flex items-center gap-3 group">
                  <div className="w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center text-sm font-semibold text-white">
                    {c.name?.[0]?.toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-medium">{c.name}</p>
                    <p className="text-xs text-gray-500 font-mono truncate">
                      {truncateAddress(c.wallet_address)}
                    </p>
                    {c.default_memo && (
                      <p className="text-xs text-gray-500">
                        Memo: <span className="font-mono">{c.default_memo}</span>
                      </p>
                    )}
                    {c.tags?.length > 0 && (
                      <div className="flex gap-1 flex-wrap mt-0.5">
                        {c.tags.map((tag) => (
                          <span
                            key={tag}
                            className="text-xs bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded-full"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => setDeleteContactPending({ id: c.id, name: c.name })}
                    className="p-1.5 text-gray-500 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                    aria-label="Delete contact"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
          </div>
        )}
      </div>
      {/* Delete contact confirmation dialog */}
      {deleteContactPending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="bg-gray-900 rounded-2xl p-6 w-full max-w-sm space-y-4">
            <p className="text-white font-semibold text-base">
              Delete {deleteContactPending.name}?
            </p>
            <p className="text-gray-400 text-sm">This cannot be undone.</p>
            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setDeleteContactPending(null)}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium py-2.5 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={deleteContact}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold py-2.5 rounded-xl transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
