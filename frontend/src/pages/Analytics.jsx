import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, TrendingUp } from 'lucide-react';
import api from '../utils/api';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

export default function Analytics() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAnalytics = async () => {
      try {
        const res = await api.get('/analytics/summary');
        setData(res.data);
      } catch (err) {
        toast.error(t('analytics.error') || 'Failed to load analytics');
      } finally {
        setLoading(false);
      }
    };
    fetchAnalytics();
  }, [t]);

  if (loading) {
    return (
      <div className="px-4 py-6 max-w-lg mx-auto flex items-center justify-center min-h-screen" role="status" aria-label="Loading">
        <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const totalSpent = data?.asset_breakdown?.reduce((sum, item) => sum + parseFloat(item.total || 0), 0) || 0;
  const totalTransactions = data?.asset_breakdown?.reduce((sum, item) => sum + item.count, 0) || 0;

  return (
    <div className="px-4 py-6 max-w-lg mx-auto pb-20">
      <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white mb-6 flex items-center gap-1">
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      <div className="flex items-center gap-2 mb-6">
        <TrendingUp size={24} className="text-primary-500" />
        <h2 className="text-2xl font-bold text-white">{t('analytics.title') || 'Analytics'}</h2>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="bg-gray-800 rounded-xl p-4">
          <p className="text-gray-400 text-xs mb-1">{t('analytics.total_spent') || 'Total Spent'}</p>
          <p className="text-white text-lg font-bold">{totalSpent.toFixed(2)}</p>
        </div>
        <div className="bg-gray-800 rounded-xl p-4">
          <p className="text-gray-400 text-xs mb-1">{t('analytics.transactions') || 'Transactions'}</p>
          <p className="text-white text-lg font-bold">{totalTransactions}</p>
        </div>
      </div>

      {/* Asset Breakdown */}
      {data?.asset_breakdown && data.asset_breakdown.length > 0 && (
        <div className="bg-gray-800 rounded-xl p-4 mb-6">
          <h3 className="text-white font-semibold mb-3">{t('analytics.asset_breakdown') || 'Asset Breakdown'}</h3>
          <div className="space-y-2">
            {data.asset_breakdown.map(item => (
              <div key={item.asset} className="flex items-center justify-between">
                <div className="flex-1">
                  <p className="text-sm text-gray-300">{item.asset}</p>
                  <div className="w-full bg-gray-700 rounded-full h-2 mt-1">
                    <div
                      className="bg-primary-500 h-2 rounded-full"
                      style={{ width: `${(parseFloat(item.total) / totalSpent) * 100}%` }}
                    />
                  </div>
                </div>
                <p className="text-sm text-white font-mono ml-2">{parseFloat(item.total).toFixed(2)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top Recipients */}
      {data?.top_recipients && data.top_recipients.length > 0 && (
        <div className="bg-gray-800 rounded-xl p-4 mb-6">
          <h3 className="text-white font-semibold mb-3">{t('analytics.top_recipients') || 'Top Recipients'}</h3>
          <div className="space-y-2">
            {data.top_recipients.map((recipient, idx) => (
              <div key={recipient.recipient_address} className="flex items-center justify-between py-2 border-b border-gray-700 last:border-0">
                <div>
                  <p className="text-xs text-gray-400">#{idx + 1}</p>
                  <p className="text-xs text-gray-300 font-mono">{recipient.recipient_address.slice(0, 16)}...</p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-white font-semibold">{parseFloat(recipient.total_amount).toFixed(2)}</p>
                  <p className="text-xs text-gray-400">{recipient.count} {t('analytics.transactions_label') || 'txs'}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Monthly Activity */}
      {data?.transaction_frequency && data.transaction_frequency.length > 0 && (
        <div className="bg-gray-800 rounded-xl p-4">
          <h3 className="text-white font-semibold mb-3">{t('analytics.monthly_activity') || 'Monthly Activity'}</h3>
          <div className="space-y-2">
            {data.transaction_frequency.slice(0, 10).map(item => (
              <div key={item.date} className="flex items-center justify-between">
                <p className="text-xs text-gray-400">{new Date(item.date).toLocaleDateString()}</p>
                <div className="flex items-center gap-2">
                  <div className="w-24 bg-gray-700 rounded h-1.5">
                    <div
                      className="bg-primary-500 h-1.5 rounded"
                      style={{ width: `${Math.min((item.count / 10) * 100, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-300 w-6 text-right">{item.count}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!data || (data.asset_breakdown?.length === 0 && data.top_recipients?.length === 0) && (
        <div className="text-center py-12">
          <p className="text-gray-400">{t('analytics.no_data') || 'No analytics data available'}</p>
        </div>
      )}
    </div>
  );
}
