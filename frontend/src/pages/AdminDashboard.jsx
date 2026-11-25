import React, { Suspense, lazy, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Users, DollarSign, TrendingUp, Server, BarChart3, ShieldAlert, CheckCircle, XCircle } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line,
} from 'recharts';
import api from '../utils/api';
import toast from 'react-hot-toast';
import ConfirmModal from '../components/ConfirmModal';

const ContractStateViewer = lazy(() => import('../components/ContractStateViewer'));

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function formatDateLocal(dateStr) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(new Date(dateStr + 'T00:00:00'));
}

function formatDateFull(dateStr) {
  return new Intl.DateTimeFormat('en', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).format(new Date(dateStr + 'T00:00:00'));
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 shadow-xl">
      <p className="text-gray-400 text-xs mb-1">{formatDateFull(label)}</p>
      {payload.map((entry, i) => (
        <p key={i} className="text-sm font-semibold" style={{ color: entry.color }}>
          {entry.name}: {typeof entry.value === 'number' ? entry.value.toLocaleString() : entry.value}
        </p>
      ))}
    </div>
  );
}

/**
 * Map a staged bulk action to the backend endpoint and payload shape.
 * The backend exposes dedicated routes (bulk-suspend / bulk-unsuspend /
 * bulk-export / bulk-kyc-update) rather than a single /admin/users/bulk route.
 */
function buildBulkRequest(action, filter, userIds, reason) {
  switch (action) {
    case 'suspend':
      return { url: '/admin/users/bulk-suspend', payload: { user_ids: userIds, reason } };
    case 'unsuspend':
      return { url: '/admin/users/bulk-unsuspend', payload: { user_ids: userIds } };
    case 'export':
      return { url: '/admin/users/bulk-export', payload: { filter, user_ids: userIds } };
    case 'kyc':
    case 'verify':
      return { url: '/admin/users/bulk-kyc-update', payload: { user_ids: userIds, status: 'verified' } };
    default:
      return null;
  }
}

