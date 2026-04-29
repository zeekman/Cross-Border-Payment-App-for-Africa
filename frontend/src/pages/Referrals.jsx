import React, { useEffect, useState } from 'react';
import { Copy, CheckCheck, Users, Gift } from 'lucide-react';
import api from '../utils/api';
import toast from 'react-hot-toast';

export default function Referrals() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.get('/referrals/stats')
      .then(r => setStats(r.data))
      .catch(() => toast.error('Failed to load referral stats'))
      .finally(() => setLoading(false));
  }, []);

  const referralLink = stats?.referral_code
    ? `${window.location.origin}/register?ref=${stats.referral_code}`
    : '';

  const handleCopy = () => {
    navigator.clipboard.writeText(referralLink);
    setCopied(true);
    toast.success('Referral link copied!');
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 px-4 py-6">
      <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-6">Refer &amp; Earn</h1>

      <div className="bg-white dark:bg-gray-900 rounded-2xl p-5 shadow-sm mb-4">
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Invite friends to AfriPay. When they complete their first transaction, you earn a{' '}
          <span className="font-semibold text-primary-500">
            {stats?.credit_per_referral_bps / 100}% fee discount credit
          </span>{' '}
          (valid 90 days).
        </p>

        <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">Your referral link</label>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={referralLink}
            className="flex-1 bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 text-sm rounded-xl px-3 py-2 truncate"
          />
          <button
            onClick={handleCopy}
            className="p-2 rounded-xl bg-primary-500 text-white hover:bg-primary-600 transition-colors"
            aria-label="Copy referral link"
          >
            {copied ? <CheckCheck size={18} /> : <Copy size={18} />}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white dark:bg-gray-900 rounded-2xl p-4 shadow-sm flex flex-col items-center gap-2">
          <Users size={24} className="text-primary-500" />
          <span className="text-2xl font-bold text-gray-900 dark:text-white">{stats?.referral_count ?? 0}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">Friends referred</span>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-2xl p-4 shadow-sm flex flex-col items-center gap-2">
          <Gift size={24} className="text-green-500" />
          <span className="text-2xl font-bold text-gray-900 dark:text-white">{stats?.active_credits ?? 0}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">Active credits</span>
        </div>
      </div>
    </div>
  );
}
