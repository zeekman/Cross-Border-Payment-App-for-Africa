import React, { useEffect, useState } from 'react';
import { Copy, CheckCheck, Users, Gift, Share2, Clock, AlertCircle, CheckCircle } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import api from '../utils/api';
import toast from 'react-hot-toast';

const DEEP_LINK_PREFIX = 'afripay://register';

const STATUS_CONFIG = {
  pending: { icon: Clock, color: 'text-yellow-500', bg: 'bg-yellow-50 dark:bg-yellow-900', label: 'Pending' },
  credited: { icon: CheckCircle, color: 'text-green-500', bg: 'bg-green-50 dark:bg-green-900', label: 'Credited' },
  failed: { icon: AlertCircle, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-900', label: 'Failed' },
  ineligible: { icon: AlertCircle, color: 'text-gray-500', bg: 'bg-gray-50 dark:bg-gray-800', label: 'Ineligible' },
};

export default function Referrals() {
  const [stats, setStats] = useState(null);
  const [referrals, setReferrals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showQR, setShowQR] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [statsRes, detailsRes] = await Promise.all([
          api.get('/referrals/stats'),
          api.get('/referrals/details'),
        ]);
        setStats(statsRes.data);
        setReferrals(detailsRes.data.referrals || []);
      } catch (err) {
        toast.error('Failed to load referral data');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const code = stats?.referral_code || '';
  const webLink = code ? `${window.location.origin}/register?ref=${code}` : '';
  const deepLink = code ? `${DEEP_LINK_PREFIX}?ref=${code}` : '';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(webLink);
      setCopied(true);
      toast.success('Referral link copied!');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy referral link');
    }
  };

  const handleShare = async () => {
    const shareData = {
      title: 'Join AfriPay',
      text: `Use my referral link to join AfriPay and earn rewards: ${webLink}`,
      url: webLink,
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch {
        // user cancelled
      }
    } else {
      handleCopy();
    }
  };

  const formatDate = (date) => {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
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

      {/* Total Rewards Earned Summary */}
      <div className="bg-gradient-to-r from-primary-500 to-primary-600 rounded-2xl p-5 shadow-md mb-4 text-white">
        <p className="text-sm opacity-90 mb-1">Total Rewards Earned</p>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold">{stats?.total_rewards_earned || 0}</span>
          <span className="text-sm opacity-75">loyalty points</span>
        </div>
        <p className="text-xs opacity-75 mt-2">
          From {stats?.first_payments_completed || 0} completed referral reward{stats?.first_payments_completed === 1 ? '' : 's'}
        </p>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-2xl p-5 shadow-sm mb-4">
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Invite friends to AfriPay. When they complete their first transaction, you earn a{' '}
          <span className="font-semibold text-primary-500">
            {(stats?.credit_per_referral_bps ?? 0) / 100}% fee discount credit
          </span>{' '}
          (valid 90 days).
        </p>

        <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">Your referral link</label>
        <div className="flex items-center gap-2 mb-3">
          <input
            readOnly
            value={webLink}
            className="flex-1 bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 text-sm rounded-xl px-3 py-2 truncate"
          />
          <button
            onClick={handleCopy}
            className="p-2 rounded-xl bg-primary-500 text-white hover:bg-primary-600 transition-colors"
            aria-label="Copy referral link"
          >
            {copied ? <CheckCheck size={18} /> : <Copy size={18} />}
          </button>
          <button
            onClick={handleShare}
            className="p-2 rounded-xl bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
            aria-label="Share referral link"
          >
            <Share2 size={18} />
          </button>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setShowQR((v) => !v)}
            className="text-xs text-primary-500 hover:text-primary-400 font-medium transition-colors"
          >
            {showQR ? 'Hide QR code' : 'Show QR code'}
          </button>
        </div>

        {showQR && (
          <div className="flex justify-center mt-4">
            <div className="bg-white rounded-xl p-4 inline-flex flex-col items-center gap-2">
              <QRCodeCanvas value={deepLink} size={160} level="M" />
              <p className="text-xs text-gray-500">Scan to join AfriPay</p>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 mb-6">
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

      {/* Referral Status List */}
      {referrals.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-2xl p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Referral Status</h2>
          <div className="space-y-3">
            {referrals.map((ref) => {
              const config = STATUS_CONFIG[ref.reward_status] || STATUS_CONFIG.ineligible;
              const Icon = config.icon;

              return (
                <div
                  key={ref.referral_id}
                  className={`flex items-start justify-between p-3 rounded-xl border border-gray-200 dark:border-gray-700 ${config.bg}`}
                >
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <Icon size={20} className={`${config.color} flex-shrink-0 mt-0.5`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                        {ref.email}
                      </p>
                      <p className="text-xs text-gray-600 dark:text-gray-400">
                        Referred: {formatDate(ref.referred_at)}
                      </p>
                      {ref.reward_status === 'credited' && ref.reward_claimed_at && (
                        <p className="text-xs text-gray-600 dark:text-gray-400">
                          Claimed: {formatDate(ref.reward_claimed_at)}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0 ml-2">
                    <span className={`text-xs font-semibold ${config.color}`}>
                      {config.label}
                    </span>
                    {ref.reward_amount && (
                      <span className="text-xs text-gray-600 dark:text-gray-400">
                        {ref.reward_amount} pts
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {referrals.length === 0 && !loading && (
        <div className="bg-white dark:bg-gray-900 rounded-2xl p-8 shadow-sm text-center">
          <Users size={32} className="mx-auto text-gray-400 mb-3" />
          <p className="text-sm text-gray-600 dark:text-gray-400">
            No referrals yet. Share your referral link to get started!
          </p>
        </div>
      )}
    </div>
  );
}
