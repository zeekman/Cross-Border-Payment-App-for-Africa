import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../utils/api';
import { useConfirm } from '../../context/ConfirmContext';

export default function CloseAccount() {
  const confirm = useConfirm();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [showCloseAccount, setShowCloseAccount] = useState(false);
  const [closeDestination, setCloseDestination] = useState('');
  const [closePassword, setClosePassword] = useState('');
  const [closeLoading, setCloseLoading] = useState(false);

  const handleCloseAccount = async (e) => {
    e.preventDefault();
    const dest = closeDestination.trim();
    if (!dest.startsWith('G') || dest.length !== 56 || !/^[A-Z0-9]+$/.test(dest)) {
      toast.error('Invalid Stellar destination address. Must be a 56-character public key starting with G.');
      return;
    }
    if (
      !(await confirm(
        t('confirm.close_account', 'This will permanently close your Stellar account and transfer all XLM to the destination. This cannot be undone.'),
        { title: t('confirm.close_account_title', 'Final warning'), confirmLabel: t('confirm.close_account_btn', 'Close account') }
      ))
    )
      return;
    setCloseLoading(true);
    try {
      await api.post('/wallet/merge', { destination: closeDestination, password: closePassword });
      toast.success('Account closed. All XLM transferred to destination.');
      logout();
      navigate('/');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Account merge failed');
    } finally {
      setCloseLoading(false);
    }
  };

  return (
    <>
      {/* Close Account */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-red-500" />
            <h3 className="font-semibold text-white">Close Account</h3>
          </div>
          <button
            onClick={() => setShowCloseAccount((v) => !v)}
            className="text-sm text-red-400 hover:text-red-300"
          >
            {showCloseAccount ? 'Cancel' : 'Close Account'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Permanently close your Stellar account and transfer all XLM to another address. This is
          irreversible.
        </p>
        {showCloseAccount && (
          <form onSubmit={handleCloseAccount} className="space-y-3">
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-xs text-red-400 space-y-1">
              <p className="font-semibold">⚠ This operation is IRREVERSIBLE</p>
              <p>
                Your Stellar account will be permanently closed. All XLM will be transferred to the
                destination address. Any remaining non-XLM assets must be removed first.
              </p>
            </div>
            <input
              type="text"
              required
              placeholder="Destination Stellar address"
              value={closeDestination}
              onChange={(e) => setCloseDestination(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 font-mono focus:outline-none focus:border-red-500"
            />
            <input
              type="password"
              required
              placeholder="Enter your password to confirm"
              value={closePassword}
              onChange={(e) => setClosePassword(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-red-500"
            />
            <button
              type="submit"
              disabled={closeLoading}
              className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
            >
              {closeLoading ? 'Processing…' : 'Permanently Close Account'}
            </button>
          </form>
        )}
      </div>
    </>
  );
}
