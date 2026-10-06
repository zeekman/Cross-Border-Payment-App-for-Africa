import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronDown, Send, Download, ExternalLink, Filter, Search, Flag, X, WifiOff, Loader2, Copy, CheckCheck } from 'lucide-react';
import { FixedSizeList } from 'react-window';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import api from '../utils/api';
import { truncateAddress } from '../utils/currency';
import { TransactionCardSkeleton } from '../components/Skeleton';
import ConfirmModal from '../components/ConfirmModal';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { setCacheEntry, getCacheEntry } from '../utils/offlineDB';

const STATUS_COLORS = {
  completed: 'text-primary-400 bg-primary-500/10',
  confirming: 'text-blue-400 bg-blue-500/10',
  pending: 'text-yellow-400 bg-yellow-500/10',
  failed: 'text-red-400 bg-red-500/10',
};

// Calculate days until expiry for claimable balances
function getDaysUntilExpiry(createdAt) {
  const created = new Date(createdAt).getTime();
  const expiresAt = created + (30 * 24 * 60 * 60 * 1000); // 30 days
  const now = Date.now();
  const daysLeft = Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000));
  return daysLeft;
}

const ASSET_OPTIONS = ['XLM', 'USDC', 'NGN', 'GHS', 'KES'];
const STATUS_OPTIONS = ['completed', 'pending', 'failed', 'cancelled'];

function getDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

const DATE_PRESETS = [
  { label: 'Today', getFrom: () => new Date().toISOString().split('T')[0], getTo: () => new Date().toISOString().split('T')[0] },
  { label: 'Last 7 days', getFrom: () => getDateDaysAgo(7), getTo: () => new Date().toISOString().split('T')[0] },
  { label: 'Last 30 days', getFrom: () => getDateDaysAgo(30), getTo: () => new Date().toISOString().split('T')[0] },
];

function buildHistoryParams(cursor, dateFrom, dateTo, asset, statuses) {
  const params = { limit: 20 };
  if (cursor) params.cursor = cursor;
  if (dateFrom) params.from = dateFrom;
  if (dateTo) params.to = dateTo;
  if (asset) params.asset = asset;
  if (statuses && statuses.length > 0) params.status = statuses.join(',');
  return params;
}

