import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Trash2, Shield, Key, AlertCircle, Monitor } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../utils/api';
import { useConfirm } from '../../context/ConfirmContext';

export default function SecuritySigners() {
  const confirm = useConfirm();
  const { user } = useAuth();
  const { t } = useTranslation();

  // Security section state (issues #141, #142)
  const [signers, setSigners] = useState(null);
  const [signersLoading, setSignersLoading] = useState(false);
  const [signersError, setSignersError] = useState(null);
  const [inflationDest, setInflationDest] = useState(undefined); // undefined = not loaded
  const [clearingInflation, setClearingInflation] = useState(false);
  const [removingSignerKey, setRemovingSignerKey] = useState(null);

  const loadSigners = async () => {
    setSignersLoading(true);
    setSignersError(null);
    try {
      const res = await api.get('/wallet/signers/horizon');
      setSigners(res.data.signers || []);
      setInflationDest(res.data.inflation_destination);
    } catch {
      setSignersError('Failed to load signer data');
    } finally {
      setSignersLoading(false);
    }
  };

  const handleClearInflation = async () => {
    if (!(await confirm(t('confirm.clear_inflation', 'Clear the inflation destination from your account?'), { title: t('confirm.clear_inflation_title', 'Clear inflation destination'), confirmLabel: t('confirm.clear', 'Clear') }))) return;
    setClearingInflation(true);
    try {
      await api.post('/wallet/clear-inflation-destination');
      setInflationDest(null);
      toast.success('Inflation destination cleared');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to clear inflation destination');
    } finally {
      setClearingInflation(false);
    }
  };

  const handleRemoveSigner = async (signerKey) => {
    if (!(await confirm(t('confirm.remove_signer', 'Remove signer {{key}}…? It will no longer be able to sign for this account.', { key: signerKey.slice(0, 8) }), { title: t('confirm.remove_signer_title', 'Remove signer'), confirmLabel: t('confirm.remove', 'Remove') }))) return;
    setRemovingSignerKey(signerKey);
    try {
      await api.delete(`/wallet/signers/${signerKey}`);
      setSigners((prev) => prev.filter((s) => s.key !== signerKey));
      toast.success('Signer removed');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to remove signer');
    } finally {
      setRemovingSignerKey(null);
    }
  };

  return (
    <>
      {/* Security — Signers & Inflation Destination (issues #141, #142) */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-primary-400" />
            <h3 className="font-semibold text-white">Security</h3>
          </div>
          <button
            onClick={loadSigners}
            disabled={signersLoading}
            className="text-sm text-primary-500 hover:text-primary-400 disabled:opacity-50"
          >
            {signersLoading ? 'Loading…' : signers === null ? 'Load' : 'Refresh'}
          </button>
        </div>

        {/* Active sessions link (#466) */}
        <Link
          to="/sessions"
          className="flex items-center justify-between bg-gray-800 hover:bg-gray-700 rounded-xl px-4 py-3 mb-4 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Monitor size={15} className="text-gray-400" />
            <span className="text-sm text-white">Active Sessions</span>
          </div>
          <span className="text-gray-500 text-lg">›</span>
        </Link>

        {signersError && <p className="text-red-400 text-xs mb-3">{signersError}</p>}

        {/* Inflation destination notice */}
        {inflationDest && (
          <div className="mb-4 bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3 flex items-start gap-3">
            <AlertCircle size={15} className="text-yellow-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-yellow-400 text-xs font-semibold mb-0.5">
                Legacy inflation destination set
              </p>
              <p className="text-yellow-300/70 text-xs font-mono truncate">{inflationDest}</p>
              <p className="text-gray-500 text-xs mt-1">
                Stellar removed inflation in Protocol 12. This is harmless but can be cleared.
              </p>
            </div>
            <button
              onClick={handleClearInflation}
              disabled={clearingInflation}
              className="text-xs bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50 shrink-0"
            >
              {clearingInflation ? '…' : 'Clear'}
            </button>
          </div>
        )}

        {/* Signers list */}
        {signers !== null && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500 mb-2">Account signers from Horizon</p>
            {signers.map((s) => {
              const isMaster = s.type === 'ed25519_public_key' && s.key === user?.wallet_address;
              return (
                <div
                  key={s.key}
                  className="flex items-center gap-3 bg-gray-800 rounded-xl px-3 py-2.5"
                >
                  <Key size={13} className="text-gray-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-mono text-white truncate">
                      {s.key.slice(0, 8)}…{s.key.slice(-8)}
                    </p>
                    <p className="text-xs text-gray-500">
                      Weight: {s.weight} · {s.type.replace(/_/g, ' ')}
                      {isMaster && <span className="ml-1 text-primary-400">(master)</span>}
                    </p>
                  </div>
                  {!isMaster && (
                    <button
                      onClick={() => handleRemoveSigner(s.key)}
                      disabled={removingSignerKey === s.key}
                      className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
                      aria-label="Remove signer"
                    >
                      {removingSignerKey === s.key ? '…' : <Trash2 size={13} />}
                    </button>
                  )}
                </div>
              );
            })}
            {signers.length === 0 && (
              <p className="text-gray-500 text-xs text-center py-2">No signers found.</p>
            )}
          </div>
        )}

        {signers === null && !signersLoading && (
          <p className="text-gray-600 text-xs text-center py-2">
            Click "Load" to fetch live signer data from Horizon.
          </p>
        )}
      </div>
    </>
  );
}
