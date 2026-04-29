import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { Eye, EyeOff, ArrowLeft, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '../utils/api';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);

  // 2FA TOTP step
  const [requires2fa, setRequires2fa] = useState(false);
  const [totp, setTotp] = useState('');
  const totpInputRef = useRef(null);

  // Focus TOTP input when the step becomes visible
  useEffect(() => {
    if (requires2fa && totpInputRef.current) {
      totpInputRef.current.focus();
    }
  }, [requires2fa]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(form.email, form.password);
      navigate('/dashboard');
    } catch (err) {
      const data = err.response?.data;
      if (err.response?.status === 403 && data?.requires_2fa) {
        // Backend signals that a TOTP code is required — switch to TOTP step
        setRequires2fa(true);
      } else {
        toast.error(data?.error || t('login.error'));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleTotpChange = async (value) => {
    // Only allow digits
    const digits = value.replace(/\D/g, '').slice(0, 6);
    setTotp(digits);

    // Auto-submit on 6th digit
    if (digits.length === 6) {
      setLoading(true);
      try {
        const res = await api.post('/auth/login', {
          email: form.email,
          password: form.password,
          totp_code: digits,
        });
        // Manually set token + user via the same path login() uses
        const { tokenStore } = await import('../context/AuthContext');
        tokenStore.set(res.data.token);
        // Reload user via /auth/me so AuthContext is populated
        navigate('/dashboard');
      } catch (err) {
        toast.error(err.response?.data?.error || t('login.totp_error', 'Invalid code. Try again.'));
        setTotp('');
        totpInputRef.current?.focus();
      } finally {
        setLoading(false);
      }
    }
  };

  const handleBackToCredentials = () => {
    setRequires2fa(false);
    setTotp('');
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
              {t('login.totp_subtitle', 'Enter the 6-digit code from your authenticator app.')}
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
                className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-4 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm text-center text-3xl tracking-[0.5em] font-mono"
              />
              <p className="text-xs text-gray-500 mt-2 text-center">
                {t('login.totp_hint', 'The code submits automatically when all 6 digits are entered.')}
              </p>
            </div>

            {loading && (
              <div className="flex justify-center mt-6">
                <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" role="status" aria-label="Verifying" />
              </div>
            )}
          </>
        ) : (
          /* ── Email / password step ── */
          <>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">{t('login.title')}</h2>
            <p className="text-gray-600 dark:text-gray-400 mb-8">{t('login.subtitle')}</p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-sm text-gray-600 dark:text-gray-400 mb-1 block">{t('login.email')}</label>
                <input
                  type="email"
                  required
                  placeholder="[email]"
                  value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600 dark:text-gray-400 mb-1 block">{t('login.password')}</label>
                <div className="relative">
                  <input
                    type={showPass ? 'text' : 'password'}
                    required
                    placeholder={t('login.password_placeholder')}
                    value={form.password}
                    onChange={e => setForm({ ...form, password: e.target.value })}
                    className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors pr-12 shadow-sm"
                  />
                  <button type="button" onClick={() => setShowPass(!showPass)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-white transition-colors">
                    {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <div className="text-right">
                <Link to="/forgot-password" className="text-sm text-primary-500 hover:underline">
                  {t('login.forgot_password')}
                </Link>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-3.5 rounded-xl transition-colors mt-2"
              >
                {loading ? t('login.submitting') : t('login.submit')}
              </button>
            </form>

            <p className="text-center text-gray-500 mt-6 text-sm">
              {t('login.no_account')}{' '}
              <Link to="/register" className="text-primary-500 hover:underline">{t('login.create_one')}</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