export default function TransactionHistory() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation();
  const { isOnline } = useOnlineStatus();
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(null);
  const [fromCache, setFromCache] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState('');

  // Filter state derived from URL params
  const filter = searchParams.get('direction') || 'all';
  const dateFrom = searchParams.get('from') || '';
  const dateTo = searchParams.get('to') || '';
  const asset = searchParams.get('asset') || '';
  const statusParam = searchParams.get('status') || '';
  const selectedStatuses = useMemo(
    () => (statusParam ? statusParam.split(',').filter(Boolean) : []),
    [statusParam]
  );
  const [showFilters, setShowFilters] = useState(false);

  function setFilter(value) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === 'all') next.delete('direction'); else next.set('direction', value);
      return next;
    }, { replace: true });
  }
  function setDateFrom(value) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set('from', value); else next.delete('from');
      return next;
    }, { replace: true });
  }
  function setDateTo(value) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set('to', value); else next.delete('to');
      return next;
    }, { replace: true });
  }
  function setAsset(value) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set('asset', value); else next.delete('asset');
      return next;
    }, { replace: true });
  }
  function toggleStatus(s) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const current = (prev.get('status') || '').split(',').filter(Boolean);
      const updated = current.includes(s) ? current.filter((x) => x !== s) : [...current, s];
      if (updated.length) next.set('status', updated.join(','));
      else next.delete('status');
      return next;
    }, { replace: true });
  }
  function clearAllFilters() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('direction');
      next.delete('from');
      next.delete('to');
      next.delete('asset');
      next.delete('status');
      return next;
    }, { replace: true });
  }

  const activeFilterCount = [
    filter !== 'all',
    !!dateFrom,
    !!dateTo,
    !!asset,
    selectedStatuses.length > 0,
  ].filter(Boolean).length;

  const [reportTx, setReportTx] = useState(null); // tx being reported
  const [reportType, setReportType] = useState('other');
  const [reportDesc, setReportDesc] = useState('');
  const [reportLoading, setReportLoading] = useState(false);
  const [confirmReport, setConfirmReport] = useState(false); // ConfirmModal open state for report submission
  const [selectedTx, setSelectedTx] = useState(null); // tx detail modal
  const [copiedHash, setCopiedHash] = useState(false);
  const sentinelRef = useRef(null);
  const SCROLL_KEY = 'txhistory_scroll';

  const fetchInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNextCursor(null);

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
      const params = buildHistoryParams(null, dateFrom, dateTo, asset, selectedStatuses);
      const r = await api.get('/payments/history', { params });
      const txList = r.data.transactions;
      setTransactions(txList);
      setHasMore(r.data.has_more);
      setNextCursor(r.data.next_cursor || null);
      setFromCache(false);

      // Only cache the unfiltered first page
      if (!dateFrom && !dateTo && !asset && selectedStatuses.length === 0) {
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
  }, [dateFrom, dateTo, asset, selectedStatuses, t]);

  useEffect(() => {
    fetchInitial();
  }, [fetchInitial]);

  // Restore scroll position when returning to this page
  useEffect(() => {
    const saved = sessionStorage.getItem(SCROLL_KEY);
    if (saved) window.scrollTo(0, parseInt(saved, 10));
    return () => {
      sessionStorage.setItem(SCROLL_KEY, String(Math.round(window.scrollY)));
    };
  }, []);

  const loadMore = useCallback(() => {
    if (nextCursor && !loadingMore) {
      setLoadingMore(true);
      const params = buildHistoryParams(nextCursor, dateFrom, dateTo, asset);
      api
        .get('/payments/history', { params })
        .then((r) => {
          setTransactions((prev) => [...prev, ...r.data.transactions]);
          setHasMore(r.data.has_more);
          setNextCursor(r.data.next_cursor || null);
        })
        .catch(() => {})
        .finally(() => setLoadingMore(false));
    }
  }, [nextCursor, loadingMore, dateFrom, dateTo, asset]);

  // IntersectionObserver: load next page when sentinel scrolls into view
  useEffect(() => {
    if (!sentinelRef.current) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasMore && !loadingMore) {
          loadMore();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, loadMore]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transactions.filter((tx) => {
      if (filter === 'sent' && tx.direction !== 'sent') return false;
      if (filter === 'received' && tx.direction !== 'received') return false;
      if (selectedStatuses.length > 0 && !selectedStatuses.includes(tx.status)) return false;
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
  }, [transactions, filter, search, selectedStatuses]);

  async function handleExportCSV() {
    if (exporting) return;
    setExporting(true);
    try {
      const params = { format: 'csv' };
      if (dateFrom) params.from = dateFrom;
      if (dateTo) params.to = dateTo;
      if (asset) params.asset = asset;
      if (filter !== 'all') params.direction = filter;
      const res = await api.get('/payments/history', { params, responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `transactions_${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  }

  async function handleSubmitReport(e) {
    e.preventDefault();
    setConfirmReport(true);
  }

  async function doSubmitReport() {
    setReportLoading(true);
    try {
      await api.post('/support/tickets', {
        transaction_id: reportTx.id,
        type: reportType,
        description: reportDesc,
      });
      setConfirmReport(false);
      setReportTx(null);
      setReportDesc('');
      setReportType('other');
      toast.success('Issue reported. Our team will review it shortly.');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to submit report');
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
        <button
          type="button"
          onClick={handleExportCSV}
          disabled={exporting}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700 text-sm font-medium transition-colors disabled:opacity-50"
        >
          <Download size={14} />
          {exporting ? <Loader2 size={14} className="animate-spin" /> : t('history.export_csv')}
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-3">
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

      {/* Filters toggle */}
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={() => setShowFilters((v) => !v)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700 text-sm font-medium transition-colors"
        >
          <Filter size={14} />
          Filters
          {activeFilterCount > 0 && (
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-primary-500 text-white text-xs font-bold">
              {activeFilterCount}
            </span>
          )}
          <ChevronDown size={14} className={`transition-transform ${showFilters ? 'rotate-180' : ''}`} />
        </button>
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={clearAllFilters}
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Collapsible filter panel */}
      {showFilters && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-3 space-y-4">
          {/* Status */}
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Status</p>
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map((s) => (
                <label key={s} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedStatuses.includes(s)}
                    onChange={() => toggleStatus(s)}
                    className="accent-primary-500"
                  />
                  <span className="text-sm text-gray-300 capitalize">{s}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Date range */}
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Date Range</p>
            <div className="flex flex-wrap gap-2 mb-2">
              {DATE_PRESETS.map((p) => {
                const isActive = dateFrom === p.getFrom() && dateTo === p.getTo();
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => { setDateFrom(p.getFrom()); setDateTo(p.getTo()); }}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                      isActive ? 'bg-primary-500 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
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
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-primary-500"
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
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-primary-500"
                />
              </div>
            </div>
          </div>

          {/* Currency */}
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">{t('history.asset_label')}</p>
            <div className="flex flex-wrap gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="tx-asset"
                  checked={!asset}
                  onChange={() => setAsset('')}
                  className="accent-primary-500"
                />
                <span className="text-sm text-gray-300">{t('history.asset_all')}</span>
              </label>
              {ASSET_OPTIONS.map((a) => (
                <label key={a} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="tx-asset"
                    checked={asset === a}
                    onChange={() => setAsset(a)}
                    className="accent-primary-500"
                  />
                  <span className="text-sm text-gray-300">{a}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Direction */}
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Direction</p>
            <div className="flex gap-4">
              {filters.map((f) => (
                <label key={f.key} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="tx-direction"
                    checked={filter === f.key}
                    onChange={() => setFilter(f.key)}
                    className="accent-primary-500"
                  />
                  <span className="text-sm text-gray-300">{f.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Active filter chips */}
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {filter !== 'all' && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary-500/15 text-primary-400 text-xs font-medium">
              {filter}
              <button type="button" onClick={() => setFilter('all')} aria-label="Remove direction filter"><X size={11} /></button>
            </span>
          )}
          {dateFrom && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary-500/15 text-primary-400 text-xs font-medium">
              From {dateFrom}
              <button type="button" onClick={() => setDateFrom('')} aria-label="Remove from date"><X size={11} /></button>
            </span>
          )}
          {dateTo && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary-500/15 text-primary-400 text-xs font-medium">
              To {dateTo}
              <button type="button" onClick={() => setDateTo('')} aria-label="Remove to date"><X size={11} /></button>
            </span>
          )}
          {asset && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary-500/15 text-primary-400 text-xs font-medium">
              {asset}
              <button type="button" onClick={() => setAsset('')} aria-label="Remove asset filter"><X size={11} /></button>
            </span>
          )}
          {selectedStatuses.map((s) => (
            <span key={s} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary-500/15 text-primary-400 text-xs font-medium capitalize">
              {s}
              <button type="button" onClick={() => toggleStatus(s)} aria-label={`Remove ${s} filter`}><X size={11} /></button>
            </span>
          ))}
        </div>
      )}

      {/* Pagination info bar: page number and record count */}
      {!loading && !error && transactions.length > 0 && (
        <div
          aria-live="polite"
          className="flex items-center justify-between text-xs text-gray-500 mb-3 px-1"
        >
          <span>{transactions.length} loaded</span>
          <span>
            {activeFilterCount > 0
              ? `Showing ${filtered.length} transaction${filtered.length !== 1 ? 's' : ''}`
              : `${filtered.length} transaction${filtered.length !== 1 ? 's' : ''}`}
            {hasMore && (
              <span className="ml-1 text-gray-600">&middot; more available</span>
            )}
          </span>
        </div>
      )}

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
          <FixedSizeList
            height={Math.min(filtered.length * 100, 600)}
            itemCount={filtered.length}
            itemSize={100}
            width="100%"
            overscanCount={5}
          >
            {({ index, style }) => {
              const tx = filtered[index];
              return (
                <div style={style} key={tx.id} className="pb-3">
                  <button
                    onClick={() => setSelectedTx(tx)}
                    className="w-full bg-gray-900 rounded-xl p-4 hover:bg-gray-800 transition-colors text-left"
                  >
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
                          <div className="flex items-center gap-2">
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
                            {tx.type === 'claimable_balance' && tx.status === 'pending' && (() => {
                              const daysLeft = getDaysUntilExpiry(tx.created_at);
                              if (daysLeft > 0 && daysLeft <= 7) {
                                return (
                                  <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400">
                                    ⏰ Expires in {daysLeft}d
                                  </span>
                                );
                              }
                              return null;
                            })()}
                          </div>
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
                                href={`https://stellar.expert/explorer/${process.env.REACT_APP_STELLAR_NETWORK || 'testnet'}/tx/${tx.tx_hash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-gray-500 hover:text-primary-400 transition-colors"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <ExternalLink size={12} aria-hidden="true" />
                              </a>
                            )}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setReportTx(tx);
                              }}
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
                  </button>
                </div>
              );
            }}
          </FixedSizeList>
          {hasMore && (
            <div ref={sentinelRef} className="flex justify-center py-4" aria-live="polite" aria-label="Loading more transactions">
              {loadingMore && <Loader2 size={20} className="animate-spin text-primary-400" />}
            </div>
          )}
          {!hasMore && transactions.length > 0 && (
            <p className="text-center text-xs text-gray-500 py-4">All transactions loaded</p>
          )}
        </>
      )}
      {/* Transaction Detail Modal */}
      {selectedTx && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 rounded-2xl w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between p-5 border-b border-gray-800">
              <h3 className="font-semibold text-white">Transaction Details</h3>
              <button onClick={() => setSelectedTx(null)} className="text-gray-400 hover:text-white">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {/* Amount */}
              <div>
                <p className="text-xs text-gray-500 mb-1">Amount</p>
                <p className={`text-lg font-bold ${selectedTx.direction === 'sent' ? 'text-red-400' : 'text-primary-400'}`}>
                  {selectedTx.direction === 'sent' ? '-' : '+'}
                  {selectedTx.amount} {selectedTx.asset}
                </p>
              </div>

              {/* Status */}
              <div>
                <p className="text-xs text-gray-500 mb-1">Status</p>
                <span className={`text-sm px-2 py-1 rounded-full inline-block ${STATUS_COLORS[selectedTx.status] || STATUS_COLORS.pending}`}>
                  {selectedTx.status}
                </span>
              </div>

              {/* Memo */}
              {selectedTx.memo && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Memo</p>
                  <p className="text-sm text-white font-mono break-all">{selectedTx.memo}</p>
                </div>
              )}

              {/* Fee */}
              {selectedTx.fee && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Fee</p>
                  <p className="text-sm text-white">{selectedTx.fee} XLM</p>
                </div>
              )}

              {/* From/To */}
              <div>
                <p className="text-xs text-gray-500 mb-1">
                  {selectedTx.direction === 'sent' ? 'To' : 'From'}
                </p>
                <p className="text-sm text-white font-mono break-all">
                  {selectedTx.direction === 'sent' ? selectedTx.recipient_wallet : selectedTx.sender_wallet}
                </p>
              </div>

              {/* Date */}
              <div>
                <p className="text-xs text-gray-500 mb-1">Date</p>
                <p className="text-sm text-white">
                  {new Date(selectedTx.ledger_close_time || selectedTx.created_at).toLocaleString()}
                </p>
              </div>

              {/* Transaction Hash */}
              {selectedTx.tx_hash && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Transaction Hash</p>
                  <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
                    <span className="text-xs text-gray-300 font-mono flex-1 truncate">{truncateAddress(selectedTx.tx_hash, 12)}</span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(selectedTx.tx_hash);
                        setCopiedHash(true);
                        setTimeout(() => setCopiedHash(false), 2000);
                        toast.success('Hash copied');
                      }}
                      className="text-gray-400 hover:text-white transition-colors shrink-0"
                      title="Copy hash"
                    >
                      {copiedHash ? <CheckCheck size={14} className="text-green-400" /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
              )}

              {/* Stellar Explorer Link */}
              {selectedTx.tx_hash && (
                <a
                  href={`https://stellar.expert/explorer/testnet/tx/${selectedTx.tx_hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-2 bg-primary-500 hover:bg-primary-600 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
                >
                  <ExternalLink size={14} />
                  View on Stellar Explorer
                </a>
              )}
            </div>
          </div>
        </div>
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

      {/* Confirm Report Submission Modal */}
      <ConfirmModal
        isOpen={confirmReport}
        onClose={() => setConfirmReport(false)}
        onConfirm={doSubmitReport}
        title="Submit Report"
        message={`Submit a report for this transaction? Our team will review the issue and follow up with you.`}
        confirmLabel="Submit Report"
        confirmVariant="primary"
        loading={reportLoading}
      />
    </div>
  );
}
