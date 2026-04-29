import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { LogOut, User, Mail, Phone, Wallet, Copy, CheckCheck, Plus, Globe, Trash2, ShieldAlert, Eye, EyeOff, Activity, AlertTriangle, Building2, Coins, Gift, Shield, Key, AlertCircle } from 'lucide-react';
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
  const [contactsLoading, setContactsLoading] = useState(true);
  const [showAddContact, setShowAddContact] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', wallet_address: '', notes: '', memo_required: false, default_memo: '', tags: '' });
  const [tagFilter, setTagFilter] = useState('');
  const [showBackup, setShowBackup] = useState(false);
  const [backupPassword, setBackupPassword] = useState('');
  const [exportedKey, setExportedKey] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const [activity, setActivity] = useState([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [trustlines, setTrustlines] = useState([]);
  const [newAsset, setNewAsset] = useState('');
  const [trustlineLoading, setTrustlineLoading] = useState(false);
  const [deleteContactPending, setDeleteContactPending] = useState(null); // { id, name }
  const [showCloseAccount, setShowCloseAccount] = useState(false);
  const [closeDestination, setCloseDestination] = useState('');
  const [closePassword, setClosePassword] = useState('');
  const [closeLoading, setCloseLoading] = useState(false);

  // Horizon history import state (issue #130)
  const [importingHistory, setImportingHistory] = useState(false);

  // Change email state (issue #301)
  const [showChangeEmail, setShowChangeEmail] = useState(false);
  const [changeEmailForm, setChangeEmailForm] = useState({ new_email: '', password: '' });
  const [changeEmailLoading, setChangeEmailLoading] = useState(false);

  const handleChangeEmail = async (e) => {
    e.preventDefault();
    setChangeEmailLoading(true);
    try {
      await api.post('/auth/change-email', changeEmailForm);
      toast.success('Verification email sent. Check your inbox to confirm the change.');
      setShowChangeEmail(false);
      setChangeEmailForm({ new_email: '', password: '' });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to request email change');
    } finally {
      setChangeEmailLoading(false);
    }
  };

  const handleImportHistory = async () => {
    setImportingHistory(true);
    try {
      const res = await api.post('/wallet/import-history');
      toast.success(`Import complete — ${res.data.imported} new transactions added`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Import failed');
    } finally {
      setImportingHistory(false);
    }
  };

  // Security section state (issues #141, #142)
  const [signers, setSigners] = useState(null);
  const [signersLoading, setSignersLoading] = useState(false);
  const [signersError, setSignersError] = useState(null);
  const [inflationDest, setInflationDest] = useState(undefined); // undefined = not loaded
  const [clearingInflation, setClearingInflation] = useState(false);
  const [removingSignerKey, setRemovingSignerKey] = useState(null);

  const loadSigners = async () => {
    setSignersLoading(true);
    setSignersError(null);
    try {
      const res = await api.get('/wallet/signers/horizon');
      setSigners(res.data.signers || []);
      setInflationDest(res.data.inflation_destination);
    } catch {
      setSignersError('Failed to load signer data');
    } finally {
      setSignersLoading(false);
    }
  };

  const handleClearInflation = async () => {
    if (!window.confirm('Clear the inflation destination from your account?')) return;
    setClearingInflation(true);
    try {
      await api.post('/wallet/clear-inflation-destination');
      setInflationDest(null);
      toast.success('Inflation destination cleared');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to clear inflation destination');
    } finally {
      setClearingInflation(false);
    }
  };

  const handleRemoveSigner = async (signerKey) => {
    if (!window.confirm(`Remove signer ${signerKey.slice(0, 8)}…?`)) return;
    setRemovingSignerKey(signerKey);
    try {
      await api.delete(`/wallet/signers/${signerKey}`);
      setSigners(prev => prev.filter(s => s.key !== signerKey));
      toast.success('Signer removed');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to remove signer');
    } finally {
      setRemovingSignerKey(null);
    }
  };

  React.useEffect(() => {
    api.get('/wallet/trustlines')
      .then(r => setTrustlines(r.data.trustlines || []))
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    const fetchContacts = async () => {
      try {
        const res = await api.get('/wallet/contacts');
        setContacts(res.data.contacts || []);
      } catch {
        toast.error('Failed to load contacts');
      } finally {
        setContactsLoading(false);
      }
    };
    const fetchActivity = async () => {
      try {
        const res = await api.get('/auth/activity');
        setActivity(res.data.activity || []);
      } catch {
        // non-critical, silently ignore
      } finally {
        setActivityLoading(false);
      }
    };
    fetchContacts();
    fetchActivity();
  }, []);

  const handleAddTrustline = async (e) => {
    e.preventDefault();
    setTrustlineLoading(true);
    try {
      await api.post('/wallet/trustline', { asset: newAsset.trim().toUpperCase() });
      const r = await api.get('/wallet/trustlines');
      setTrustlines(r.data.trustlines || []);
      setNewAsset('');
      toast.success('Trustline added');
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || 'Failed to add trustline');
    } finally {
      setTrustlineLoading(false);
    }
  };

  const handleRemoveTrustline = async (asset) => {
    if (!window.confirm(`Remove ${asset} trustline? Your ${asset} balance must be zero.`)) return;
    try {
      await api.delete(`/wallet/trustline/${asset}`);
      setTrustlines(prev => prev.filter(t => t.asset !== asset));
      toast.success(`${asset} trustline removed`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to remove trustline');
    }
  };

  const copyAddress = () => {
    navigator.clipboard.writeText(user?.wallet_address || '');
    setCopied(true);
    toast.success(t('profile.address_copied'));
    setTimeout(() => setCopied(false), 2000);
  };

  const handleLogout = () => { logout(); navigate('/'); };

  const changeLanguage = (code) => {
    i18n.changeLanguage(code);
    localStorage.setItem('afripay_lang', code);
  };

  const addContact = async (e) => {
    e.preventDefault();
    try {
      const tags = newContact.tags.split(',').map(t => t.trim()).filter(Boolean);
      const res = await api.post('/wallet/contacts', { ...newContact, tags });
      setContacts([...contacts, res.data.contact]);
      setNewContact({ name: '', wallet_address: '', notes: '', memo_required: false, default_memo: '', tags: '' });
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
      await api.delete(`/wallet/contacts/${id}`);
      setContacts(contacts.filter(c => c.id !== id));
      toast.success('Contact deleted');
    } catch {
      toast.error('Failed to delete contact');
    }
  };

  const handleExportKey = async (e) => {
    e.preventDefault();
    setBackupLoading(true);
    try {
      const res = await api.post('/wallet/export-key', { password: backupPassword });
      setExportedKey(res.data.secret_key);
      setBackupPassword('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Export failed');
    } finally {
      setBackupLoading(false);
    }
  };

  const copyKey = () => {
    navigator.clipboard.writeText(exportedKey);
    setKeyCopied(true);
    setTimeout(() => setKeyCopied(false), 2000);
  };

  const closeBackup = () => {
    setShowBackup(false);
    setExportedKey(null);
    setBackupPassword('');
    setShowKey(false);
  };

  const handleCloseAccount = async (e) => {
    e.preventDefault();
    if (!window.confirm(
      'FINAL WARNING: This will permanently close your Stellar account and transfer all XLM to the destination. This cannot be undone. Continue?'
    )) return;
    setCloseLoading(true);
    try {
      await api.post('/wallet/merge', { destination: closeDestination, password: closePassword });
      toast.success('Account closed. All XLM transferred to destination.');
      logout();
      navigate('/');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Account merge failed');
    } finally {
      setCloseLoading(false);
    }
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

      {/* Change Email */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Mail size={16} className="text-gray-500" />
            <h3 className="font-semibold text-white">Change Email</h3>
          </div>
          <button
            onClick={() => { setShowChangeEmail(v => !v); setChangeEmailForm({ new_email: '', password: '' }); }}
            className="text-sm text-primary-500 hover:text-primary-400"
          >
            {showChangeEmail ? 'Cancel' : 'Change'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-3">Current: {user?.email}</p>
        {showChangeEmail && (
          <form onSubmit={handleChangeEmail} className="space-y-3">
            <input
              type="email"
              required
              placeholder="New email address"
              value={changeEmailForm.new_email}
              onChange={e => setChangeEmailForm({ ...changeEmailForm, new_email: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-primary-500"
            />
            <input
              type="password"
              required
              placeholder="Current password to confirm"
              value={changeEmailForm.password}
              onChange={e => setChangeEmailForm({ ...changeEmailForm, password: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-primary-500"
            />
            <button
              type="submit"
              disabled={changeEmailLoading}
              className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
            >
              {changeEmailLoading ? 'Sending…' : 'Send Verification Email'}
            </button>
          </form>
        )}
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

      {/* Referral Program */}
      <Link
        to="/referrals"
        className="bg-gray-900 rounded-2xl p-5 flex items-center justify-between hover:bg-gray-800 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Gift size={20} className="text-primary-500" />
          <div>
            <p className="font-semibold text-white text-sm">Refer &amp; Earn</p>
            <p className="text-xs text-gray-400">Invite friends, earn fee credits</p>
          </div>
        </div>
        <span className="text-gray-500 text-lg">›</span>
      </Link>

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
            <textarea
              placeholder="Notes (optional)"
              value={newContact.notes}
              onChange={e => setNewContact({ ...newContact, notes: e.target.value })}
              rows={2}
              maxLength={500}
              className="w-full bg-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-primary-500 resize-none"
            />
            <input
              type="text"
              placeholder="Default memo (optional)"
              value={newContact.default_memo}
              onChange={e => setNewContact({ ...newContact, default_memo: e.target.value })}
              maxLength={64}
              className="w-full bg-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 font-mono focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            <input
              type="text"
              placeholder="Tags (comma-separated, e.g. business,exchange)"
              value={newContact.tags}
              onChange={e => setNewContact({ ...newContact, tags: e.target.value })}
              className="w-full bg-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={newContact.memo_required}
                onChange={e => setNewContact({ ...newContact, memo_required: e.target.checked })}
                className="accent-primary-500"
              />
              Memo required for this contact
            </label>
            <button type="submit" className="w-full bg-primary-500 text-white text-sm py-2 rounded-lg hover:bg-primary-600 transition-colors">
              {t('common.save')}
            </button>
          </form>
        )}

        {/* Tag filter */}
        {contacts.length > 0 && (
          <div className="flex gap-2 flex-wrap mb-3">
            {['', ...Array.from(new Set(contacts.flatMap(c => c.tags || [])))].map(tag => (
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

        {contacts.length === 0 ? (
        {contactsLoading ? (
          <p className="text-gray-500 text-sm text-center py-4" data-testid="contacts-loading">Loading…</p>
        ) : contacts.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">{t('profile.no_contacts')}</p>
        ) : (
          <div className="space-y-2" data-testid="contacts-list">
            {contacts.filter(c => !tagFilter || (c.tags || []).includes(tagFilter)).map(c => (
              <div key={c.id} className="flex items-center gap-3 group">
                <div className="w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center text-sm font-semibold text-white">
                  {c.name?.[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white font-medium">{c.name}</p>
                  <p className="text-xs text-gray-500 font-mono truncate">{truncateAddress(c.wallet_address)}</p>
                  {c.default_memo && (
                    <p className="text-xs text-gray-500">Memo: <span className="font-mono">{c.default_memo}</span></p>
                  )}
                  {c.tags?.length > 0 && (
                    <div className="flex gap-1 flex-wrap mt-0.5">
                      {c.tags.map(tag => (
                        <span key={tag} className="text-xs bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded-full">{tag}</span>
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

      {/* Backup Wallet */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <ShieldAlert size={16} className="text-yellow-500" />
            <h3 className="font-semibold text-white">Backup Wallet</h3>
          </div>
          <button
            onClick={() => (showBackup ? closeBackup() : setShowBackup(true))}
            className="text-sm text-primary-500 hover:text-primary-400"
          >
            {showBackup ? 'Cancel' : 'Export Key'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Export your Stellar secret key to back up your wallet independently of AfriPay.
        </p>

        {showBackup && !exportedKey && (
          <form onSubmit={handleExportKey} className="space-y-3">
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3 text-xs text-yellow-400 space-y-1">
              <p className="font-semibold">⚠ Read before continuing</p>
              <p>Your secret key gives full control of your wallet. Never share it with anyone, including AfriPay support.</p>
              <p>Store it offline in a secure location. AfriPay cannot recover it if lost.</p>
            </div>
            <input
              type="password"
              required
              placeholder="Enter your account password to confirm"
              value={backupPassword}
              onChange={e => setBackupPassword(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-primary-500"
            />
            <button
              type="submit"
              disabled={backupLoading}
              className="w-full bg-yellow-500 hover:bg-yellow-600 disabled:opacity-50 text-black font-semibold py-2.5 rounded-xl text-sm transition-colors"
            >
              {backupLoading ? 'Verifying…' : 'Reveal Secret Key'}
            </button>
          </form>
        )}

        {exportedKey && (
          <div className="space-y-3">
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-xs text-red-400">
              <p className="font-semibold mb-1">🔑 Your secret key — shown once</p>
              <p>Copy it now and store it somewhere safe. This dialog will not show it again after you close it.</p>
            </div>
            <div className="relative bg-gray-800 rounded-xl px-4 py-3">
              <p className="font-mono text-sm text-white break-all pr-8">
                {showKey ? exportedKey : '•'.repeat(exportedKey.length)}
              </p>
              <button
                onClick={() => setShowKey(v => !v)}
                className="absolute right-3 top-3 text-gray-400 hover:text-white"
                aria-label={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <div className="flex gap-2">
              <button
                onClick={copyKey}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-white text-sm py-2.5 rounded-xl flex items-center justify-center gap-2 transition-colors"
              >
                {keyCopied ? <CheckCheck size={14} className="text-green-400" /> : <Copy size={14} />}
                {keyCopied ? 'Copied!' : 'Copy Key'}
              </button>
              <button
                onClick={closeBackup}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-400 text-sm py-2.5 rounded-xl transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Recent Activity */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Activity size={16} className="text-gray-500" />
          <h3 className="font-semibold text-white">Recent Activity</h3>
        </div>
        {activityLoading ? (
          <p className="text-gray-500 text-sm text-center py-4">Loading…</p>
        ) : activity.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">No activity recorded yet.</p>
        ) : (
          <div className="space-y-3">
            {activity.map((event, i) => (
              <div key={i} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <p className="text-white font-medium capitalize">{event.action.replace(/_/g, ' ')}</p>
                  <p className="text-gray-500 text-xs font-mono">{event.ip_address || '—'}</p>
                </div>
                <p className="text-gray-500 text-xs shrink-0 text-right">
                  {new Date(event.created_at).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Manage Assets */}
      <div className="bg-gray-900 rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Coins size={16} className="text-gray-500" />
          <h3 className="font-semibold text-white">Manage Assets</h3>
        </div>

        {trustlines.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-2">No asset trustlines yet.</p>
        ) : (
          <div className="space-y-2">
            {trustlines.map(t => (
              <div key={t.asset} className="flex items-center gap-3 bg-gray-800 rounded-xl px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white">{t.asset}</p>
                  <p className="text-xs text-gray-500">Balance: {parseFloat(t.balance).toLocaleString()}</p>
                </div>
                <button
                  onClick={() => handleRemoveTrustline(t.asset)}
                  className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                  aria-label={`Remove ${t.asset} trustline`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handleAddTrustline} className="flex gap-2 pt-1 border-t border-gray-800">
          <input
            type="text"
            required
            placeholder="Asset code (e.g. USDC)"
            value={newAsset}
            onChange={e => setNewAsset(e.target.value)}
            maxLength={12}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-primary-500"
          />
          <button
            type="submit"
            disabled={trustlineLoading}
            className="bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors flex items-center gap-1.5"
          >
            <Plus size={14} />
            {trustlineLoading ? '…' : 'Add'}
          </button>
        </form>
      </div>

      {/* Business Account */}
      <button
        onClick={() => navigate('/business')}
        className="w-full bg-gray-900 hover:bg-gray-800 border border-gray-800 rounded-2xl p-4 flex items-center gap-3 transition-colors"
      >
        <Building2 size={18} className="text-primary-400 shrink-0" />
        <div className="flex-1 text-left">
          <p className="text-sm font-semibold text-white">Business Account</p>
          <p className="text-xs text-gray-500">
            {user?.account_type === 'business' ? 'Manage multisig signers' : 'Upgrade for multisig support'}
          </p>
        </div>
        {user?.account_type === 'business' && (
          <span className="text-xs bg-primary-500/20 text-primary-400 px-2 py-0.5 rounded-full shrink-0">Active</span>
        )}
      </button>

      {/* Security — Signers & Inflation Destination (issues #141, #142) */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-primary-400" />
            <h3 className="font-semibold text-white">Security</h3>
          </div>
          <button
            onClick={loadSigners}
            disabled={signersLoading}
            className="text-sm text-primary-500 hover:text-primary-400 disabled:opacity-50"
          >
            {signersLoading ? 'Loading…' : signers === null ? 'Load' : 'Refresh'}
          </button>
        </div>

        {signersError && (
          <p className="text-red-400 text-xs mb-3">{signersError}</p>
        )}

        {/* Inflation destination notice */}
        {inflationDest && (
          <div className="mb-4 bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3 flex items-start gap-3">
            <AlertCircle size={15} className="text-yellow-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-yellow-400 text-xs font-semibold mb-0.5">Legacy inflation destination set</p>
              <p className="text-yellow-300/70 text-xs font-mono truncate">{inflationDest}</p>
              <p className="text-gray-500 text-xs mt-1">Stellar removed inflation in Protocol 12. This is harmless but can be cleared.</p>
            </div>
            <button
              onClick={handleClearInflation}
              disabled={clearingInflation}
              className="text-xs bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50 shrink-0"
            >
              {clearingInflation ? '…' : 'Clear'}
            </button>
          </div>
        )}

        {/* Signers list */}
        {signers !== null && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500 mb-2">Account signers from Horizon</p>
            {signers.map((s) => {
              const isMaster = s.type === 'ed25519_public_key' && s.key === user?.wallet_address;
              return (
                <div key={s.key} className="flex items-center gap-3 bg-gray-800 rounded-xl px-3 py-2.5">
                  <Key size={13} className="text-gray-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-mono text-white truncate">{s.key.slice(0, 8)}…{s.key.slice(-8)}</p>
                    <p className="text-xs text-gray-500">
                      Weight: {s.weight} · {s.type.replace(/_/g, ' ')}
                      {isMaster && <span className="ml-1 text-primary-400">(master)</span>}
                    </p>
                  </div>
                  {!isMaster && (
                    <button
                      onClick={() => handleRemoveSigner(s.key)}
                      disabled={removingSignerKey === s.key}
                      className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
                      aria-label="Remove signer"
                    >
                      {removingSignerKey === s.key ? '…' : <Trash2 size={13} />}
                    </button>
                  )}
                </div>
              );
            })}
            {signers.length === 0 && (
              <p className="text-gray-500 text-xs text-center py-2">No signers found.</p>
            )}
          </div>
        )}

        {signers === null && !signersLoading && (
          <p className="text-gray-600 text-xs text-center py-2">Click "Load" to fetch live signer data from Horizon.</p>
        )}
      </div>

      {/* Import Horizon History */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-white">Import Transaction History</h3>
            <p className="text-xs text-gray-400 mt-0.5">Fetch your complete Stellar history from Horizon</p>
          </div>
          <button
            onClick={handleImportHistory}
            disabled={importingHistory}
            className="text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg transition-colors"
          >
            {importingHistory ? 'Importing…' : 'Import History'}
          </button>
        </div>
      </div>

      {/* Close Account */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-red-500" />
            <h3 className="font-semibold text-white">Close Account</h3>
          </div>
          <button
            onClick={() => setShowCloseAccount(v => !v)}
            className="text-sm text-red-400 hover:text-red-300"
          >
            {showCloseAccount ? 'Cancel' : 'Close Account'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Permanently close your Stellar account and transfer all XLM to another address. This is irreversible.
        </p>
        {showCloseAccount && (
          <form onSubmit={handleCloseAccount} className="space-y-3">
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-xs text-red-400 space-y-1">
              <p className="font-semibold">⚠ This operation is IRREVERSIBLE</p>
              <p>Your Stellar account will be permanently closed. All XLM will be transferred to the destination address. Any remaining non-XLM assets must be removed first.</p>
            </div>
            <input
              type="text"
              required
              placeholder="Destination Stellar address"
              value={closeDestination}
              onChange={e => setCloseDestination(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 font-mono focus:outline-none focus:border-red-500"
            />
            <input
              type="password"
              required
              placeholder="Enter your password to confirm"
              value={closePassword}
              onChange={e => setClosePassword(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-red-500"
            />
            <button
              type="submit"
              disabled={closeLoading}
              className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
            >
              {closeLoading ? 'Processing…' : 'Permanently Close Account'}
            </button>
          </form>
        )}
      </div>

      {/* Logout */}
      <button
        onClick={handleLogout}
        className="w-full bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-colors"
      >
        <LogOut size={18} /> {t('common.sign_out')}
      </button>
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
    </div>
  );
}
