import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, PiggyBank, Clock } from 'lucide-react';
import api from '../utils/api';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

export default function SaveMoney() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [form, setForm] = useState({
    amount: '',
    lock_period_days: '30'
  });
  const [loading, setLoading] = useState(false);
  const [wallet, setWallet] = useState(null);

  useEffect(() => {
    api.get('/wallet/balance').then(r => setWallet(r.data)).catch(() => {});
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.amount || parseFloat(form.amount) <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }

    const amountXLM = parseFloat(form.amount);
    const xlmBalance = wallet?.balances?.find(b => b.asset === 'XLM')?.balance || 0;

    if (amountXLM > parseFloat(xlmBalance)) {
      toast.error('Insufficient balance');
      return;
    }

    setLoading(true);
    try {
      // Calculate unlock time (current time + lock period in seconds)
      const lockPeriodSeconds = parseInt(form.lock_period_days) * 24 * 60 * 60;
      const unlockTime = Math.floor(Date.now() / 1000) + lockPeriodSeconds;

      // TODO: Integrate with Soroban contract
      // For now, just show a placeholder
      toast.success(`Savings vault feature coming soon! Amount: ${form.amount} XLM, Unlock in ${form.lock_period_days} days`);

      // Navigate back to dashboard
      navigate('/dashboard');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save funds');
    } finally {
      setLoading(false);
    }
  };

  const xlmBalance = wallet?.balances?.find(b => b.asset === 'XLM')?.balance || '0';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors duration-200">
      <div className="px-4 py-6 max-w-lg mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/dashboard')}
            className="p-2 -m-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={24} />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Save Money</h1>
            <p className="text-gray-600 dark:text-gray-400 text-sm">Lock funds for future goals</p>
          </div>
        </div>

        {/* Balance Card */}
        <div className="bg-gradient-to-br from-green-600 to-green-700 rounded-2xl p-5 shadow-lg shadow-green-500/20">
          <p className="text-green-100 text-sm mb-1">Available Balance</p>
          <div className="flex items-end gap-2 mb-4">
            <span className="text-4xl font-bold text-white">{parseFloat(xlmBalance).toFixed(2)}</span>
            <span className="text-green-200 mb-1">XLM</span>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Amount */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Amount to Save (XLM)
            </label>
            <input
              type="number"
              step="0.0000001"
              min="0"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="w-full px-4 py-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent transition-colors"
              placeholder="0.00"
              required
            />
          </div>

          {/* Lock Period */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Lock Period
            </label>
            <select
              value={form.lock_period_days}
              onChange={(e) => setForm({ ...form, lock_period_days: e.target.value })}
              className="w-full px-4 py-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent transition-colors"
            >
              <option value="7">1 Week</option>
              <option value="30">1 Month</option>
              <option value="90">3 Months</option>
              <option value="180">6 Months</option>
              <option value="365">1 Year</option>
            </select>
          </div>

          {/* Info */}
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <Clock className="text-blue-500 mt-0.5" size={20} />
              <div>
                <h3 className="font-medium text-blue-900 dark:text-blue-100">Time-Locked Savings</h3>
                <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                  Your funds will be locked until the selected date. Early withdrawal incurs a 10% penalty.
                  Earn yield from liquidity pools while locked.
                </p>
              </div>
            </div>
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={loading || !form.amount}
            className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-4 px-6 rounded-xl transition-colors flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <PiggyBank size={20} />
                Save Funds
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}