import React, { useState } from 'react';
import { Lock, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import api from '../utils/api';

export default function PINSetupModal({ isOpen, onClose, onSuccess }) {
  const { t } = useTranslation();
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [step, setStep] = useState('create'); // 'create' or 'confirm'
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = (e) => {
    e.preventDefault();
    setError('');

    if (!/^\d{4,6}$/.test(pin)) {
      setError(t('auth.pin_format_error'));
      return;
    }

    setStep('confirm');
    setConfirmPin('');
  };

  const handleConfirm = async (e) => {
    e.preventDefault();
    setError('');

    if (pin !== confirmPin) {
      setError(t('auth.pin_mismatch_error'));
      return;
    }

    setLoading(true);
    try {
      await api.post('/auth/set-pin', { pin });
      toast.success(t('auth.pin_set_success'));
      onSuccess();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || t('auth.pin_error'));
      toast.error(err.response?.data?.error || t('auth.pin_error'));
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setPin('');
    setConfirmPin('');
    setStep('create');
    setError('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-2xl w-full max-w-sm overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between bg-gray-800 px-6 py-4">
          <div className="flex items-center gap-2">
            <Lock size={20} className="text-primary-500" />
            <h3 className="text-lg font-semibold text-white">{t('auth.setup_pin_title')}</h3>
          </div>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X size={24} />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-6">
          <p className="text-gray-400 text-sm mb-6">
            {step === 'create'
              ? t('auth.pin_create_desc')
              : t('auth.pin_confirm_desc')}
          </p>

          <form onSubmit={step === 'create' ? handleCreate : handleConfirm} className="space-y-4">
            {/* Current Step */}
            {step === 'create' && (
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
                  required
                />
                <p className="text-xs text-gray-500 mt-2">{t('auth.pin_format_help')}</p>
              </div>
            )}

            {step === 'confirm' && (
              <>
                <div className="bg-gray-800 rounded-lg p-4 mb-4">
                  <p className="text-xs text-gray-500 mb-2">{t('auth.pin_you_entered')}</p>
                  <p className="text-2xl tracking-widest font-mono text-primary-500">{'●'.repeat(pin.length)}</p>
                </div>

                <div>
                  <label className="text-sm text-gray-400 mb-2 block">{t('auth.pin_confirm_label')}</label>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength="6"
                    placeholder="●●●●"
                    value={confirmPin}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, '');
                      setConfirmPin(val);
                    }}
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-center text-2xl tracking-widest text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
                    required
                  />
                </div>
              </>
            )}

            {/* Error */}
            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            {/* Buttons */}
            <div className="flex gap-3 pt-4">
              {step === 'confirm' && (
                <button
                  type="button"
                  onClick={() => setStep('create')}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 rounded-xl py-3 text-white font-medium transition-colors"
                >
                  {t('common.back')}
                </button>
              )}
              <button
                type="submit"
                disabled={loading}
                className={`flex-1 rounded-xl py-3 font-semibold transition-colors flex items-center justify-center gap-2 ${
                  step === 'create'
                    ? 'bg-primary-500 hover:bg-primary-600 text-white'
                    : 'bg-yellow-500 hover:bg-yellow-600 text-black'
                } disabled:opacity-50`}
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" role="status" aria-label="Loading" />
                ) : (
                  step === 'create' ? t('common.continue') : t('auth.pin_confirm_button')
                )}
              </button>
            </div>
          </form>

          <p className="text-center text-gray-600 text-xs mt-6">
            {t('auth.pin_warning')}
          </p>
        </div>
      </div>
    </div>
  );
}
