import React, { useState, useRef, lazy, Suspense } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import ConfirmModal from '../components/ConfirmModal';
import ImportContactsModal from '../components/ImportContactsModal';
import {
  LogOut,
  Mail,
  Phone,
  Wallet,
  Copy,
  CheckCheck,
  Globe,
  Building2,
  Gift,
  Link2,
  Calendar,
  Webhook,
  Camera,
} from 'lucide-react';
import { useAuth, tokenStore } from '../context/AuthContext';
import { truncateAddress } from '../utils/currency';
import api from '../utils/api';
import AvatarCrop from '../components/AvatarCrop';
import KycStatusCard from '../components/profile/KycStatusCard';
import LoyaltyCard from '../components/profile/LoyaltyCard';
import SupportTickets from '../components/profile/SupportTickets';
import ChangeEmail from '../components/profile/ChangeEmail';
import ContactsSection from '../components/profile/ContactsSection';
import BackupWallet from '../components/profile/BackupWallet';
import RecentActivity from '../components/profile/RecentActivity';
import ManageAssets from '../components/profile/ManageAssets';
import TwoFactorAuth from '../components/profile/TwoFactorAuth';
import ImportHistory from '../components/profile/ImportHistory';
import CloseAccount from '../components/profile/CloseAccount';

const SecuritySigners = lazy(() => import('../components/profile/SecuritySigners'));

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'sw', label: 'Kiswahili' },
  { code: 'fr', label: 'Français' },
  { code: 'ha', label: 'Hausa' },
  { code: 'yo', label: 'Yorùbá' },
];

