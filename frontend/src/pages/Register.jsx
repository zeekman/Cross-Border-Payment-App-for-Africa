import React, { useState, useMemo } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { Eye, EyeOff, ArrowLeft, ChevronDown, ChevronUp, Check, X, AlertCircle, Phone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getRegisterPasswordStrength, getPasswordChecklist, getPasswordError, getEmailError } from '../utils/passwordValidator';
import { usePasswordPolicy } from '../hooks/usePasswordPolicy';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const [form, setForm] = useState({ full_name: '', email: '', password: '', phone: '' });
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [secretKey, setSecretKey] = useState('');
  const [showSecretKey, setShowSecretKey] = useState(false);
  const [secretKeyError, setSecretKeyError] = useState('');
  const [touched, setTouched] = useState({ full_name: false, email: false, password: false });

  // Phone verification state (issue #478)
  const [showPhoneVerify, setShowPhoneVerify] = useState(false);
  const [phoneOtp, setPhoneOtp] = useState('');
  const [phoneVerifyLoading, setPhoneVerifyLoading] = useState(false);
  const [registeredPhone, setRegisteredPhone] = useState('');
  // Token returned by register so the OTP step can authenticate (issue #1522)
  const [phoneVerificationToken, setPhoneVerificationToken] = useState('');

  // Password strength indicator (issue #656) — rules come from the backend
  // password policy so the UI can never drift from what the server enforces.
  const policy = usePasswordPolicy();
  const strength = useMemo(
    () => getRegisterPasswordStrength(form.password, policy),
    [form.password, policy]
  );
  const emailError = touched.email ? getEmailError(form.email) : '';
  const passwordsMatch = confirmPassword.length > 0 && confirmPassword === form.password;
  const passwordsMismatch = confirmPassword.length > 0 && confirmPassword !== form.password;

  const checklist = useMemo(() => getPasswordChecklist(policy), [policy]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Mark all fields as touched for validation
    setTouched({ full_name: true, email: true, password: true });

    // Validate required fields
    if (!form.full_name.trim()) {
      toast.error('Full name is required');
      return;
    }
    if (getEmailError(form.email)) {
      toast.error(getEmailError(form.email));
      return;
    }
    if (!strength.isAcceptable) {
      toast.error(getPasswordError(form.password, policy));
      return;
    }
    if (confirmPassword !== form.password) {
      toast.error('Passwords do not match');
      return;
    }

    if (showImport && secretKey) {
      // Validate Stellar secret key: starts with 'S', 56 chars, base32
      const isValid = /^S[A-Z2-7]{55}$/.test(secretKey);
      if (!isValid) {
        setSecretKeyError('Invalid Stellar secret key. It must start with S and be 56 characters.');
        return;
      }
    }
    setLoading(true);
    try {
      const payload = { ...form };
      if (showImport && secretKey) payload.secret_key = secretKey;
      const refCode = searchParams.get('ref');
      if (refCode) payload.referral_code = refCode;
      const res = await register(payload);
      toast.success(t('register.success'));
      // If phone was provided, show verification step (issue #478)
      if (form.phone && form.phone.trim()) {
        setRegisteredPhone(form.phone);
        // Capture the phone verification token so the OTP step can authenticate (issue #1522)
        setPhoneVerificationToken(res?.phone_verification_token || '');
        setShowPhoneVerify(true);
      } else {
        const redirect = sessionStorage.getItem('afripay_redirect');
        if (redirect) {
          navigate('/login?redirect=' + encodeURIComponent(redirect));
        } else {
          // Signal the login page to show the "verify your email" banner.
          navigate('/login', { state: { emailVerificationRequired: true } });
        }
      }
    } catch (err) {
      toast.error(err.response?.data?.error || t('register.error'));
    } finally {
      setLoading(false);
    }
  };

  const handlePhoneVerify = async (e) => {
    e.preventDefault();
    if (!phoneOtp || phoneOtp.length !== 6) {
      toast.error('Please enter a valid 6-digit OTP');
      return;
    }
    setPhoneVerifyLoading(true);
    try {
      // Authenticate with the phone verification token from register (issue #1522)
      const config = phoneVerificationToken
        ? { headers: { Authorization: `Bearer ${phoneVerificationToken}` } }
        : undefined;
      await api.post('/auth/verify-phone', { phone: registeredPhone, otp: phoneOtp }, config);
      toast.success('Phone number verified successfully!');
      setShowPhoneVerify(false);
      const redirect = sessionStorage.getItem('afripay_redirect');
      if (redirect) {
        navigate('/login?redirect=' + encodeURIComponent(redirect));
      } else {
        // Signal the login page to show the "verify your email" banner.
        navigate('/login', { state: { emailVerificationRequired: true } });
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to verify phone. Please check your OTP and try again.');
    } finally {
      setPhoneVerifyLoading(false);
    }
  };

  const submitDisabled =
    loading || !form.full_name.trim() || !!emailError || !strength.isAcceptable || passwordsMismatch;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col px-6 py-8 transition-colors duration-200">
      <button
        onClick={() => navigate('/')}
        className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white mb-6 flex items-center gap-1 transition-colors"
      >
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      <div className="flex-1 flex flex-col justify-center max-w-sm mx-auto w-full">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
          {t('register.title')}
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mb-8">{t('register.subtitle')}</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm text-gray-600 dark:text-gray-400 mb-1 block">
              {t('register.full_name')}
            </label>
            <input
              type="text"
              required
              placeholder="[Full Name]"
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              onBlur={() => setTouched({ ...touched, full_name: true })}
              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm"
            />
            {touched.full_name && !form.full_name.trim() && (
              <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                <AlertCircle size={12} /> Full name is required
              </p>
            )}
          </div>

          <div>
            <label className="text-sm text-gray-600 dark:text-gray-400 mb-1 block">
              {t('register.email')}
            </label>
            <input
              type="email"
              required
              placeholder="[email]"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              onBlur={() => setTouched({ ...touched, email: true })}
              className={`w-full bg-white dark:bg-gray-800 border rounded-xl px-4 py-3 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm ${
                emailError ? 'border-red-500 dark:border-red-500' : 'border-gray-200 dark:border-gray-700'
              }`}
            />
            {emailError && (
              <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                <AlertCircle size={12} /> {emailError}
              </p>
            )}
          </div>

          <div>
            <label className="text-sm text-gray-600 dark:text-gray-400 mb-1 block">
              {t('register.phone')}
            </label>
            <input
              type="tel"
              placeholder="+254712345678"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm"
            />
          </div>

          <div>
            <label className="text-sm text-gray-600 dark:text-gray-400 mb-1 block">
              {t('register.password')}
            </label>
            <div className="relative">
              <input
                type={showPass ? 'text' : 'password'}
                required
                placeholder="••••••••"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                onBlur={() => setTouched({ ...touched, password: true })}
                className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 pr-12 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm"
              />
              <button
                type="button"
                onClick={() => setShowPass(!showPass)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {form.password && (
              <div className="mt-2 space-y-1">
                {checklist.map((rule) => (
                  <p
                    key={rule.key}
                    className={`text-xs flex items-center gap-1 ${
                      rule.passed ? 'text-green-500' : 'text-gray-400 dark:text-gray-500'
                    }`}
                  >
                    {rule.passed ? <Check size={12} /> : <X size={12} />} {rule.label}
                  </p>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="text-sm text-gray-600 dark:text-gray-400 mb-1 block">
              {t('register.confirm_password')}
            </label>
            <input
              type={showPass ? 'text' : 'password'}
              required
              placeholder="••••••••"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={`w-full bg-white dark:bg-gray-800 border rounded-xl px-4 py-3 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm ${
                passwordsMismatch ? 'border-red-500 dark:border-red-500' : 'border-gray-200 dark:border-gray-700'
              }`}
            />
            {passwordsMismatch && (
              <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                <AlertCircle size={12} /> Passwords do not match
              </p>
            )}
            {passwordsMatch && (
              <p className="text-xs text-green-500 mt-1 flex items-center gap-1">
                <Check size={12} /> Passwords match
              </p>
            )}
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowImport(!showImport)}
              className="text-sm text-primary-500 flex items-center gap-1"
            >
              {showImport ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              {t('register.import_wallet')}
            </button>
            {showImport && (
              <div className="mt-2">
                <div className="relative">
                  <input
                    type={showSecretKey ? 'text' : 'password'}
                    placeholder="S..."
                    value={secretKey}
                    onChange={(e) => {
                      setSecretKey(e.target.value);
                      setSecretKeyError('');
                    }}
                    className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 pr-12 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecretKey(!showSecretKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  >
                    {showSecretKey ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                {secretKeyError && (
                  <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                    <AlertCircle size={12} /> {secretKeyError}
                  </p>
                )}
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={submitDisabled}
            className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-3 transition-colors"
          >
            {loading ? t('common.loading') : t('register.submit')}
          </button>
        </form>

        {showPhoneVerify && (
          <form onSubmit={handlePhoneVerify} className="mt-6 space-y-4">
            <div className="flex items-center gap-2 text-gray-900 dark:text-white">
              <Phone size={18} />
              <h3 className="font-semibold">Verify your phone</h3>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Enter the 6-digit code sent to {registeredPhone}
            </p>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={phoneOtp}
              onChange={(e) => setPhoneOtp(e.target.value.replace(/\D/g, ''))}
              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-center text-2xl tracking-widest text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm"
            />
            <button
              type="submit"
              disabled={phoneVerifyLoading}
              className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-3 transition-colors"
            >
              {phoneVerifyLoading ? t('common.loading') : 'Verify phone'}
            </button>
          </form>
        )}

        <p className="text-center text-sm text-gray-600 dark:text-gray-400 mt-6">
          {t('register.have_account')}{' '}
          <Link to="/login" className="text-primary-500 hover:underline">
            {t('register.login')}
          </Link>
        </p>
      </div>
    </div>
  );
}
