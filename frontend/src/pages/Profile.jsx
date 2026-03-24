import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, User, Mail, Phone, Wallet, Copy, CheckCheck, Plus, Globe, Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { truncateAddress } from '../utils/currency';
import api from '../utils/api';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'sw', label: 'Kiswahili' },
  { code: 'fr', label: 'Français' },
  { code: 'ha', label: 'Hausa' },
];

export default function Profile() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [contacts, setContacts] = useState([]);
  const [showAddContact, setShowAddContact] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', wallet_address: '' });

  React.useEffect(() => {
    const fetchContacts = async () => {
      try {
        const res = await api.get('/wallet/contacts');
        setContacts(res.data.contacts || []);
      } catch {
        toast.error('Failed to load contacts');
      }
    };
    fetchContacts();
  }, []);

  const copyAddress = () => {
    navigator.clipboard.writeText(user?.wallet_address || '');
    setCopied(true);
    toast.success(t('profile.address_copied'));
    setTimeout(() => setCopied(false), 2000);
  };

  const handleLogout = () => { logout(); navigate('/'); };

  const addContact = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/wallet/contacts', newContact);
      setContacts([...contacts, res.data.contact]);
      setNewContact({ name: '', wallet_address: '' });
      setShowAddContact(false);
      toast.success(t('profile.contact_added'));
    } catch {
      toast.error(t('profile.contact_error'));
    }
  };

  const deleteContact = async (id) => {
    if (!window.confirm('Are you sure you want to delete this contact?')) return;
    try {
      await api.delete(`/wallet/contacts/${id}`);
      setContacts(contacts.filter(c => c.id !== id));
      toast.success('Contact deleted');
    } catch {
      toast.error('Failed to delete contact');
    }
  const changeLanguage = (code) => {
    i18n.changeLanguage(code);
    localStorage.setItem('afripay_lang', code);
  };

  return (
    <div className="px-4 py-6 max-w-lg mx-auto space-y-6">
      <h2 className="text-2xl font-bold text-white">{t('profile.title')}</h2>

      {/* User info card */}
      <div className="bg-gray-900 rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 bg-primary-500 rounded-full flex items-center justify-center text-2xl font-bold text-white">
            {user?.full_name?.[0]?.toUpperCase()}
          </div>
          <div>
            <p className="font-semibold text-white text-lg">{user?.full_name}</p>
            <p className="text-gray-400 text-sm">{t('profile.member')}</p>
          </div>
        </div>

        <div className="space-y-3 pt-2 border-t border-gray-800">
          <div className="flex items-center gap-3 text-sm">
            <Mail size={16} className="text-gray-500 shrink-0" />
            <span className="text-gray-300">{user?.email}</span>
          </div>
          {user?.phone && (
            <div className="flex items-center gap-3 text-sm">
              <Phone size={16} className="text-gray-500 shrink-0" />
              <span className="text-gray-300">{user?.phone}</span>
            </div>
          )}
          <div className="flex items-center gap-3 text-sm">
            <Wallet size={16} className="text-gray-500 shrink-0" />
            <span className="text-gray-300 font-mono flex-1 truncate">{truncateAddress(user?.wallet_address, 12)}</span>
            <button onClick={copyAddress} className="text-gray-400 hover:text-primary-400 shrink-0">
              {copied ? <CheckCheck size={14} className="text-primary-500" /> : <Copy size={14} />}
            </button>
          </div>
        </div>
      </div>

      {/* Language selector */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <Globe size={16} className="text-gray-500" />
          <h3 className="font-semibold text-white">{t('profile.language')}</h3>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {LANGUAGES.map(lang => (
            <button
              key={lang.code}
              onClick={() => changeLanguage(lang.code)}
              className={`py-2.5 px-4 rounded-xl text-sm font-medium transition-colors ${
                i18n.language === lang.code
                  ? 'bg-primary-500 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}
            >
              {lang.label}
            </button>
          ))}
        </div>
      </div>

      {/* Contacts */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-white">{t('profile.frequent_contacts')}</h3>
          <button onClick={() => setShowAddContact(!showAddContact)}
            className="text-primary-500 hover:text-primary-400 flex items-center gap-1 text-sm">
            <Plus size={16} /> {t('common.add')}
          </button>
        </div>

        {showAddContact && (
          <form onSubmit={addContact} className="mb-4 space-y-2 bg-gray-800 rounded-xl p-3">
            <input
              type="text"
              required
              placeholder={t('profile.contact_name_placeholder')}
              value={newContact.name}
              onChange={e => setNewContact({ ...newContact, name: e.target.value })}
              className="w-full bg-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            <input
              type="text"
              required
              placeholder={t('profile.contact_address_placeholder')}
              value={newContact.wallet_address}
              onChange={e => setNewContact({ ...newContact, wallet_address: e.target.value })}
              className="w-full bg-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 font-mono focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            <button type="submit" className="w-full bg-primary-500 text-white text-sm py-2 rounded-lg hover:bg-primary-600 transition-colors">
              {t('common.save')}
            </button>
          </form>
        )}

        {contacts.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">{t('profile.no_contacts')}</p>
        ) : (
          <div className="space-y-2" data-testid="contacts-list">
            {contacts.map(c => (
              <div key={c.id} className="flex items-center gap-3 group">
                <div className="w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center text-sm font-semibold text-white">
                  {c.name?.[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white font-medium">{c.name}</p>
                  <p className="text-xs text-gray-500 font-mono truncate">{truncateAddress(c.wallet_address)}</p>
                </div>
                <button
                  onClick={() => deleteContact(c.id)}
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

      {/* Logout */}
      <button
        onClick={handleLogout}
        className="w-full bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-colors"
      >
        <LogOut size={18} /> {t('common.sign_out')}
      </button>
    </div>
  );
}