/** Poll GET /admin/jobs/:jobId until the async export job completes. */
async function pollExportJob(jobId, { intervalMs = 2000, maxAttempts = 60 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await api.get(`/admin/jobs/${jobId}`);
    const job = res.data?.job ?? res.data ?? {};
    const status = job.status;
    if (status === 'completed' || status === 'complete' || status === 'done') {
      return job;
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(job.error || 'Export job failed');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Export job timed out');
}

export default function AdminDashboard() {
  const { t } = useTranslation();
  const [stats, setStats] = useState(null);
  const [dailyStats, setDailyStats] = useState([]);
  const [stellarStats, setStellarStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [chartMode, setChartMode] = useState('volume');

  // ── Bulk user actions state ───────────────────────────────────────────────
  /** Current filter for bulk user selection. */
  const [bulkFilter, setBulkFilter] = useState('unverified');
  /** Users matching the current filter — populated before showing the confirm modal. */
  const [bulkPreviewUsers, setBulkPreviewUsers] = useState([]);
  /** Which action has been staged for confirmation. */
  const [bulkAction, setBulkAction] = useState(null); // 'suspend' | 'unsuspend' | 'export' | 'kyc' | null
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkPreviewLoading, setBulkPreviewLoading] = useState(false);
  /** Reason supplied for suspend actions. */
  const [bulkReason, setBulkReason] = useState('');
  /** Per-user results returned by the backend for the last bulk action. */
  const [bulkResults, setBulkResults] = useState([]);
  /** Download URL for a completed bulk export job. */
  const [bulkExportUrl, setBulkExportUrl] = useState(null);
  // ─────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    Promise.all([
      api.get('/admin/stats'),
      api.get('/admin/daily-stats?days=30'),
      api.get('/admin/stellar-stats'),
    ]).then(([statsRes, dailyRes, stellarRes]) => {
      setStats(statsRes.data);
      setDailyStats(dailyRes.data);
      setStellarStats(stellarRes.data);
    }).catch(() => toast.error(t('adminDashboard.toast.loadStatsFailed')))
      .finally(() => setLoading(false));
  }, [t]);

  /**
   * Fetch a preview of the users that will be affected by the chosen bulk action
   * and filter, then open the confirmation modal.  This ensures the admin reviews
   * the exact list (or a representative sample + total count) before submitting.
   */
  const handleStageBulkAction = async (action) => {
    setBulkPreviewLoading(true);
    try {
      const res = await api.get(`/admin/users?filter=${encodeURIComponent(bulkFilter)}&limit=50`);
      const users = res.data?.users ?? res.data ?? [];
      setBulkPreviewUsers(users);
      setBulkAction(action);
    } catch {
      toast.error(t('adminDashboard.toast.loadAffectedUsersFailed'));
    } finally {
      setBulkPreviewLoading(false);
    }
  };

  /** Execute the confirmed bulk action against the matching backend endpoint. */
  const handleConfirmBulkAction = async () => {
    const request = buildBulkRequest(
      bulkAction,
      bulkFilter,
      bulkPreviewUsers.map((u) => u.id),
      bulkReason
    );
    if (!request) {
      toast.error(t('adminDashboard.toast.unsupportedBulkAction'));
      return;
    }

    setBulkLoading(true);
    setBulkResults([]);
    setBulkExportUrl(null);
    try {
      const res = await api.post(request.url, request.payload);
      const data = res.data ?? {};

      // Per-user results (partial failures) returned by the backend.
      const results = data.results ?? data.users ?? [];
      setBulkResults(results);
      const failed = results.filter((r) => r.success === false || r.error);

      if (bulkAction === 'export') {
        const jobId = data.job_id ?? data.jobId ?? data.job?.id;
        if (jobId) {
          const job = await pollExportJob(jobId);
          const url = job.download_url ?? job.downloadUrl ?? job.url;
          if (url) {
            setBulkExportUrl(url);
            toast.success(t('adminDashboard.toast.exportReady'));
          } else {
            toast.success(t('adminDashboard.toast.exportCompleted'));
          }
        } else {
          toast.success(t('adminDashboard.toast.exportStarted'));
        }
      } else if (failed.length) {
        toast.error(
          t('adminDashboard.toast.bulkPartialFailure', {
            action: bulkAction,
            failed: failed.length,
            total: results.length,
          })
        );
      } else {
        toast.success(
          t('adminDashboard.toast.bulkSuccess', {
            action: bulkAction,
            count: bulkPreviewUsers.length,
          })
        );
      }

      setBulkAction(null);
      setBulkPreviewUsers([]);
      setBulkReason('');
    } catch {
      toast.error(t('adminDashboard.toast.bulkActionFailed'));
    } finally {
      setBulkLoading(false);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-64" role="status" aria-live="polite" aria-label={t('adminDashboard.loading')}>
      <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" aria-hidden="true" />
      <span className="sr-only">{t('adminDashboard.loading')}</span>
    </div>
  );

  const chartData = dailyStats.map((d) => ({
    date: d.date,
    transactions: parseInt(d.tx_count, 10),
    volume: parseFloat(d.volume),
    fees: parseFloat(d.fees),
  }));

  return (
    <div className="px-4 py-6 max-w-6xl mx-auto space-y-6" role="main" aria-label={t('adminDashboard.title')}>
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">{t('adminDashboard.title')}</h2>

      {/* Platform Stats */}
      <div
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4"
        role="group"
        aria-label={t('adminDashboard.platformStats')}
        aria-live="polite"
      >
        <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary-500/10 rounded-lg flex items-center justify-center text-primary-500" aria-hidden="true">
              <Users size={20} />
            </div>
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400" id="stat-total-users-label">{t('adminDashboard.stats.totalUsers')}</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white" aria-labelledby="stat-total-users-label">{stats?.total_users || 0}</p>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary-500/10 rounded-lg flex items-center justify-center text-primary-500" aria-hidden="true">
              <Activity size={20} />
            </div>
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400" id="stat-transactions-label">{t('adminDashboard.stats.transactions')}</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white" aria-labelledby="stat-transactions-label">{stats?.total_transactions || 0}</p>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary-500/10 rounded-lg flex items-center justify-center text-primary-500" aria-hidden="true">
              <DollarSign size={20} />
            </div>
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400" id="stat-volume-label">{t('adminDashboard.stats.totalVolume')}</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white" aria-labelledby="stat-volume-label">{parseFloat(stats?.total_volume || 0).toFixed(2)}</p>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary-500/10 rounded-lg flex items-center justify-center text-primary-500" aria-hidden="true">
              <TrendingUp size={20} />
            </div>
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400" id="stat-fees-label">{t('adminDashboard.stats.totalFees')}</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white" aria-labelledby="stat-fees-label">{parseFloat(stats?.total_fees || 0).toFixed(2)}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Bulk action results (per-user, including partial failures) */}
      {bulkResults.length > 0 && (
        <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-5 shadow-sm" role="region" aria-label={t('adminDashboard.bulkResultsTitle')}>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">{t('adminDashboard.bulkResultsTitle')}</h3>
          <ul className="space-y-2">
            {bulkResults.map((r, i) => {
              const ok = r.success !== false && !r.error;
              return (
                <li key={r.user_id ?? r.id ?? i} className="flex items-center gap-2 text-sm">
                  {ok ? (
                    <CheckCircle size={16} className="text-green-500" aria-hidden="true" />
                  ) : (
                    <XCircle size={16} className="text-red-500" aria-hidden="true" />
                  )}
                  <span className="text-gray-700 dark:text-gray-300">
                    {r.user_id ?? r.id ?? t('adminDashboard.userFallback', { index: i + 1 })}
                  </span>
                  {!ok && (
                    <span className="text-red-500">{r.error || t('adminDashboard.bulkResultFailed')}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Bulk export download */}
      {bulkExportUrl && (
        <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-5 shadow-sm">
          <a
            href={bulkExportUrl}
            className="inline-flex items-center gap-2 text-primary-500 font-semibold hover:underline"
            download
          >
            {t('adminDashboard.downloadExport')}
          </a>
        </div>
      )}

      <Suspense fallback={null}>
        <ContractStateViewer />
      </Suspense>

      {/* … rest of dashboard unchanged … */}
    </div>
  );
}
