import React, { useEffect, useState } from 'react';
import { Activity, Users, DollarSign, TrendingUp, Server } from 'lucide-react';
import api from '../utils/api';
import toast from 'react-hot-toast';

export default function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [stellarStats, setStellarStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/admin/stats'),
      api.get('/admin/stellar-stats')
    ]).then(([statsRes, stellarRes]) => {
      setStats(statsRes.data);
      setStellarStats(stellarRes.data);
    }).catch(() => toast.error('Failed to load admin stats'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="px-4 py-6 max-w-6xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Admin Dashboard</h2>

      {/* Platform Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary-500/10 rounded-lg flex items-center justify-center text-primary-500">
              <Users size={20} />
            </div>
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Total Users</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{stats?.total_users || 0}</p>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary-500/10 rounded-lg flex items-center justify-center text-primary-500">
              <Activity size={20} />
            </div>
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Transactions</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{stats?.total_transactions || 0}</p>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary-500/10 rounded-lg flex items-center justify-center text-primary-500">
              <DollarSign size={20} />
            </div>
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Total Volume</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{parseFloat(stats?.total_volume || 0).toFixed(2)}</p>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary-500/10 rounded-lg flex items-center justify-center text-primary-500">
              <TrendingUp size={20} />
            </div>
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Total Fees</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{parseFloat(stats?.total_fees || 0).toFixed(2)}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Stellar Network Stats */}
      <div className="bg-gradient-to-br from-primary-600 to-primary-700 rounded-2xl p-6 shadow-lg">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center text-white">
            <Server size={20} />
          </div>
          <h3 className="text-xl font-bold text-white">Stellar Network Statistics</h3>
        </div>

        {stellarStats ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="bg-white/10 rounded-lg p-4">
              <p className="text-primary-100 text-sm mb-1">Latest Ledger</p>
              <p className="text-2xl font-bold text-white">{stellarStats.latestLedger?.toLocaleString()}</p>
            </div>

            <div className="bg-white/10 rounded-lg p-4">
              <p className="text-primary-100 text-sm mb-1">Base Fee (stroops)</p>
              <p className="text-2xl font-bold text-white">{stellarStats.baseFee}</p>
            </div>

            <div className="bg-white/10 rounded-lg p-4">
              <p className="text-primary-100 text-sm mb-1">Max Tx Set Size</p>
              <p className="text-2xl font-bold text-white">{stellarStats.maxFee}</p>
            </div>

            <div className="bg-white/10 rounded-lg p-4">
              <p className="text-primary-100 text-sm mb-1">Transactions</p>
              <p className="text-2xl font-bold text-white">{stellarStats.transactionCount}</p>
            </div>

            <div className="bg-white/10 rounded-lg p-4">
              <p className="text-primary-100 text-sm mb-1">Operations</p>
              <p className="text-2xl font-bold text-white">{stellarStats.operationCount}</p>
            </div>

            <div className="bg-white/10 rounded-lg p-4">
              <p className="text-primary-100 text-sm mb-1">Closed At</p>
              <p className="text-sm font-medium text-white">{new Date(stellarStats.closedAt).toLocaleString()}</p>
            </div>
          </div>
        ) : (
          <p className="text-primary-100">Loading network stats...</p>
        )}
      </div>
    </div>
  );
}
