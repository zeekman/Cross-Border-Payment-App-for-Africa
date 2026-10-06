import React, { useState, useEffect } from 'react';
import { Lock, X, AlertCircle, Fingerprint } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import api from '../utils/api';

const browserSupportsWebAuthn = () =>
  typeof navigator?.credentials?.get === 'function' &&
  typeof window?.PublicKeyCredential === 'function';

const localFlagSaysRegistered = () =>
  localStorage.getItem('afripay_webauthn_registered') === 'true';

function clearLocalBiometricFlag() {
  localStorage.removeItem('afripay_webauthn_registered');
  localStorage.removeItem('afripay_webauthn_credential_id');
}

async function verifyWebAuthn() {
  const storedId = localStorage.getItem('afripay_webauthn_credential_id');
  if (!storedId) return false;
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const credentialId = Uint8Array.from(atob(storedId), (c) => c.charCodeAt(0));
    await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: credentialId, type: 'public-key' }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    return true;
  } catch {
    return false;
  }
}

export default function PINVerificationModal({ isOpen, onClose, onSuccess, amount, recipient }) {
  const { t } = useTranslation();
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [bioLoading, setBioLoading] = useState(false);
  const [useBiometric, setUseBiometric] = useState(false);
  // null = still checking with the server, true/false once resolved.
  const [biometricServerVerified, setBiometricServerVerified] = useState(null);
  const [biometricNotice, setBiometricNotice] = useState('');

  // A localStorage flag alone is not trustworthy: the credential could have
  // been revoked, or set up on a different device that shares the same
  // browser profile. Confirm with the server before offering the biometric
  // path, and tell the user (instead of silently hiding the option) when it
  // stops working.
  useEffect(() => {
    if (!isOpen) return undefined;

    if (!browserSupportsWebAuthn() || !localFlagSaysRegistered()) {
      setBiometricServerVerified(false);
      return undefined;
    }

    let cancelled = false;
    api.get('/auth/biometric/status')
      .then(({ data }) => {
        if (cancelled) return;
        const registered = !!data?.registered;
        setBiometricServerVerified(registered);
        if (!registered) {
          clearLocalBiometricFlag();
          setBiometricNotice('Biometric login is no longer set up on this account. Use your PIN, or set up biometrics again in Settings.');
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Can't reach the server to confirm — don't silently disable, but
        // don't silently trust localStorage either: explain the fallback.
        setBiometricServerVerified(false);
        setBiometricNotice('Could not verify biometric setup right now. Please use your PIN.');
      });

    return () => { cancelled = true; };
  }, [isOpen]);

  const handleVerify = async (e) => {
    e.preventDefault();
    setError('');

    if (!/^\d{4,6}$/.test(pin)) {
      setError(t('auth.pin_format_error'));
      return;
    }

    setLoading(true);
    try {
      await api.post('/auth/verify-pin', { pin });
      toast.success(t('auth.pin_verified'));
      onSuccess();
      handleClose();
    } catch (err) {
      const newAttempts = attempts + 1;
      setAttempts(newAttempts);
      const errorMsg = err.response?.data?.error || t('auth.pin_error');
      setError(errorMsg);
      toast.error(errorMsg);

      if (newAttempts >= 3) {
        toast.error(t('auth.pin_max_attempts'));
        handleClose();
      }
    } finally {
      setLoading(false);
    }
  };

  const handleBiometric = async () => {
    setBioLoading(true);
    setError('');
    const ok = await verifyWebAuthn();
    setBioLoading(false);
    if (ok) {
      toast.success('Biometric verified');
      onSuccess();
      handleClose();
    } else {
      setError('Biometric verification failed. Please use your PIN.');
      setUseBiometric(false);
    }
  };

  const handleClose = () => {
    setPin('');
    setError('');
    setAttempts(0);
    setUseBiometric(false);
    setBiometricServerVerified(null);
    setBiometricNotice('');
    onClose();
  };

  if (!isOpen) return null;

  const biometricAvailable = !useBiometric && biometricServerVerified === true;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-2xl w-full max-w-sm overflow-hidden">
        <div className="flex items-center justify-between bg-gray-800 px-6 py-4">
          <div className="flex items-center gap-2">
            <Lock size={20} className="text-primary-500" />
            <h3 className="text-lg font-semibold text-white">
              {useBiometric ? 'Biometric Verification' : t('auth.verify_pin_title')}
            </h3>
          </div>
          <button onClick={handleClose} className="text-gray-400 hover:text-white transition-colors">
            <X size={24} />
          </button>
        </div>

        <div className="px-6 py-6">
          <div className="bg-gray-800 rounded-lg p-4 mb-6">
            <p className="text-xs text-gray-500 mb-3">{t('auth.confirming_transaction')}</p>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-gray-400 text-sm">{t('send.confirm_amount')}</span>
                <span className="text-white font-semibold">{amount}</span>
              </div>
              {recipient && (
                <div className="flex justify-between items-center">
                  <span className="text-gray-400 text-sm">{t('send.confirm_to')}</span>
                  <span className="text-gray-300 text-xs font-mono">
                    {recipient.length > 16 ? `${recipient.slice(0, 16)}…` : recipient}
                  </span>
                </div>
              )}
            </div>
          </div>

          {useBiometric ? (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-4 py-4">
                <div className="w-16 h-16 bg-primary-500/10 rounded-full flex items-center justify-center">
                  <Fingerprint size={32} className="text-primary-500" />
                </div>
                <p className="text-gray-300 text-sm text-center">
                  Verify with your fingerprint or face to authorize this transaction.
                </p>
              </div>
              <button
                onClick={handleBiometric}
                disabled={bioLoading}
                className="w-full bg-primary-500 hover:bg-primary-600 text-white font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {bioLoading ? (
                  <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" role="status" />
                ) : (
                  <>
                    <Fingerprint size={18} />
                    Verify with Biometric
                  </>
                )}
              </button>
              <button
                onClick={() => setUseBiometric(false)}
                className="w-full bg-gray-800 hover:bg-gray-700 text-white font-medium py-3 rounded-xl transition-colors"
              >
                Use PIN instead
              </button>
            </div>
          ) : (
            <form onSubmit={handleVerify} className="space-y-4">
              <div>
                <label className="text-sm text-gray-400 mb-2 block">{t('auth.pin_label')}</label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength="6"
                  placeholder="●●●●"
                  value={pin}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, '');
                    setPin(val);
                  }}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-center text-2xl tracking-widest text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
                  autoFocus
                  required
                />
              </div>

              {error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex gap-2">
                  <AlertCircle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-red-400 text-sm font-medium">{error}</p>
                    {attempts > 0 && (
                      <p className="text-red-300 text-xs mt-1">
                        {t('auth.pin_attempts_remaining', { remaining: 3 - attempts })}
                      </p>
                    )}
                  </div>
                </div>
              )}

              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={handleClose}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 rounded-xl py-3 text-white font-medium transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={loading || pin.length < 4}
                  className="flex-1 bg-primary-500 hover:bg-primary-600 rounded-xl py-3 text-white font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {loading ? (
                    <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" role="status" aria-label="Loading" />
                  ) : (
                    t('auth.pin_verify_button')
                  )}
                </button>
              </div>

              {biometricAvailable && (
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => setUseBiometric(true)}
                    className="w-full bg-gray-700/50 hover:bg-gray-700 text-gray-300 font-medium py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
                  >
                    <Fingerprint size={18} />
                    Use fingerprint / Face ID instead
                  </button>
                </div>
              )}

              {biometricNotice && (
                <p className="text-center text-amber-400 text-xs mt-4" role="status" aria-live="polite">
                  {biometricNotice}
                </p>
              )}
            </form>
          )}

          {!useBiometric && (
            <p className="text-center text-gray-600 text-xs mt-6">
              {t('auth.pin_security_note')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
