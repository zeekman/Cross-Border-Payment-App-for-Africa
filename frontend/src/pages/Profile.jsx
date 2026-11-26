import React, { useState, useRef, lazy, Suspense } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
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
