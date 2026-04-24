import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Send, Download, ExternalLink, Filter, Search, Flag, X, WifiOff } from 'lucide-react';
import api from '../utils/api';
import { truncateAddress } from '../utils/currency';
import { TransactionCardSkeleton } from '../components/Skeleton';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { setCacheEntry, getCacheEntry } from '../utils/offlineDB';
import { useTranslation } from 'react-i18next';

const STATUS_COLORS = {
  completed: 'text-primary-400 bg-primary-500/10',
  confirming: 'text-blue-400 bg-blue-500/10',
  pending: 'text-yellow-400 bg-yellow-500/10',
  failed: 'text-red-400 bg-red-500/10',
};

const ASSET_OPTIONS = ['XLM', 'USDC', 'NGN', 'GHS', 'KES'];

function buildHistoryParams(pageNum, dateFrom, dateTo, asset) {
  const params = { page: pageNum, limit: 20 };
  if (dateFrom) params.from = dateFrom;
  if (dateTo) params.to = dateTo;
  if (asset) params.asset = asset;
  return params;
}

export default function TransactionHistory() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { isOnline } = useOnlineStatus();
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(null);
  const [fromCache, setFromCache] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [asset, setAsset] = useState('');
  const [reportTx, setReportTx] = useState(null); // tx being reported
  const [reportType, setReportType] = useState('other');
  const [reportDesc, setReportDesc] = useState('');
  const [reportLoading, setReportLoading] = useState(false);

  const fetchInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPage(1);

    // Offline — serve from IndexedDB cache
    if (!navigator.onLine) {
      try {
        const cached = await getCacheEntry('history');
        if (cached?.data) {
          setTransactions(cached.data);
          setFromCache(true);
          setHasMore(false);
        } else {
          setError(t('history.load_error'));
          setTransactions([]);
        }
      } catch {
        setError(t('history.load_error'));
        setTransactions([]);
      } finally {
        setLoading(false);
      }
      return;
    }

    // Online — fetch fresh and persist
    try {
      const params = buildHistoryParams(1, dateFrom, dateTo, asset);
      const r = await api.get('/payments/history', { params });
      const txList = r.data.transactions;
      setTransactions(txList);
      setHasMore(r.data.page < r.data.pages);
      setPage(1);
      setFromCache(false);

      // Only cache the unfiltered first page (no date/asset filters)
      if (!dateFrom && !dateTo && !asset) {
        await setCacheEntry('history', txList);
      }
    } catch {
      // Network failed — try cache
      try {
        const cached = await getCacheEntry('history');
        if (cached?.data) {
          setTransactions(cached.data);
          setFromCache(true);
          setHasMore(false);
        } else {
          setError(t('history.load_error'));
          setTransactions([]);
          setHasMore(false);
        }
      } catch {
        setError(t('history.load_error'));
        setTransactions([]);
        setHasMore(false);
      }
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, asset, t]);

  useEffect(() => {
    fetchInitial();
  }, [fetchInitial]);

  const loadMore = () => {
    const nextPage = page + 1;
    setLoadingMore(true);
    const params = buildHistoryParams(nextPage, dateFrom, dateTo, asset);
    api
      .get('/payments/history', { params })
      .then((r) => {
        setTransactions((prev) => [...prev, ...r.data.transactions]);
        setPage(nextPage);
        setHasMore(nextPage < r.data.pages);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transactions.filter((tx) => {
      if (filter === 'sent' && tx.direction !== 'sent') return false;
      if (filter === 'received' && tx.direction !== 'received') return false;
      if (!q) return true;
      const memo = (tx.memo || '').toLowerCase();
      const sender = (tx.sender_wallet || '').toLowerCase();
      const recipient = (tx.recipient_wallet || '').toLowerCase();
      const amountStr = String(tx.amount ?? '').toLowerCase();
      return (
        memo.includes(q) ||
        sender.includes(q) ||
        recipient.includes(q) ||
        amountStr.includes(q)
      );
    });
  }, [transactions, filter, search]);

  async function handleExportCSV() {
    setExporting(true);
    try {
      const params = {};
      if (dateFrom) params.from = dateFrom;
      if (dateTo) params.to = dateTo;
      if (asset) params.asset = asset;
      if (filter !== 'all') params.direction = filter;
      const res = await api.get('/payments/export', { params, responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'transactions.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* optional route */
    }
    setExporting(false);
  }

  async function handleSubmitReport(e) {
    e.preventDefault();
    setReportLoading(true);
    try {
      await api.post('/support/tickets', {
        transaction_id: reportTx.id,
        type: reportType,
        description: reportDesc,
      });
      setReportTx(null);
      setReportDesc('');
      setReportType('other');
      // toast is imported via react-hot-toast in other pages; use alert as fallback
      alert('Issue reported. Our team will review it shortly.');
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to submit report');
    } finally {
      setReportLoading(false);
    }
  }

  const filters = [
    { key: 'all', label: t('history.filter_all') },
    { key: 'sent', label: t('history.filter_sent') },
    { key: 'received', label: t('history.filter_received') },
  ];

  return (
    <div className="px-4 py-6 max-w-lg mx-auto">
      <button
        onClick={() => navigate(-1)}
        className="text-gray-400 hover:text-white mb-6 flex items-center gap-1"
      >
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-white">
          {t('history.title')}
          {fromCache && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-gray-400 bg-gray-800 rounded-full px-2 py-0.5 align-middle">
              <WifiOff size={10} aria-hidden="true" />
              Cached
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExportCSV}
            disabled={exporting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700 text-sm font-medium transition-colors disabled:opacity-50"
          >
            <Download size={14} />
            {exporting ? '...' : t('history.export_csv')}
          </button>
          <Filter size={18} className="text-gray-400" />
        </div>
      </div>

      <div className="space-y-3 mb-4">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('history.search_placeholder')}
            className="w-full bg-gray-900 border border-gray-700 rounded-xl pl-9 pr-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-primary-500"
            aria-label={t('history.search_placeholder')}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="tx-date-from" className="text-xs text-gray-500 block mb-1">
              {t('history.date_from')}
            </label>
            <input
              id="tx-date-from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-primary-500"
            />
          </div>
          <div>
            <label htmlFor="tx-date-to" className="text-xs text-gray-500 block mb-1">
              {t('history.date_to')}
            </label>
            <input
              id="tx-date-to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-primary-500"
            />
          </div>
        </div>
        <div>
          <label htmlFor="tx-asset" className="text-xs text-gray-500 block mb-1">
            {t('history.asset_label')}
          </label>
          <select
            id="tx-asset"
            value={asset}
            onChange={(e) => setAsset(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-primary-500"
          >
            <option value="">{t('history.asset_all')}</option>
            {ASSET_OPTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex gap-2 mb-6 flex-wrap">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium capitalize transition-colors ${
              filter === f.key
                ? 'bg-primary-500 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-white'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading transactions">
          {Array.from({ length: 6 }).map((_, i) => <TransactionCardSkeleton key={i} />)}
        </div>
      ) : error ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-red-400 mb-3">{error}</p>
          <button
            type="button"
            onClick={() => fetchInitial()}
            className="px-4 py-2 bg-primary-500 text-white rounded-lg text-sm hover:bg-primary-600 transition-colors"
          >
            Try again
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-4xl mb-3">📭</p>
          <p>{t('common.no_transactions')}</p>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {filtered.map((tx) => (
              <div key={tx.id} className="bg-gray-900 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                      tx.direction === 'sent'
                        ? 'bg-red-500/10 text-red-400'
                        : 'bg-primary-500/10 text-primary-400'
                    }`}
                  >
                    {tx.direction === 'sent' ? <Send size={16} /> : <Download size={16} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-white capitalize">{tx.direction}</p>
                      <span
                        className={`text-sm font-bold ${
                          tx.direction === 'sent' ? 'text-red-400' : 'text-primary-400'
                        }`}
                      >
                        {tx.direction === 'sent' ? '-' : '+'}
                        {tx.amount} {tx.asset}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {tx.direction === 'sent'
                        ? `${t('history.to')} ${truncateAddress(tx.recipient_wallet)}`
                        : `${t('history.from')} ${truncateAddress(tx.sender_wallet)}`}
                    </p>
                    {tx.memo && <p className="text-xs text-gray-600 mt-0.5">&quot;{tx.memo}&quot;</p>}
                    <div className="flex items-center justify-between mt-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          STATUS_COLORS[tx.status] || STATUS_COLORS.pending
                        }`}
                      >
                        {tx.status === 'confirming' ? (
                          <span className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse inline-block" />
                            Confirming...
                          </span>
                        ) : tx.status}
                      </span>
                      <div className="flex items-center gap-2">
                        <div className="text-right">
                          <span className="text-xs text-gray-500 block">
                            {new Date(tx.ledger_close_time || tx.created_at).toLocaleDateString('en-GB', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })}
                          </span>
                          {tx.ledger_close_time && tx.created_at && (
                            <span className="text-xs text-gray-700 block" title={`Submitted: ${new Date(tx.created_at).toLocaleString()}`}>
                              Ledger: {new Date(tx.ledger_close_time).toLocaleTimeString()}
                            </span>
                          )}
                        </div>
                        {tx.tx_hash && (
                          <a
                            href={`https://stellar.expert/explorer/testnet/tx/${tx.tx_hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-gray-500 hover:text-primary-400 transition-colors"
                          >
                            <ExternalLink size={12} aria-label="View transaction on Stellar Explorer" />
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => setReportTx(tx)}
                          className="text-gray-500 hover:text-yellow-400 transition-colors"
                          aria-label="Report issue with this transaction"
                          title="Report Issue"
                        >
                          <Flag size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {hasMore && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full mt-4 py-2.5 rounded-xl bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700 text-sm font-medium transition-colors disabled:opacity-50"
            >
              {loadingMore ? t('history.loading_more') : t('history.load_more')}
            </button>
          )}
        </>
      )}
      {/* Report Issue Modal */}
      {reportTx && (
        <div className="fixed inset-0 bg-black/70 flex items-end justify-center z-50 p-4">
          <div className="bg-gray-900 rounded-2xl w-full max-w-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-white">Report Issue</h3>
              <button onClick={() => setReportTx(null)} className="text-gray-400 hover:text-white">
                <X size={18} />
              </button>
            </div>
            <p className="text-xs text-gray-500">
              Transaction: {truncateAddress(reportTx.tx_hash || String(reportTx.id))} &mdash; {reportTx.amount} {reportTx.asset}
            </p>
            <form onSubmit={handleSubmitReport} className="space-y-3">
              <div>
                <label className="text-xs text-gray-400 block mb-1">Issue type</label>
                <select
                  value={reportType}
                  onChange={e => setReportType(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-primary-500"
                >
                  <option value="wrong_address">Wrong address</option>
                  <option value="wrong_amount">Wrong amount</option>
                  <option value="failed_deducted">Failed but funds deducted</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Description</label>
                <textarea
                  required
                  rows={3}
                  maxLength={2000}
                  value={reportDesc}
                  onChange={e => setReportDesc(e.target.value)}
                  placeholder="Describe the issue..."
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 resize-none"
                />
              </div>
              <button
                type="submit"
                disabled={reportLoading}
                className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
              >
                {reportLoading ? 'Submitting…' : 'Submit Report'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
