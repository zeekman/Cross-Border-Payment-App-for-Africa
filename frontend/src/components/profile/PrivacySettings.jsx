import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Download, Trash2, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../utils/api';
import useStepUp from '../../hooks/useStepUp';
import { getErrorMessage } from '../../utils/apiError';
import { clearUserStorage } from '../../utils/userStorage';
import { clearUserPrefs } from '../../utils/userPrefs';

export const DELETE_CONFIRMATION_WORD = 'DELETE';

/**
 * Profile → Privacy (FE-211).
 *
 * - Download my data: step-up (PIN) → `POST /account/export`; the link is
 *   emailed. Past exports are listed with their expiry.
 * - Delete AfriPay account: multi-step. It explains what is deleted and what
 *   is retained (and why), requires a zero balance first (with links to move
 *   funds), then password + PIN and the typed word "DELETE".
 *
 * Distinct from "Close Stellar account" (CloseAccount.jsx), which merges the
 * on-chain account but leaves the AfriPay profile and data in place.
 */

/** True when every balance is zero, or the Stellar account no longer exists (already merged). */
export function hasZeroBalance(balances) {
  return (balances || []).every((b) => !(parseFloat(b.balance) > 0));
}

function ExportSection() {
  const { t } = useTranslation();
  const { requestStepUp, stepUpModal } = useStepUp();
  const [exports, setExports] = useState([]);
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadExports = useCallback(() => {
    api
      .get('/account/exports')
      .then((r) => setExports(Array.isArray(r.data?.exports) ? r.data.exports : []))
      .catch(() => setExports([]));
  }, []);

  useEffect(loadExports, [loadExports]);

  const requestExport = async () => {
    const stepUpToken = await requestStepUp();
    if (!stepUpToken) return;
    setBusy(true);
    try {
      await api.post('/account/export', {}, { headers: { 'X-Step-Up-Token': stepUpToken } });
      setRequested(true);
      loadExports();
    } catch (err) {
      toast.error(getErrorMessage(err, t, 'errors.export_failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="privacy-export-title" className="space-y-3">
      <h4 id="privacy-export-title" className="font-medium text-white flex items-center gap-2">
        <Download size={16} aria-hidden="true" /> {t('privacy.export.title')}
      </h4>
      <p className="text-xs text-gray-400">{t('privacy.export.description')}</p>
      {requested ? (
        <p role="status" className="text-sm text-green-400" data-testid="export-requested">
          {t('privacy.export.requested')}
        </p>
      ) : (
        <button
          type="button"
          onClick={requestExport}
          disabled={busy}
          className="w-full bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm"
        >
          {busy ? t('common.loading') : t('privacy.export.button')}
        </button>
      )}
      {exports.length > 0 && (
        <ul className="space-y-1" aria-label={t('privacy.export.history')}>
          {exports.map((x) => (
            <li key={x.id} className="flex justify-between text-xs text-gray-400">
              <span>{new Date(x.created_at).toLocaleString()}</span>
              <span>
                {x.status === 'ready' && x.expires_at
                  ? t('privacy.export.expires', { date: new Date(x.expires_at).toLocaleDateString() })
                  : t(`privacy.export.status_${x.status}`, { defaultValue: x.status })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {stepUpModal}
    </section>
  );
}

function DeleteSection() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const [step, setStep] = useState('idle'); // idle → explain → credentials
  const [balanceState, setBalanceState] = useState('unknown'); // unknown | zero | nonzero | error
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);

  const checkBalance = useCallback(async () => {
    setBalanceState('unknown');
    try {
      const r = await api.get('/wallet/balance');
      setBalanceState(hasZeroBalance(r.data?.balances) ? 'zero' : 'nonzero');
    } catch (err) {
      // An already-merged Stellar account has no balances to move.
      setBalanceState(err?.response?.status === 404 ? 'zero' : 'error');
    }
  }, []);

  const start = () => {
    setStep('explain');
    checkBalance();
  };

  const canSubmit =
    balanceState === 'zero' && password && /^\d{4,6}$/.test(pin) && confirmation === DELETE_CONFIRMATION_WORD && !busy;

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      await api.delete('/account', { data: { password, pin, confirmation } });
      toast.success(t('privacy.delete.done'));
      clearUserPrefs(user?.id);
      await logout(); // clears tokens, user storage, queued payments and API caches
      clearUserStorage();
      window.location.assign('/');
    } catch (err) {
      toast.error(getErrorMessage(err, t, 'errors.delete_failed'));
      setBusy(false);
    }
  };

  if (step === 'idle') {
    return (
      <section aria-labelledby="privacy-delete-title" className="space-y-2">
        <h4 id="privacy-delete-title" className="font-medium text-white flex items-center gap-2">
          <Trash2 size={16} aria-hidden="true" /> {t('privacy.delete.title')}
        </h4>
        <p className="text-xs text-gray-400">{t('privacy.delete.vs_close')}</p>
        <button
          type="button"
          onClick={start}
          className="w-full bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 font-semibold py-2.5 rounded-xl text-sm"
        >
          {t('privacy.delete.start')}
        </button>
      </section>
    );
  }

  return (
    <section aria-labelledby="privacy-delete-title" className="space-y-3" data-testid="delete-account-flow">
      <h4 id="privacy-delete-title" className="font-medium text-white flex items-center gap-2">
        <Trash2 size={16} aria-hidden="true" /> {t('privacy.delete.title')}
      </h4>
      <div className="text-xs text-gray-300 space-y-1">
        <p className="font-semibold">{t('privacy.delete.deleted_heading')}</p>
        <p>{t('privacy.delete.deleted_items')}</p>
        <p className="font-semibold pt-1">{t('privacy.delete.retained_heading')}</p>
        <p>{t('privacy.delete.retained_items')}</p>
      </div>

      {balanceState === 'unknown' && <p className="text-xs text-gray-400">{t('common.loading')}</p>}
      {balanceState === 'error' && (
        <p role="alert" className="text-xs text-red-400">
          {t('privacy.delete.balance_error')}{' '}
          <button type="button" onClick={checkBalance} className="underline">{t('common.retry')}</button>
        </p>
      )}
      {balanceState === 'nonzero' && (
        <div role="alert" className="text-xs text-amber-400 space-y-1" data-testid="delete-blocked-balance">
          <p>{t('privacy.delete.balance_blocked')}</p>
          <p>
            <Link to="/send" className="underline">{t('privacy.delete.move_funds_send')}</Link>
            {' · '}
            <span>{t('privacy.delete.move_funds_merge')}</span>
          </p>
          <button type="button" onClick={checkBalance} className="underline">{t('privacy.delete.recheck')}</button>
        </div>
      )}

      {balanceState === 'zero' && step === 'explain' && (
        <button
          type="button"
          onClick={() => setStep('credentials')}
          className="w-full bg-red-500/10 border border-red-500/20 text-red-400 font-semibold py-2.5 rounded-xl text-sm"
        >
          {t('privacy.delete.continue')}
        </button>
      )}

      {balanceState === 'zero' && step === 'credentials' && (
        <form onSubmit={submit} className="space-y-2">
          <label className="block text-xs text-gray-300">
            {t('privacy.delete.password')}
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input mt-1 w-full"
              required
            />
          </label>
          <label className="block text-xs text-gray-300">
            {t('privacy.delete.pin')}
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="input mt-1 w-full"
              required
            />
          </label>
          <label className="block text-xs text-gray-300">
            {t('privacy.delete.type_confirm', { word: DELETE_CONFIRMATION_WORD })}
            <input
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              className="input mt-1 w-full"
              autoComplete="off"
              required
            />
          </label>
          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm"
          >
            {busy ? t('common.loading') : t('privacy.delete.confirm_button')}
          </button>
        </form>
      )}

      <button type="button" onClick={() => setStep('idle')} className="text-xs text-gray-400 underline">
        {t('common.cancel')}
      </button>
    </section>
  );
}

export default function PrivacySettings() {
  const { t } = useTranslation();
  return (
    <div className="card space-y-5">
      <h3 className="font-semibold text-white flex items-center gap-2">
        <ShieldCheck size={18} aria-hidden="true" /> {t('privacy.title')}
      </h3>
      <ExportSection />
      <DeleteSection />
    </div>
  );
}
