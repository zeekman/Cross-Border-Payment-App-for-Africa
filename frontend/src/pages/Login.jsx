import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, Link, useSearchParams, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { Eye, EyeOff, ArrowLeft, ShieldCheck, MailCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '../utils/api';

export default function Login() {
  const { login, updateUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Set by the Register page after a successful signup — shows the
  // "please verify your email" banner (see emailVerificationRequired below).
  const emailVerificationRequired = location.state?.emailVerificationRequired;
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [form, setForm] = useState({ email: '', password: '' });
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(false);

  // Rate-limit cooldown (issue #655) — persisted across refreshes via sessionStorage
  const COOLDOWN_KEY = 'afripay_login_cooldown_until';
  const DEFAULT_COOLDOWN_SECONDS = 60;
  const [secondsLeft, setSecondsLeft] = useState(() => {
    const until = parseInt(sessionStorage.getItem(COOLDOWN_KEY) || '0', 10);
    const remaining = Math.ceil((until - Date.now()) / 1000);
    return remaining > 0 ? remaining : 0;
  });

  // 2FA TOTP step
  const [requires2fa, setRequires2fa] = useState(false);
  const [totp, setTotp] = useState('');
  const [totpError, setTotpError] = useState('');
  const totpInputRef = useRef(null);

  // Backup-code mode (issue #1194) — lets users without their authenticator
  // submit a saved backup code instead of a TOTP code.
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [backupCode, setBackupCode] = useState('');
  const backupInputRef = useRef(null);

  // Focus TOTP input when the step becomes visible
  useEffect(() => {
    if (requires2fa && totpInputRef.current) {
      totpInputRef.current.focus();
    }
  }, [requires2fa]);

  // Focus the backup-code input when the user switches modes
  useEffect(() => {
    if (requires2fa && useBackupCode && backupInputRef.current) {
      backupInputRef.current.focus();
    }
  }, [requires2fa, useBackupCode]);

  // Tick the cooldown down every second; re-enable the button automatically at 0.
  useEffect(() => {
    if (secondsLeft <= 0) return undefined;
    const timer = setInterval(() => {
      const until = parseInt(sessionStorage.getItem(COOLDOWN_KEY) || '0', 10);
      const remaining = Math.ceil((until - Date.now()) / 1000);
      if (remaining <= 0) {
        sessionStorage.removeItem(COOLDOWN_KEY);
        setSecondsLeft(0);
      } else {
        setSecondsLeft(remaining);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [secondsLeft]);

  const startCooldown = (seconds) => {
    const until = Date.now() + seconds * 1000;
    sessionStorage.setItem(COOLDOWN_KEY, String(until));
    setSecondsLeft(seconds);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      // Device-trust is now carried by an httpOnly cookie the backend sets on login
      // (issue #995) — the browser attaches it automatically, no localStorage needed.
      const result = await login(
        form.email,
        form.password,
        rememberDevice ? { rememberDevice: true } : {}
      );
      const redirectParam = searchParams.get('redirect');
      const redirect = redirectParam || sessionStorage.getItem('afripay_redirect');
      sessionStorage.removeItem('afripay_redirect');
      // Onboarding completion is per-account — users who haven't completed it
      // are routed through the Welcome screen before reaching the app.
      if (result.user?.onboarding_completed === false) {
        navigate('/');
        return;
      }
      navigate(redirect || '/dashboard');
    } catch (err) {
      const data = err.response?.data;
      if (data?.code === 'TOTP_REQUIRED' || data?.requires_2fa) {
        // Backend signals that a TOTP code is required — switch to TOTP step
        setRequires2fa(true);
      } else if (err.response?.status === 429) {
        // Rate limit exceeded (issue #655) — start a countdown from Retry-After.
        const retryAfter = parseInt(err.response.headers?.['retry-after'], 10);
        startCooldown(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : DEFAULT_COOLDOWN_SECONDS);
      } else {
        toast.error(data?.error || t('login.error'));
      }
    } finally {
      setLoading(false);
    }
  };

  // Shared success path for both TOTP and backup-code submissions.
  const completeTwoFactorLogin = async (res) => {
    // Manually set token + user via the same path login() uses
    const { tokenStore } = await import('../context/AuthContext');
    tokenStore.set(res.data.token);
    // Populate AuthContext user from the login response (same as login() does)
    updateUser(res.data.user);
    // Set Sentry user context for error tracking
    const { default: Sentry } = await import('@sentry/react');
    Sentry.setUser({
      id: res.data.user.id,
      wallet: res.data.user.wallet_address
        ? `${res.data.user.wallet_address.slice(0, 4)}...${res.data.user.wallet_address.slice(-4)}`
        : undefined,
    });
    navigate('/dashboard');
  };

  const handleTotpChange = async (value) => {
    // Only allow digits
    const digits = value.replace(/\D/g, '').slice(0, 6);
    setTotp(digits);
    setTotpError('');

    // Auto-submit on 6th digit
    if (digits.length === 6) {
      setLoading(true);
      try {
        // Device-trust cookie (httpOnly) is attached automatically by the browser.
        const res = await api.post(
          '/auth/login',
          { email: form.email, password: form.password, totp_code: digits, ...(rememberDevice && { rememberDevice: true }) }
        );
        await completeTwoFactorLogin(res);
      } catch (err) {
        setTotpError(err.response?.data?.error || t('login.totp_error', 'Invalid code. Try again.'));
        setTotp('');
        totpInputRef.current?.focus();
      } finally {
        setLoading(false);
      }
    }
  };

  // Submit a saved backup code (issue #1194). The backend accepts
  // `backup_code` as an alternative to `totp_code` and marks it used.
  const handleBackupCodeSubmit = async (e) => {
    e.preventDefault();
    const code = backupCode.trim();
    if (!code) return;
    setLoading(true);
    try {
      const res = await api.post(
        '/auth/login',
        { email: form.email, password: form.password, backup_code: code, ...(rememberDevice && { rememberDevice: true }) }
      );
      await completeTwoFactorLogin(res);
    } catch (err) {
      toast.error(
        err.response?.data?.error ||
          t('login.backup_code_error', 'Invalid or already-used backup code. Try another one.')
      );
      setBackupCode('');
      backupInputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  const handleBackToCredentials = () => {
    setRequires2fa(false);
    setTotp('');
    setUseBackupCode(false);
    setBackupCode('');
  };

  const toggleBackupCode = () => {
    setUseBackupCode((prev) => !prev);
    setTotp('');
    setBackupCode('');
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col px-6 py-8 transition-colors duration-200">
      <button
        onClick={requires2fa ? handleBackToCredentials : () => navigate('/')}
        className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white mb-6 flex items-center gap-1 transition-colors"
      >
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      <div className="flex-1 flex flex-col justify-center max-w-sm mx-auto w-full">
        <div className="w-12 h-12 bg-primary-500 rounded-2xl flex items-center justify-center text-2xl mb-6">
          {requires2fa ? <ShieldCheck size={24} className="text-white" /> : '💸'}
        </div>

        {requires2fa ? (
          /* ── TOTP step ── */
          <>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
              {t('login.totp_title', 'Two-factor authentication')}
            </h2>
            <p className="text-gray-600 dark:text-gray-400 mb-8">
              {useBackupCode
                ? t('login.backup_code_subtitle', 'Enter one of the backup codes you saved when you set up two-factor authentication.')
                : t('login.totp_subtitle', 'Enter the 6-digit code from your authenticator app.')}
            </p>

            <div>
              <label className="text-sm text-gray-600 dark:text-gray-400 mb-1 block">
                {t('login.totp_label', 'Authentication code')}
              </label>
              <input
                ref={totpInputRef}
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                placeholder="000000"
                value={totp}
                onChange={(e) => handleTotpChange(e.target.value)}
                disabled={loading}
                aria-label={t('login.totp_aria', '6-digit TOTP authentication code')}
                aria-invalid={!!totpError}
                aria-describedby={totpError ? 'totp-error' : undefined}
                className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-4 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm text-center text-3xl tracking-[0.5em] font-mono"
              />
              {totpError && (
                <p id="totp-error" role="alert" className="text-sm text-red-500 mt-2 text-center">{totpError}</p>
              )}
              <p className="text-xs text-gray-500 mt-2 text-center">
                {t('login.totp_hint', 'The code submits automatically when all 6 digits are entered.')}
              </p>
            </div>

            {loading && (
              <div className="flex justify-center mt-6">
                <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" role="status" aria-label="Verifying" />
            {useBackupCode ? (
              <form onSubmit={handleBackupCodeSubmit}>
                <label
                  htmlFor="backup-code-input"
                  className="text-sm text-gray-600 dark:text-gray-400 mb-1 block"
                >
                  {t('login.backup_code_label', 'Backup code')}
                </label>
                <input
                  id="backup-code-input"
                  ref={backupInputRef}
                  type="text"
                  autoComplete="one-time-code"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={t('login.backup_code_placeholder', 'Enter backup code')}
                  value={backupCode}
                  onChange={(e) => setBackupCode(e.target.value)}
                  disabled={loading}
                  aria-label={t('login.backup_code_aria', 'Two-factor backup code')}
                  className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-4 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm text-center text-xl tracking-widest font-mono"
                />
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-2 text-center">
                  {t('login.backup_code_warning', 'Each backup code can only be used once. You have a limited number of codes remaining.')}
                </p>
                <button
                  type="submit"
                  disabled={loading || !backupCode.trim()}
                  className="w-full mt-4 bg-primary-500 hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-4 transition-colors"
                >
                  {loading ? t('common.loading', 'Loading…') : t('login.backup_code_submit', 'Verify backup code')}
                </button>
              </form>
            ) : (
              <div>
                <label
                  htmlFor="totp-input"
                  className="text-sm text-gray-600 dark:text-gray-400 mb-1 block"
                >
                  {t('login.totp_label', 'Authentication code')}
                </label>
                <input
                  id="totp-input"
                  ref={totpInputRef}
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  placeholder="000000"
                  value={totp}
                  onChange={(e) => handleTotpChange(e.target.value)}
                  disabled={loading}
                  aria-label={t('login.totp_aria', '6-digit TOTP authentication code')}
                  className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-4 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm text-center text-3xl tracking-[0.5em] font-mono"
                />
                <p className="text-xs text-gray-500 mt-2 text-center">
                  {t('login.totp_hint', 'The code submits automatically when all 6 digits are entered.')}
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={toggleBackupCode}
              aria-pressed={useBackupCode}
              aria-controls={useBackupCode ? 'backup-code-input' : 'totp-input'}
              className="mt-6 w-full text-center text-sm text-primary-600 dark:text-primary-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded"
            >
              {useBackupCode
                ? t('login.use_totp_instead', 'Use an authenticator code instead')
                : t('login.use_backup_code', 'Use a backup code instead')}
            </button>
          </>
        ) : (
          /* ── Credentials step ── */
          <>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
              {t('login.title', 'Welcome back')}
            </h2>
            <p className="text-gray-600 dark:text-gray-400 mb-8">
              {t('login.subtitle', 'Sign in to your account')}
            </p>

            {emailVerificationRequired && (
              <div className="mb-6 flex items-start gap-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
                <MailCheck size={18} className="mt-0.5 shrink-0" />
                <span>{t('login.verify_email', 'Please verify your email before signing in.')}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="email" className="text-sm text-gray-600 dark:text-gray-400 mb-1 block">
                  {t('login.email', 'Email')}
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  disabled={loading}
                  className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm"
                />
              </div>

              <div>
                <label htmlFor="password" className="text-sm text-gray-600 dark:text-gray-400 mb-1 block">
                  {t('login.password', 'Password')}
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPass ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    disabled={loading}
                    className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 pr-12 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    aria-label={showPass ? t('login.hide_password', 'Hide password') : t('login.show_password', 'Show password')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                  >
                    {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                <input
                  type="checkbox"
                  checked={rememberDevice}
                  onChange={(e) => setRememberDevice(e.target.checked)}
                  disabled={loading}
                  className="rounded border-gray-300 dark:border-gray-600"
                />
                {t('login.remember_device', 'Remember this device')}
              </label>

              <button
                type="submit"
                disabled={loading || secondsLeft > 0}
                className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-3 transition-colors"
              >
                {secondsLeft > 0
                  ? t('login.retry_in', 'Try again in {{seconds}}s', { seconds: secondsLeft })
                  : loading
                    ? t('common.loading', 'Loading…')
                    : t('login.submit', 'Sign in')}
              </button>
            </form>

            <p className="text-sm text-gray-600 dark:text-gray-400 mt-6 text-center">
              {t('login.no_account', "Don't have an account?")}{' '}
              <Link to="/register" className="text-primary-600 dark:text-primary-400 hover:underline">
                {t('login.register', 'Sign up')}
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
