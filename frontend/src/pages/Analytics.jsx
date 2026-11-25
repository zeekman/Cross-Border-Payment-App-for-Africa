import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, TrendingUp, Download, FileText, Loader2, RefreshCw, AlertCircle } from 'lucide-react';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

/** Analytics data is considered stale after this many minutes. */
const STALE_THRESHOLD_MINUTES = 60;


function toDateInput(d) {
  return d.toISOString().slice(0, 10);
}

function defaultRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return { from: toDateInput(from), to: toDateInput(to) };
}

export default function Analytics() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { user } = useAuth();

  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState(null);
  const [refreshedAt, setRefreshedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [csvLoading, setCsvLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const abortRef = useRef(null);

  const isAdmin = user?.role === 'admin';

  const fetchAnalytics = useCallback(async () => {
    // Cancel any in-flight request to prevent stale responses overwriting newer ones
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const res = await api.get(`/payments/analytics?from=${range.from}&to=${range.to}`, {
        signal: controller.signal,
      });
      setData(res.data);
      // Backend (BE-021) returns refreshed_at on the analytics response;
      // fall back to the current time if the field is absent.
      setRefreshedAt(res.data?.refreshed_at ? new Date(res.data.refreshed_at) : new Date());
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      toast.error(t('analytics.error') || 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to, t]);

  /**
   * Trigger a server-side materialized-view refresh (BE-021 admin endpoint),
   * then re-fetch the analytics data.  Admin-only; the backend enforces the role
   * check and the control is only rendered for admins.
   */
  const handleManualRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await api.post('/analytics/refresh');
      toast.success('Analytics data refreshed');
      // Re-fetch with fresh data
      await fetchAnalytics();
    } catch (err) {
      if (err?.response?.status === 403) {
        toast.error('Only admins can trigger a manual refresh');
      } else {
        toast.error('Refresh failed — please try again');
      }
    } finally {
      setRefreshing(false);
    }
  }, [fetchAnalytics]);

  useEffect(() => {
    fetchAnalytics();
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [fetchAnalytics]);

  const totalSpent = data?.asset_breakdown?.reduce((sum, item) => sum + parseFloat(item.total || 0), 0) || 0;
  const totalTransactions = data?.asset_breakdown?.reduce((sum, item) => sum + item.count, 0) || 0;
  const noData = totalTransactions === 0;

  const handleExportCSV = async () => {
    if (noData) return;
    setCsvLoading(true);
    try {
      const res = await api.get('/payments/export', {
        params: { format: 'csv', from: range.from, to: range.to },
        responseType: 'blob',
      });
      const blob = new Blob([res.data], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `transactions_${range.from}_to_${range.to}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      toast.error('CSV export failed');
    } finally {
      setCsvLoading(false);
    }
  };

  const handleExportPDF = () => {
    if (noData) return;
    setPdfLoading(true);
    // Small delay so spinner renders before print dialog blocks the thread
    setTimeout(() => {
      window.print();
      setPdfLoading(false);
    }, 50);
  };

  const printDate = new Date().toLocaleDateString();
  const userName = user?.full_name || user?.email || 'User';

  // Build print-table rows from transaction_frequency + asset_breakdown
  const printRows = data?.transaction_frequency?.map((item) => ({
    date: new Date(item.date).toLocaleDateString(),
    description: 'Transaction activity',
    amount: '-',
    status: '-',
    txId: '-',
  })) || [];

  if (loading) {
    return (
      <div className="px-4 py-6 max-w-lg mx-auto flex items-center justify-center min-h-screen" role="status" aria-label="Loading">
        <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <>
      {/* ── Print stylesheet ── */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #print-report, #print-report * { visibility: visible !important; }
          #print-report { position: fixed; inset: 0; padding: 24px; background: white; color: black; }
          #print-report table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 11px; }
          #print-report th, #print-report td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
          #print-report th { background: #f0f0f0; }
          #print-footer { margin-top: 24px; font-size: 10px; color: #555; }
          .no-print { display: none !important; }
        }
      `}</style>

      {/* ── Hidden print report ── */}
      <div id="print-report" style={{ display: 'none' }} aria-hidden="true">
        <h1 style={{ fontSize: 22, fontWeight: 'bold', marginBottom: 4 }}>AfriPay</h1>
        <p style={{ marginBottom: 2 }}><strong>Account:</strong> {userName}</p>
        <p style={{ marginBottom: 2 }}><strong>Date Range:</strong> {range.from} — {range.to}</p>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Transaction ID</th>
            </tr>
          </thead>
          <tbody>
            {printRows.length > 0 ? printRows.map((row, i) => (
              <tr key={i}>
                <td>{row.date}</td>
                <td>{row.description}</td>
                <td>{row.amount}</td>
                <td>{row.status}</td>
                <td>{row.txId}</td>
              </tr>
            )) : (
              <tr><td colSpan={5} style={{ textAlign: 'center' }}>No transaction data in selected range</td></tr>
            )}
          </tbody>
        </table>
        <div id="print-footer">
          Generated by AfriPay on {printDate}. This is not a bank statement.
        </div>
      </div>

      {/* ── Screen UI ── */}
      <div className="px-4 py-6 max-w-lg mx-auto pb-20 no-print">
        <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white mb-6 flex items-center gap-1">
          <ArrowLeft size={18} /> {t('common.back')}
        </button>

        <div className="flex items-center gap-2 mb-4">
          <TrendingUp size={24} className="text-primary-500" />
          <h2 className="text-2xl font-bold text-white">{t('analytics.title') || 'Analytics'}</h2>
        </div>

        {/* Data-as-of timestamp + stale indicator + manual refresh */}
        {refreshedAt && (
          <div
            className={`flex items-center justify-between gap-3 rounded-xl px-4 py-3 mb-4 border ${
              (Date.now() - refreshedAt.getTime()) / 60000 > STALE_THRESHOLD_MINUTES
                ? 'bg-yellow-500/10 border-yellow-500/30'
                : 'bg-gray-800/50 border-gray-700'
            }`}
          >
            <div className="flex items-center gap-2 text-sm">
              {(Date.now() - refreshedAt.getTime()) / 60000 > STALE_THRESHOLD_MINUTES ? (
                <AlertCircle size={16} className="text-yellow-400 shrink-0" />
              ) : (
                <RefreshCw size={16} className="text-gray-400 shrink-0" />
              )}
              <span className="text-gray-300">
                Data as of {refreshedAt.toLocaleString()}
              </span>
            </div>
            {isAdmin && (
              <button
                onClick={handleManualRefresh}
                disabled={refreshing}
                className="flex items-center gap-1 text-xs font-medium text-primary-400 hover:text-primary-300 disabled:opacity-50"
              >
                {refreshing ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <RefreshCw size={14} />
                )}
                Refresh
              </button>
            )}
          </div>
        )}

        {/* ── Date range selector ── */}
        <div className="flex items-center gap-2 mb-4">
          <input
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <span className="text-gray-500">—</span>
          <input
            type="date"
            value={range.to}
            min={range.from}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
          />
        </div>

        {/* ── Summary cards ── */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
            <p className="text-xs text-gray-400 mb-1">Total Spent</p>
            <p className="text-lg font-bold text-white">{totalSpent.toFixed(2)}</p>
          </div>
          <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
            <p className="text-xs text-gray-400 mb-1">Transactions</p>
            <p className="text-lg font-bold text-white">{totalTransactions}</p>
          </div>
        </div>

        {/* ── Asset breakdown ── */}
        {data?.asset_breakdown?.length > 0 && (
          <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 mb-4">
            <h3 className="text-sm font-semibold text-white mb-3">Asset Breakdown</h3>
            <div className="space-y-2">
              {data.asset_breakdown.map((item, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span className="text-gray-300">{item.asset}</span>
                  <span className="text-white font-medium">
                    {parseFloat(item.total || 0).toFixed(2)} ({item.count})
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {noData && (
          <div className="text-center py-12 text-gray-500">
            <FileText size={32} className="mx-auto mb-2 opacity-50" />
            <p className="text-sm">No transaction data in selected range</p>
          </div>
        )}

        {/* ── Export actions ── */}
        <div className="flex gap-3 mt-6">
          <button
            onClick={handleExportCSV}
            disabled={csvLoading || noData}
            className="flex-1 flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-white"
          >
            {csvLoading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            CSV
          </button>
          <button
            onClick={handleExportPDF}
            disabled={pdfLoading || noData}
            className="flex-1 flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-white"
          >
            {pdfLoading ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
            PDF
          </button>
        </div>
      </div>
    </>
  );
}