export default function Profile() {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);

  // Avatar upload state
  const fileInputRef = useRef(null);
  const [cropFile, setCropFile] = useState(null); // File selected for cropping
  // Issue #1000: immediate inline error when the selected file fails the
  // client-side size/type checks — no network round-trip needed.
  const [avatarError, setAvatarError] = useState('');

  const handleAvatarClick = () => fileInputRef.current?.click();
  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Client-side limits mirror the backend upload middleware
    // (backend/src/routes/auth.js avatarUpload: 5 MB, image/(jpeg|png|webp))
    // so invalid files fail fast before any bytes are uploaded.
    if (file.size > 5 * 1024 * 1024) {
      setAvatarError('File too large. Maximum size is 5 MB.');
      toast.error('File too large. Maximum size is 5 MB.');
      return;
    }
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setAvatarError('Only JPEG, PNG, and WebP files are accepted.');
      toast.error('Only JPEG, PNG, and WebP files are accepted.');
      return;
    }
    setAvatarError('');
    setCropFile(file);
    // Reset input so same file can be selected again
    e.target.value = '';
  };
  const handleCropSuccess = (avatarUrl) => {
    updateUser({ avatar_url: avatarUrl });
    setCropFile(null);
    toast.success('Profile photo updated');
  };




  // Loyalty points state (issue #480)
  const [loyaltyBalance, setLoyaltyBalance] = useState(null);
  const [loyaltyLoading, setLoyaltyLoading] = useState(true);
  const [redeemLoading, setRedeemLoading] = useState(false);
  const [loyaltyTiers, setLoyaltyTiers] = useState([]);
  const [loyaltyHistory, setLoyaltyHistory] = useState([]);
  const [confirmTier, setConfirmTier] = useState(null);



  const refreshLoyalty = async () => {
    const [bal, tiers, hist] = await Promise.all([
      api.get('/loyalty/balance'),
      api.get('/loyalty/tiers'),
      api.get('/loyalty/history'),
    ]);
    setLoyaltyBalance(bal.data.points || 0);
    setLoyaltyTiers(tiers.data.tiers || []);
    setLoyaltyHistory(hist.data.history || []);
  };

  const handleRedeemLoyalty = async () => {
    const tier = confirmTier;
    setRedeemLoading(true);
    try {
      await api.post('/loyalty/redeem', { tier_index: tier.index });
      toast.success(t('loyalty.redeemed', { points: tier.threshold, percent: tier.discount_bps / 100 }));
      setConfirmTier(null);
      await refreshLoyalty();
    } catch (err) {
      toast.error(err.response?.data?.error || t('loyalty.redeemFailed'));
    } finally {
      setRedeemLoading(false);
    }
  };






  React.useEffect(() => {
    const fetchContacts = async () => {
      try {
        const res = await api.get('/contacts');
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
    const fetchTickets = async () => {
      try {
        const res = await api.get('/support/tickets');
        setTickets(res.data.tickets || []);
      } catch {
        // non-critical, silently ignore
      } finally {
        setTicketsLoading(false);
      }
    };
    const fetchLoyaltyBalance = async () => {
      try {
        await refreshLoyalty();
      } catch {
        // non-critical, silently ignore
      } finally {
        setLoyaltyLoading(false);
      }
    };
    fetchContacts();
    fetchActivity();
    fetchTickets();
    fetchLoyaltyBalance();
  }, []);



  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(user?.wallet_address || '');
      setCopied(true);
      toast.success(t('profile.address_copied'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy address');
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const changeLanguage = async (code) => {
    i18n.changeLanguage(code);
    localStorage.setItem('afripay_lang', code);
    try {
      await api.patch('/auth/me', { preferred_language: code });
    } catch {
      // Non-critical: local preference is already applied; backend sync failure
      // is silently ignored to avoid disrupting the language-switch UX.
    }
  };





  return (
    <div className="px-4 py-6 max-w-lg mx-auto space-y-6">
      <h2 className="text-2xl font-bold text-white">{t('profile.title')}</h2>

      {/* User info card */}
      <div className="bg-gray-900 rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-4">
          {/* Avatar — clickable to upload a new photo */}
          <button
            type="button"
            onClick={handleAvatarClick}
            className="relative w-14 h-14 rounded-full overflow-hidden bg-primary-500 flex items-center justify-center text-2xl font-bold text-white shrink-0 group"
            aria-label="Change profile photo"
          >
            {user?.avatar_url ? (
              <img
                src={user.avatar_url}
                alt="Profile"
                className="w-full h-full object-cover"
              />
            ) : (
              <span>{user?.full_name?.[0]?.toUpperCase()}</span>
            )}
            {/* Camera overlay on hover */}
            <span className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <Camera size={18} className="text-white" />
            </span>
          </button>
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.webp"
            className="hidden"
            onChange={handleFileChange}
          />
          <div>
            <p className="font-semibold text-white text-lg">{user?.full_name}</p>
            <p className="text-gray-400 text-sm">{t('profile.member')}</p>
          </div>
        </div>

        {avatarError && (
          <p role="alert" className="text-xs text-red-400">
            {avatarError}
          </p>
        )}

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
            <span className="text-gray-300 font-mono flex-1 truncate">
              {truncateAddress(user?.wallet_address, 12)}
            </span>
            <button onClick={copyAddress} className="text-gray-400 hover:text-primary-400 shrink-0">
              {copied ? <CheckCheck size={14} className="text-primary-500" /> : <Copy size={14} />}
            </button>
          </div>
        </div>
      </div>

      <KycStatusCard />

      <LoyaltyCard />

      <SupportTickets />

      <ChangeEmail />
            {kycStatus === 'verified' && (
              <div className="mt-3 bg-green-500/10 border border-green-500/20 rounded-xl p-4">
                <p className="text-green-400 font-semibold">Verified</p>
                <p className="text-gray-400 text-xs mt-1">
                  You can send transactions of any amount.
                </p>
              </div>
            )}

            {kycStatus === 'rejected' && (
              <div className="mt-3 bg-red-500/10 border border-red-500/20 rounded-xl p-4">
                <p className="text-red-400 font-semibold">Rejected</p>
                {kycRejectionReason && (
                  <p className="text-red-300 text-xs mt-1">Reason: {kycRejectionReason}</p>
                )}
                <button
                  type="button"
                  onClick={() => navigate('/kyc')}
                  className="mt-3 w-full bg-red-500/15 hover:bg-red-500/25 text-red-200 font-semibold py-2.5 rounded-xl text-sm transition-colors border border-red-500/30"
                >
                  Resubmit
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Loyalty Points (issue #480) */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <Gift size={16} className="text-primary-400" />
          <h3 className="font-semibold text-white">{t('loyalty.title')}</h3>
        </div>

        {loyaltyLoading ? (
          <p className="text-gray-500 text-sm mt-2">{t('loyalty.loading')}</p>
        ) : (
          <div className="mt-3 bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-4">
            <div>
              <p className="text-gray-300 font-semibold text-2xl">{loyaltyBalance || 0}</p>
              <p className="text-gray-500 text-xs mt-1">{t('loyalty.available')}</p>
            </div>
            <div>
              <p className="text-gray-400 text-xs font-semibold mb-2">{t('loyalty.tiers')}</p>
              {loyaltyTiers.length === 0 ? (
                <p className="text-gray-500 text-xs">{t('loyalty.noTiers')}</p>
              ) : (
                <ul className="space-y-2">
                  {loyaltyTiers.map((tier, i) => {
                    const tierObj = { ...tier, index: i };
                    const missing = Number(tier.threshold) - (loyaltyBalance || 0);
                    return (
                      <li key={i} className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-white text-sm">{t('loyalty.discount', { percent: tier.discount_bps / 100 })}</p>
                          <p className="text-gray-500 text-xs">
                            {t('loyalty.cost', { points: tier.threshold })}
                            {missing > 0 && ` · ${t('loyalty.needMore', { points: missing })}`}
                          </p>
                        </div>
                        <button
                          onClick={() => setConfirmTier(tierObj)}
                          disabled={redeemLoading || missing > 0}
                          className="bg-primary-500 hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
                        >
                          {t('loyalty.redeem')}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div>
              <p className="text-gray-400 text-xs font-semibold mb-2">{t('loyalty.history')}</p>
              {loyaltyHistory.length === 0 ? (
                <p className="text-gray-500 text-xs">{t('loyalty.noHistory')}</p>
              ) : (
                <ul className="space-y-1">
                  {loyaltyHistory.slice(0, 10).map((h) => (
                    <li key={h.id} className="flex justify-between text-xs text-gray-400">
                      <span>{h.event_type} · {new Date(h.created_at).toLocaleDateString(i18n.language)}</span>
                      <span>{h.points}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
      <ConfirmModal
        isOpen={!!confirmTier}
        onClose={() => setConfirmTier(null)}
        onConfirm={handleRedeemLoyalty}
        title={t('loyalty.confirmTitle')}
        message={confirmTier ? t('loyalty.confirmMsg', { points: confirmTier.threshold, percent: confirmTier.discount_bps / 100 }) : ''}
        confirmLabel={t('loyalty.redeem')}
        loading={redeemLoading}
      />

      {/* Support Tickets (issue #481) */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <AlertCircle size={16} className="text-primary-400" />
            <h3 className="font-semibold text-white">Support Tickets</h3>
          </div>
          <button
            onClick={() => setShowSupportForm(!showSupportForm)}
            className="text-primary-500 hover:text-primary-400 flex items-center gap-1 text-sm"
          >
            <Plus size={16} /> New Ticket
          </button>
        </div>

        {showSupportForm && (
          <form
            onSubmit={handleSubmitSupport}
            className="mb-4 space-y-3 bg-gray-800 rounded-xl p-4"
          >
            <select
              required
              value={supportForm.type}
              onChange={(e) => setSupportForm({ ...supportForm, type: e.target.value })}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
            >
              <option value="">Select issue type</option>
              <option value="wrong_address">Wrong address</option>
              <option value="wrong_amount">Wrong amount</option>
              <option value="failed_deducted">Failed but deducted</option>
              <option value="other">Other</option>
            </select>
            <input
              type="text"
              placeholder="Transaction ID (optional)"
              value={supportForm.transaction_id}
              onChange={(e) => setSupportForm({ ...supportForm, transaction_id: e.target.value })}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            <textarea
              required
              placeholder="Describe your issue..."
              value={supportForm.description}
              onChange={(e) => setSupportForm({ ...supportForm, description: e.target.value })}
              rows={3}
              maxLength={2000}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-primary-500 resize-none"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowSupportForm(false)}
                className="flex-1 bg-gray-600 hover:bg-gray-500 text-white text-sm py-2 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={supportLoading}
                className="flex-1 bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm py-2 rounded-lg transition-colors"
              >
                {supportLoading ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          </form>
        )}

        {ticketsLoading ? (
          <p className="text-gray-500 text-sm text-center py-4">Loading…</p>
        ) : tickets.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">No support tickets yet.</p>
        ) : (
          <div className="space-y-2">
            {tickets.map((ticket) => (
              <div key={ticket.id} className="bg-gray-800 rounded-xl px-3 py-2.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-white capitalize">
                    {ticket.type.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs text-gray-500">
                    {new Date(ticket.created_at).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-xs text-gray-400 line-clamp-2">{ticket.description}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Change Email */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Mail size={16} className="text-gray-500" />
            <h3 className="font-semibold text-white">Change Email</h3>
          </div>
          <button
            onClick={() => {
              setShowChangeEmail((v) => !v);
              setChangeEmailForm({ new_email: '', password: '' });
            }}
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
              onChange={(e) =>
                setChangeEmailForm({ ...changeEmailForm, new_email: e.target.value })
              }
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-primary-500"
            />
            <input
              type="password"
              required
              placeholder="Current password to confirm"
              value={changeEmailForm.password}
              onChange={(e) => setChangeEmailForm({ ...changeEmailForm, password: e.target.value })}
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
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              type="button"
              aria-pressed={i18n.language === lang.code}
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

      {/* Request Money (#461) */}
      <Link
        to="/request"
        className="bg-gray-900 rounded-2xl p-5 flex items-center justify-between hover:bg-gray-800 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Link2 size={20} className="text-primary-500" />
          <div>
            <p className="font-semibold text-white text-sm">Request Money</p>
            <p className="text-xs text-gray-400">Create a shareable payment link</p>
          </div>
        </div>
        <span className="text-gray-500 text-lg">›</span>
      </Link>

      {/* Scheduled Payments (#462) */}
      <Link
        to="/scheduled"
        className="bg-gray-900 rounded-2xl p-5 flex items-center justify-between hover:bg-gray-800 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Calendar size={20} className="text-primary-500" />
          <div>
            <p className="font-semibold text-white text-sm">Scheduled Payments</p>
            <p className="text-xs text-gray-400">View, create, and cancel recurring payments</p>
          </div>
        </div>
        <span className="text-gray-500 text-lg">›</span>
      </Link>

      {/* Webhooks (#464) */}
      <Link
        to="/webhooks"
        className="bg-gray-900 rounded-2xl p-5 flex items-center justify-between hover:bg-gray-800 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Webhook size={20} className="text-primary-500" />
          <div>
            <p className="font-semibold text-white text-sm">Webhooks</p>
            <p className="text-xs text-gray-400">Manage transaction event endpoints</p>
          </div>
        </div>
        <span className="text-gray-500 text-lg">›</span>
      </Link>

      <ContactsSection />

      <BackupWallet />

      <RecentActivity />

      <ManageAssets />

      {/* Business Account */}
      <button
        onClick={() => navigate('/business')}
        className="w-full bg-gray-900 hover:bg-gray-800 border border-gray-800 rounded-2xl p-4 flex items-center gap-3 transition-colors"
      >
        <Building2 size={18} className="text-primary-400 shrink-0" />
        <div className="flex-1 text-left">
          <p className="text-sm font-semibold text-white">Business Account</p>
          <p className="text-xs text-gray-500">
            {user?.account_type === 'business'
              ? 'Manage multisig signers'
              : 'Upgrade for multisig support'}
          </p>
        </div>
        {user?.account_type === 'business' && (
          <span className="text-xs bg-primary-500/20 text-primary-400 px-2 py-0.5 rounded-full shrink-0">
            Active
          </span>
        )}
      </button>

      <TwoFactorAuth />

      <Suspense fallback={null}><SecuritySigners /></Suspense>

      <ImportHistory />

      {/* Notification Preferences */}
      {'serviceWorker' in navigator && 'PushManager' in window && (() => {
        const PREFS_KEY = 'afripay_notification_prefs';
        const defaultPrefs = { payment_confirmed: true, payment_received: true, kyc_approved: true };
        let prefs;
        try { prefs = { ...defaultPrefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
        catch { prefs = defaultPrefs; }
        const savePrefs = (key, value) => {
          const updated = { ...prefs, [key]: value };
          localStorage.setItem(PREFS_KEY, JSON.stringify(updated));
        };
        const NotifToggle = ({ label, prefKey }) => {
          const [on, setOn] = React.useState(prefs[prefKey]);
          return (
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-gray-300">{label}</span>
              <button
                role="switch"
                aria-checked={on}
                onClick={() => { const next = !on; setOn(next); savePrefs(prefKey, next); }}
                className={`relative w-10 h-6 rounded-full transition-colors ${on ? 'bg-primary-600' : 'bg-gray-700'}`}
              >
                <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${on ? 'translate-x-5' : 'translate-x-1'}`} />
              </button>
            </div>
          );
        };
        return (
          <div className="bg-gray-900 rounded-2xl p-5">
            <h3 className="font-semibold text-white mb-3">Notification Preferences</h3>
            <NotifToggle label="Payment confirmed" prefKey="payment_confirmed" />
            <NotifToggle label="Payment received" prefKey="payment_received" />
            <NotifToggle label="KYC approved" prefKey="kyc_approved" />
          </div>
        );
      })()}

      <CloseAccount />

      {/* Logout */}
      <button
        onClick={handleLogout}
        className="w-full bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-colors"
      >
        <LogOut size={18} /> {t('common.sign_out')}
      </button>
      {/* Avatar crop modal */}
      {cropFile && (
        <AvatarCrop
          file={cropFile}
          onSuccess={handleCropSuccess}
          onClose={() => setCropFile(null)}
          apiBase={process.env.REACT_APP_API_URL || 'http://localhost:5000/api'}
          token={tokenStore.get()}
        />
      )}
    </div>
  );
}
