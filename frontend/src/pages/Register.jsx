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
      await register(payload);
      toast.success(t('register.success'));
      // If phone was provided, show verification step (issue #478)
      if (form.phone && form.phone.trim()) {
        setRegisteredPhone(form.phone);
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
      await api.post('/auth/verify-phone', { phone: registeredPhone, otp: phoneOtp });
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
              placeholder="+234..."
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
                minLength={policy.min_length}
                placeholder={t('register.password_placeholder')}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                onBlur={() => setTouched({ ...touched, password: true })}
                className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors pr-12 shadow-sm"
              />
              <button
                type="button"
                onClick={() => setShowPass(!showPass)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-white transition-colors"
              >
                {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>

            {/* Strength indicator (issue #656) — hidden when password is empty */}
            {form.password && (
              <div className="mt-2 space-y-2" aria-live="polite">
                <div className="flex gap-1">
                  {[1, 2, 3, 4].map((i) => (
                    <div
                      key={i}
                      className={`h-1.5 flex-1 rounded-full transition-colors ${
                        i <= strength.score ? strength.barColor : 'bg-gray-200 dark:bg-gray-700'
                      }`}
                    />
                  ))}
                </div>
                <p className={`text-xs font-medium ${strength.textColor}`}>
                  {strength.label}
                </p>
                <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
                  {checklist.map(({ key, label }) => (
                    <li
                      key={key}
                      className={`flex items-center gap-1.5 text-xs ${
                        strength.checks[key] ? 'text-green-500' : 'text-gray-400 dark:text-gray-500'
                      }`}
                    >
                      {strength.checks[key] ? <Check size={12} /> : <X size={12} />} {label}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Confirm password (issue #656) */}
          <div>
            <label className="text-sm text-gray-600 dark:text-gray-400 mb-1 block">
              Confirm password
            </label>
            <div className="relative">
              <input
                type={showPass ? 'text' : 'password'}
                placeholder="Re-enter your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={`w-full bg-white dark:bg-gray-800 border rounded-xl px-4 py-3 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors pr-12 shadow-sm ${
                  passwordsMismatch
                    ? 'border-red-500 dark:border-red-500'
                    : passwordsMatch
                    ? 'border-green-500 dark:border-green-500'
                    : 'border-gray-200 dark:border-gray-700'
                }`}
              />
              {passwordsMatch && (
                <Check size={18} className="absolute right-3 top-1/2 -translate-y-1/2 text-green-500" />
              )}
            </div>
            {passwordsMismatch && (
              <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                <AlertCircle size={12} /> Passwords do not match
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={submitDisabled}
            className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3.5 rounded-xl transition-colors mt-2"
          >
            {loading ? t('register.submitting') : t('register.submit')}
          </button>

          {/* Import existing wallet */}
          <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => {
                setShowImport((v) => !v);
                setSecretKey('');
                setSecretKeyError('');
                setShowSecretKey(false);
              }}
              className="w-full flex items-center justify-between px-4 py-3 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <span>Already have a Stellar wallet? Import it</span>
              {showImport ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {showImport && (
              <div className="px-4 pb-4 space-y-2 bg-gray-50 dark:bg-gray-800/50">
                <p className="text-xs text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-500/10 border border-yellow-200 dark:border-yellow-500/30 rounded-lg p-2">
                  ⚠️ Never share your secret key.
                </p>
                <div className="relative">
                  <input
                    type={showSecretKey ? 'text' : 'password'}
                    placeholder="Stellar secret key (starts with S…)"
                    value={secretKey}
                    onChange={(e) => {
                      setSecretKey(e.target.value);
                      setSecretKeyError('');
                    }}
                    className={`w-full bg-white dark:bg-gray-800 border rounded-xl px-4 py-3 text-gray-900 dark:text-white placeholder-gray-400 font-mono text-sm focus:outline-none focus:border-primary-500 transition-colors pr-12 ${secretKeyError ? 'border-red-500' : 'border-gray-200 dark:border-gray-700'}`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecretKey((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-white transition-colors"
                    aria-label={showSecretKey ? 'Hide secret key' : 'Show secret key'}
                  >
                    {showSecretKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {secretKeyError && <p className="text-xs text-red-500">{secretKeyError}</p>}
              </div>
            )}
          </div>
        </form>

        <p className="text-center text-gray-500 mt-6 text-sm">
          {t('register.have_account')}{' '}
          <Link to="/login" className="text-primary-500 hover:underline">
            {t('register.sign_in')}
          </Link>
        </p>
      </div>

      {/* Phone Verification Step (issue #478) */}
      {showPhoneVerify && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-sm space-y-4">
            <div className="text-center">
              <Phone size={32} className="text-primary-500 mx-auto mb-3" />
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">Verify Your Phone</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                We sent a 6-digit OTP to {registeredPhone}
              </p>
            </div>
            <form onSubmit={handlePhoneVerify} className="space-y-4">
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                required
                placeholder="Enter 6-digit OTP"
                value={phoneOtp}
                onChange={(e) => setPhoneOtp(e.target.value.replace(/\D/g, ''))}
                className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-900 dark:text-white text-center text-xl font-mono tracking-widest placeholder-gray-400 focus:outline-none focus:border-primary-500"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
                For security, please log in first to complete phone verification.
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowPhoneVerify(false);
                    navigate('/login');
                  }}
                  className="flex-1 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-900 dark:text-white text-sm font-medium py-2.5 rounded-xl transition-colors"
                >
                  Skip for Now
                </button>
                <button
                  type="submit"
                  disabled={phoneVerifyLoading || phoneOtp.length !== 6}
                  className="flex-1 bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm font-semibold py-2.5 rounded-xl transition-colors"
                >
                  {phoneVerifyLoading ? 'Verifying…' : 'Verify & Login'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
