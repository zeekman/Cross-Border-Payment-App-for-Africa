import React, { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Phone, ShieldCheck, Lock } from 'lucide-react';
import api from '../../utils/api';
import { useAuth } from '../../context/AuthContext';

const OTP_LENGTH = 6;

/**
 * Phone verification card (issue #1523 / FE-191).
 *
 * Shown in Profile when the user has a phone number that is not yet verified.
 * Lets the user enter the 6-digit OTP, resend a code (with a cooldown timer
 * driven by `resend_available_at`), and surfaces the attempts remaining from
 * the error payload. Locks the form after too many failed attempts.
 */
export default function PhoneVerification() {
  const { user, refreshUser } = useAuth();
  const { t } = useTranslation();

  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [attemptsRemaining, setAttemptsRemaining] = useState(null);
  const [locked, setLocked] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const inputRef = useRef(null);

  // Countdown ticker for the resend cooldown.
  useEffect(() => {
    if (!cooldownUntil) {
      setSecondsLeft(0);
      return undefined;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) setCooldownUntil(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const applyCooldown = (resendAvailableAt) => {
    if (!resendAvailableAt) return;
    const ts = new Date(resendAvailableAt).getTime();
    if (!Number.isNaN(ts) && ts > Date.now()) {
      setCooldownUntil(ts);
    }
  };

  const handleCodeChange = (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, OTP_LENGTH);
    setCode(digits);
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    if (locked || submitting) return;
    if (code.length !== OTP_LENGTH) {
      toast.error(t('phoneVerification.enterFullCode'));
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/auth/verify-phone', { code });
      toast.success(t('phoneVerification.verified'));
      setCode('');
      if (refreshUser) await refreshUser();
    } catch (err) {
      const data = err.response?.data || {};
      if (typeof data.attempts_remaining === 'number') {
        setAttemptsRemaining(data.attempts_remaining);
        if (data.attempts_remaining <= 0) setLocked(true);
      }
      if (data.locked || data.code === 'TOO_MANY_ATTEMPTS') {
        setLocked(true);
      }
      applyCooldown(data.resend_available_at);
      toast.error(data.error || t('phoneVerification.verifyFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (resending || secondsLeft > 0 || locked) return;
    setResending(true);
    try {
      const res = await api.post('/auth/verify-phone/resend');
      const data = res.data || {};
      applyCooldown(data.resend_available_at);
      if (typeof data.attempts_remaining === 'number') {
        setAttemptsRemaining(data.attempts_remaining);
      }
      toast.success(t('phoneVerification.resent'));
      inputRef.current?.focus();
    } catch (err) {
      const data = err.response?.data || {};
      applyCooldown(data.resend_available_at);
      if (typeof data.attempts_remaining === 'number') {
        setAttemptsRemaining(data.attempts_remaining);
      }
      toast.error(data.error || t('phoneVerification.resendFailed'));
    } finally {
      setResending(false);
    }
  };

  if (!user?.phone || user?.phone_verified) return null;

  return (
    <div className="bg-gray-900 rounded-2xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Phone size={18} className="text-primary-400" />
        <h3 className="font-semibold text-white">{t('phoneVerification.title')}</h3>
      </div>
      <p className="text-sm text-gray-400">
        {t('phoneVerification.description', { phone: user.phone })}
      </p>

      {locked ? (
        <div className="flex items-center gap-2 text-sm text-red-400">
          <Lock size={16} />
          <span>{t('phoneVerification.locked')}</span>
        </div>
      ) : (
        <form onSubmit={handleVerify} className="space-y-3">
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={OTP_LENGTH}
            value={code}
            onChange={handleCodeChange}
            placeholder={t('phoneVerification.codePlaceholder')}
            aria-label={t('phoneVerification.codeLabel')}
            className="w-full bg-gray-800 text-white text-center tracking-[0.5em] text-lg rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary-500"
          />

          {attemptsRemaining !== null && (
            <p className="text-xs text-gray-400">
              {t('phoneVerification.attemptsRemaining', { count: attemptsRemaining })}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || code.length !== OTP_LENGTH}
            className="w-full flex items-center justify-center gap-2 bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold rounded-xl px-4 py-3"
          >
            <ShieldCheck size={18} />
            {submitting ? t('phoneVerification.verifying') : t('phoneVerification.verify')}
          </button>

          <button
            type="button"
            onClick={handleResend}
            disabled={resending || secondsLeft > 0}
            className="w-full text-sm text-primary-400 hover:text-primary-300 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {secondsLeft > 0
              ? t('phoneVerification.resendIn', { seconds: secondsLeft })
              : t('phoneVerification.resend')}
          </button>
        </form>
      )}
    </div>
  );
}
