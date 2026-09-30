import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Send,
  Download,
  RefreshCw,
  Copy,
  CheckCheck,
  FlaskConical,
  Plus,
  Minus,
  WifiOff,
  Wallet,
  ChevronDown,
  PiggyBank,
  Eye,
  EyeOff,
  Clock,
  Mail,
  Bell,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { BalanceCardSkeleton, TransactionRowSkeleton } from '../components/Skeleton';
import api from '../utils/api';
import { truncateAddress } from '../utils/currency';
import { useExchangeRates } from '../hooks/useExchangeRates';
import { useCountUp } from '../hooks/useCountUp';
import { usePaymentStream } from '../hooks/usePaymentStream';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { setCacheEntry, getCacheEntry } from '../utils/offlineDB';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import PINSetupModal from '../components/PINSetupModal';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { getQueueCountForUser } from '../utils/offlineDB';

// FE-129: IS_TESTNET is now sourced from the shared network config module so
// that Dashboard and every other Stellar-aware file agree on the same value.
import { IS_TESTNET } from '../config/network';
const MAX_WALLETS = 5;

function BalanceDisplay({ balance }) {
  const numericBalance = Number.isFinite(balance) ? balance : 0;
  const animated = useCountUp(numericBalance);

  return (
    <span className="text-4xl font-bold text-white">
      {animated.toLocaleString()}
    </span>
  );
}

function normalizeWalletsResponse(data) {
  if (Array.isArray(data?.wallets)) return data.wallets;
  if (data?.public_key) return [data];
  return [];
}

export default function Dashboard() {
  const { user, updateUser } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  // Issue #454: PIN setup prompt on first login
  const [showPINSetup, setShowPINSetup] = useState(false);
  useEffect(() => {
    if (user && user.pin_setup_completed === false) {
      setShowPINSetup(true);
    }
  }, [user]);

  // Issue #996: guard against setState after unmount from timers/promises
  // started in event handlers (not owned by a useEffect cleanup).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Issue #455: Push notification opt-in banner
  const { supported: pushSupported, subscribed: pushSubscribed, loading: pushLoading, subscribe: pushSubscribe } = usePushNotifications();
  const [pushDismissed, setPushDismissed] = useState(
    () => localStorage.getItem('afripay_push_dismissed') === 'true'
  );
  const showPushBanner = pushSupported && !pushSubscribed && !pushDismissed;
  const dismissPushBanner = () => {
    localStorage.setItem('afripay_push_dismissed', 'true');
    setPushDismissed(true);
  };

  // Admin Contract State Viewer
  const [adminContractId, setAdminContractId] = useState('');
  const [adminKeyPrefix, setAdminKeyPrefix] = useState('');
  const [adminContractState, setAdminContractState] = useState(null);
  const [adminStateLoading, setAdminStateLoading] = useState(false);

  const fetchContractState = async () => {
    if (!adminContractId) return;
    setAdminStateLoading(true);
    try {
      const res = await api.get(`/contracts/${adminContractId}/state`, {
        params: { prefix: adminKeyPrefix },
      });
      setAdminContractState(res.data.data || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to fetch contract state');
    } finally {
      setAdminStateLoading(false);
    }
  };

  // Multi-wallet state
  const [wallets, setWallets] = useState([]);
  const [activeWalletId, setActiveWalletId] = useState(null);
  const [showWalletDropdown, setShowWalletDropdown] = useState(false);
  const [creatingWallet, setCreatingWallet] = useState(false);
  const [newWalletLabel, setNewWalletLabel] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Derived active wallet object
  const wallet = wallets.find((w) => w.id === activeWalletId) || wallets[0] || null;

  const [transactions, setTransactions] = useState([]);
  const [txError, setTxError] = useState(false);
  const [scheduledPayments, setScheduledPayments] = useState([]);
  const [scheduledLoading, setScheduledLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const { displayCurrency: selectedCurrency, setDisplayCurrency: setSelectedCurrency } = useCurrency();
  const [funding, setFunding] = useState(false);
  const [anchorLoading, setAnchorLoading] = useState(false);
  const [anchorAction, setAnchorAction] = useState(null);
  const [balanceIncreased, setBalanceIncreased] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [showZeroBalances, setShowZeroBalances] = useState(false);
  const [walletError, setWalletError] = useState(false);
  const [transactionsError, setTransactionsError] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const { currencies, convertFromXLM, usingApproximateRates } = useExchangeRates();
  const { isOnline } = useOnlineStatus();

  // Email verification banner state (issue #479)
  const [showEmailBanner, setShowEmailBanner] = useState(true);

  // Handle incoming payment from stream
  const handlePayment = useCallback(
    (payment) => {
      if (payment.to === wallet?.public_key) {
        toast.success(`Received ${payment.amount} ${payment.asset}`);
        setBalanceIncreased(true);
        setTimeout(() => {
          if (mountedRef.current) setBalanceIncreased(false);
        }, 2000);
        Promise.all([
          api.get('/wallet/list'),
          api.get('/payments/history'),
          api.get('/scheduled-payments').catch(() => ({ data: { payments: [] } })),
        ])
          .then(([walletsRes, txRes, scheduledRes]) => {
            if (!mountedRef.current) return;
            setWallets(walletsRes.data.wallets);
            setTransactions(txRes.data.transactions.slice(0, 5));
            setScheduledPayments(
              (scheduledRes.data.payments || []).filter((p) => p.active).slice(0, 3)
            );
          })
          .catch(() => {});
      }
    },
    [wallet?.public_key]
  );

  const {
    isConnected,
    isReconnecting,
    error: streamError,
  } = usePaymentStream(wallet?.public_key, handlePayment);

  const loadDashboard = useCallback(async (isRefresh = false) => {
    // Initial load shows full skeleton; manual refresh shows spinner on button only
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    if (!navigator.onLine) {
      try {
        const [cachedWallets, cachedHistory] = await Promise.all([
          getCacheEntry('wallets'),
          getCacheEntry('history'),
        ]);
        if (cachedWallets?.data) {
          setWallets(cachedWallets.data);
          setActiveWalletId((id) => id || cachedWallets.data[0]?.id || null);
          setFromCache(true);
          setWalletError(false);
        }
        if (cachedHistory?.data) {
          setTransactions(cachedHistory.data.slice(0, 5));
        }
      } catch {
        // IndexedDB unavailable
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
      return;
    }

    try {
      const [walletsRes, txRes, scheduledRes] = await Promise.all([
        api.get('/wallet/list'),
        api.get('/payments/history'),
        api.get('/scheduled-payments').catch(() => ({ data: { payments: [] } })),
      ]);
      const walletsData = normalizeWalletsResponse(walletsRes.data);
      const txData = txRes.data.transactions;

      setWallets(walletsData);
      setActiveWalletId((id) => id || walletsData[0]?.id || null);
      setTransactions(txData.slice(0, 5));
      setTxError(false);
      setScheduledPayments((scheduledRes.data.payments || []).filter((p) => p.active).slice(0, 3));
      setScheduledLoading(false);
      setFromCache(false);
      setWalletError(walletsData.length === 0);
      setTransactionsError(false);

      await Promise.all([setCacheEntry('wallets', walletsData), setCacheEntry('history', txData)]).catch(
        () => {}
      );
    } catch {
      try {
        const [cachedWallets, cachedHistory] = await Promise.all([
          getCacheEntry('wallets'),
          getCacheEntry('history'),
        ]);
        if (cachedWallets?.data) {
          setWallets(cachedWallets.data);
          setActiveWalletId((id) => id || cachedWallets.data[0]?.id || null);
          setFromCache(true);
          setWalletError(false);
        }
        if (cachedHistory?.data) {
          setTransactions(cachedHistory.data.slice(0, 5));
          setTxError(false);
        } else {
          setTxError(true);
          setTransactionsError(true);
        }
        if (!cachedWallets?.data) {
          setWallets([]);
          setActiveWalletId(null);
          setWalletError(true);
          toast.error('Failed to load wallet data');
        }
      } catch {
        setWallets([]);
        setActiveWalletId(null);
        setWalletError(true);
        setTransactionsError(true);
        toast.error('Failed to load wallet data');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
      setScheduledLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
    if (!isOnline) {
      getQueueCountForUser(user?.id)
        .then(setQueueCount)
        .catch(() => {});
    }
  }, [loadDashboard, isOnline, user?.id]);

  const copyAddress = async () => {
    if (!wallet?.public_key) return;
    try {
      await navigator.clipboard.writeText(wallet.public_key);
      setCopied(true);
      setTimeout(() => {
        if (mountedRef.current) setCopied(false);
      }, 2000);
    } catch {
      toast.error('Failed to copy address');
    }
  };

  const fundWallet = async () => {
    setFunding(true);
    try {
      const res = await api.post('/dev/fund-wallet');
      toast.success(res.data.message);
      const walletsRes = await api.get('/wallet/list');
      const walletsData = normalizeWalletsResponse(walletsRes.data);
      setWallets(walletsData);
      setWalletError(walletsData.length === 0);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Funding failed');
    } finally {
      setFunding(false);
    }
  };

  const handleAnchorAction = async (action) => {
    setAnchorLoading(true);
    setAnchorAction(action);
    const win = window.open('', 'anchor', 'width=500,height=600');
    try {
      const asset = 'USDC';
      const endpoint = action === 'deposit' ? '/anchor/deposit' : '/anchor/withdraw';
      const res = await api.post(endpoint, { asset });
      win.location.href = res.data.url;
    } catch (err) {
      win.close();
      toast.error(err.response?.data?.error || `Failed to ${action}`);
    } finally {
      setAnchorLoading(false);
      setAnchorAction(null);
    }
  };

  const handleCreateWallet = async (e) => {
    e.preventDefault();
    setCreatingWallet(true);
    try {
      const res = await api.post('/wallet/create', { label: newWalletLabel.trim() || 'Wallet' });
      toast.success(`Wallet "${res.data.wallet.label}" created`);
      setNewWalletLabel('');
      setShowCreateForm(false);
      // Reload wallets and switch to the new one
      const walletsRes = await api.get('/wallet/list');
      setWallets(walletsRes.data.wallets);
      setActiveWalletId(res.data.wallet.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create wallet');
    } finally {
      setCreatingWallet(false);
    }
  };

  const xlmBalance = wallet?.balances?.find((b) => b.asset === 'XLM')?.balance ?? '0';
  const xlmAvailable = wallet?.balances?.find((b) => b.asset === 'XLM')?.available_balance ?? null;
  const accountExists = wallet?.account_exists !== false; // treat undefined (cached) as true
  const showFundWalletButton =
    IS_TESTNET && !!wallet && (xlmBalance === '0' || wallet.account_exists === false);

  // All non-zero balances for the active wallet
  const allBalances = wallet?.balances || [];
  const visibleBalances = showZeroBalances
    ? allBalances
    : allBalances.filter((b) => parseFloat(b.balance) > 0);

  // The selected asset's balance (for currency conversion display)
  const selectedAssetBalance =
    allBalances.find((b) => b.asset === selectedCurrency)?.balance || '0';
  const displayBalance =
    selectedCurrency === 'XLM'
      ? selectedAssetBalance
      : convertFromXLM(xlmBalance, selectedCurrency);
  const walletUnavailable = !loading && walletError && !wallet;

  const {
    pullDistance,
    refreshing: pullRefreshing,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
  } = usePullToRefresh(loadDashboard);

  // Removed global loading block to allow granular skeleton loading

  return (
    <div
      className="px-4 py-6 max-w-lg mx-auto space-y-6"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* Pull-to-refresh indicator */}
      {(pullDistance > 0 || pullRefreshing) && (
        <div
          className="flex justify-center items-center transition-all duration-150"
          style={{ height: pullRefreshing ? 40 : pullDistance, overflow: 'hidden' }}
        >
          <RefreshCw
            size={20}
            className={`text-primary-400 transition-transform ${pullRefreshing ? 'animate-spin' : ''}`}
            style={{
              transform: pullRefreshing ? undefined : `rotate(${(pullDistance / 80) * 360}deg)`,
            }}
          />
        </div>
      )}
      {/* Testnet banner */}
      {IS_TESTNET && (
        <div className="flex items-center justify-between bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2 text-yellow-400 text-sm">
            <FlaskConical size={15} />
            <span>Testnet mode — funds have no real value</span>
          </div>
          {showFundWalletButton && (
            <button
              onClick={fundWallet}
              disabled={funding}
              className="text-xs bg-yellow-500 hover:bg-yellow-600 disabled:opacity-50 text-black font-semibold px-3 py-1.5 rounded-lg transition-colors"
            >
              {funding ? 'Funding…' : 'Fund wallet'}
            </button>
          )}
        </div>
      )}

      {/* Email verification banner (issue #479) */}
      {showEmailBanner && user?.email_verified === false && (
        <div className="flex items-center justify-between bg-blue-500/10 border border-blue-500/30 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2 text-blue-400 text-sm">
            <Mail size={15} />
            <span>Please verify your email address to unlock full account features</span>
          </div>
          <button
            onClick={() => setShowEmailBanner(false)}
            className="text-blue-400 hover:text-blue-300 text-xs font-semibold px-2 py-1 rounded-lg transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Unfunded account prompt */}
      {!accountExists && (
        <div className="flex items-center gap-3 bg-blue-500/10 border border-blue-500/30 rounded-xl px-4 py-3">
          <Download size={18} className="text-blue-400 shrink-0" />
          <div className="flex-1">
            <p className="text-blue-300 text-sm font-medium">Fund your wallet to get started</p>
            <p className="text-blue-400/70 text-xs mt-0.5">
              This account doesn't exist on-chain yet. Send XLM to activate it.
            </p>
          </div>
        </div>
      )}

      {/* Stream reconnecting indicator */}
      {isReconnecting && (
        <div className="flex items-center gap-2 bg-orange-500/10 border border-orange-500/30 rounded-xl px-4 py-2 text-orange-400 text-sm">
          <div className="w-3 h-3 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
          <span>Reconnecting to live updates…</span>
        </div>
      )}

      {/* Stream disconnected banner — shows when not connected and not actively reconnecting */}
      {!isConnected && !isReconnecting && streamError && (
        <div
          role="alert"
          aria-live="polite"
          className="flex items-center justify-between bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-400 text-sm"
        >
          <span>Live updates paused — pull to refresh</span>
          <button
            onClick={() => loadDashboard()}
            className="text-xs bg-red-500/20 hover:bg-red-500/30 px-3 py-1 rounded-lg transition-colors"
          >
            Refresh
          </button>
        </div>
      )}

      {/* Issue #455: Push notification opt-in banner */}
      {showPushBanner && (
        <div className="flex items-center gap-3 bg-primary-500/10 border border-primary-500/30 rounded-xl px-4 py-3">
          <Bell size={18} className="text-primary-400 shrink-0" />
          <div className="flex-1">
            <p className="text-primary-300 text-sm font-medium">Enable push notifications</p>
            <p className="text-primary-400/70 text-xs mt-0.5">
              Get alerted instantly when you receive a payment.
            </p>
          </div>
          <button
            onClick={pushSubscribe}
            disabled={pushLoading}
            className="text-xs bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors shrink-0"
          >
            {pushLoading ? 'Enabling…' : 'Enable'}
          </button>
          <button
            onClick={dismissPushBanner}
            className="text-gray-500 hover:text-white shrink-0"
            aria-label="Dismiss notification prompt"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Offline Queue Indicator */}
      {!isOnline && queueCount > 0 && (
        <div className="flex items-center justify-between bg-primary-500/10 border border-primary-500/30 rounded-xl px-4 py-3">
          <div className="flex items-center gap-3 text-primary-400 text-sm">
            <Clock size={16} />
            <span>
              {queueCount} payment{queueCount !== 1 ? 's' : ''} queued offline
            </span>
          </div>
          <p className="text-[10px] text-primary-500/70 font-medium uppercase tracking-wider">
            Pending Sync
          </p>
        </div>
      )}

      {/* Greeting */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-gray-600 dark:text-gray-400 text-sm">{t('dashboard.greeting')}</p>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">
            {user?.full_name?.split(' ')[0]} 👋
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {/* Stream connection status indicator */}
          <span
            aria-label={
              isReconnecting
                ? 'Live updates: reconnecting'
                : isConnected
                  ? 'Live updates: connected'
                  : 'Live updates: disconnected'
            }
            title={
              isReconnecting
                ? 'Reconnecting to live updates…'
                : isConnected
                  ? 'Live updates active'
                  : 'Live updates paused'
            }
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
              isReconnecting
                ? 'bg-orange-400 animate-pulse'
                : isConnected
                  ? 'bg-green-400'
                  : 'bg-red-400'
            }`}
          />
          <button
            onClick={() => loadDashboard()}
            className="text-gray-400 hover:text-white"
            aria-label="Refresh dashboard"
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </div>

      {walletUnavailable && (
        <div
          role="alert"
          className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-4 text-red-300"
        >
          <p className="text-sm font-medium">
            Could not load wallet data. Check your connection and try again.
          </p>
          <button
            type="button"
            onClick={() => loadDashboard(true)}
            disabled={refreshing}
            className="mt-3 inline-flex items-center gap-2 rounded-lg bg-red-500/20 px-3 py-2 text-sm font-semibold text-red-100 hover:bg-red-500/30 disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Retry
          </button>
        </div>
      )}

      {/* Wallet Selector */}
      {!walletUnavailable && (
      <div className="relative">
        <button
          onClick={() => setShowWalletDropdown((v) => !v)}
          className="w-full flex items-center justify-between bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white hover:border-primary-500 transition-colors"
          aria-haspopup="listbox"
          aria-expanded={showWalletDropdown}
        >
          <div className="flex items-center gap-2">
            <Wallet size={16} className="text-primary-400" />
            <span className="font-medium">{wallet?.label || 'Select wallet'}</span>
            {wallet?.is_default && (
              <span className="text-xs bg-primary-500/20 text-primary-400 px-2 py-0.5 rounded-full">
                Default
              </span>
            )}
          </div>
          <ChevronDown
            size={16}
            className={`text-gray-400 transition-transform ${showWalletDropdown ? 'rotate-180' : ''}`}
          />
        </button>

        {showWalletDropdown && (
          <div
            className="absolute z-20 mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl shadow-xl overflow-hidden"
            role="listbox"
          >
            {wallets.map((w) => {
              const xlm = w.balances?.find((b) => b.asset === 'XLM')?.balance || '0';
              return (
                <button
                  key={w.id}
                  role="option"
                  aria-selected={w.id === activeWalletId}
                  onClick={() => {
                    setActiveWalletId(w.id);
                    setShowWalletDropdown(false);
                  }}
                  className={`w-full flex items-center justify-between px-4 py-3 text-left transition-colors ${
                    w.id === activeWalletId
                      ? 'bg-primary-500/20 text-primary-400'
                      : 'hover:bg-gray-700 text-white'
                  }`}
                >
                  <div>
                    <p className="font-medium text-sm">{w.label}</p>
                    <p className="text-xs text-gray-500 font-mono">
                      {truncateAddress(w.public_key, 8)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold">{parseFloat(xlm).toLocaleString()} XLM</p>
                    {w.is_default && <p className="text-xs text-primary-400">Default</p>}
                  </div>
                </button>
              );
            })}

            {/* Create new wallet */}
            {wallets.length < MAX_WALLETS && (
              <div className="border-t border-gray-700">
                {showCreateForm ? (
                  <form onSubmit={handleCreateWallet} className="p-3 flex gap-2">
                    <input
                      type="text"
                      placeholder="Wallet name"
                      value={newWalletLabel}
                      onChange={(e) => setNewWalletLabel(e.target.value)}
                      maxLength={100}
                      className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-400 focus:outline-none focus:border-primary-500"
                      autoFocus
                    />
                    <button
                      type="submit"
                      disabled={creatingWallet}
                      className="bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm font-semibold px-3 py-2 rounded-lg transition-colors"
                    >
                      {creatingWallet ? '…' : 'Create'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowCreateForm(false);
                        setNewWalletLabel('');
                      }}
                      className="text-gray-400 hover:text-white text-sm px-2 py-2 rounded-lg transition-colors"
                    >
                      ✕
                    </button>
                  </form>
                ) : (
                  <button
                    onClick={() => setShowCreateForm(true)}
                    className="w-full flex items-center gap-2 px-4 py-3 text-primary-400 hover:bg-gray-700 transition-colors text-sm"
                  >
                    <Plus size={14} /> Add wallet ({wallets.length}/{MAX_WALLETS})
                  </button>
                )}
              </div>
            )}

            {wallets.length >= MAX_WALLETS && (
              <div className="border-t border-gray-700 px-4 py-3 text-xs text-gray-500 text-center">
                Maximum {MAX_WALLETS} wallets reached
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {/* Balance Card */}
      {loading ? (
        <BalanceCardSkeleton />
      ) : walletUnavailable ? null : (
        <div
          className={`bg-gradient-to-br from-primary-600 to-primary-700 rounded-2xl p-5 shadow-lg shadow-primary-500/20 transition-all duration-500 ${
            balanceIncreased ? 'ring-4 ring-green-400 ring-opacity-50' : ''
          }`}
        >
          <div className="flex items-center justify-between mb-1">
            <p className="text-primary-100 text-sm">{t('dashboard.total_balance')}</p>
            {fromCache && (
              <span className="flex items-center gap-1 text-primary-200 text-xs bg-primary-800/40 rounded-full px-2 py-0.5">
                <WifiOff size={10} aria-hidden="true" />
                Cached
              </span>
            )}
          </div>

          {/* Primary display: selected asset balance */}
          <div className="flex items-end gap-2 mb-2">
            <BalanceDisplay balance={parseFloat(displayBalance)} />
            <span className="text-primary-200 mb-1">{selectedCurrency}</span>
          </div>
          {xlmAvailable !== null && selectedCurrency === 'XLM' && (
            <p className="text-primary-200 text-xs mb-2">
              Available to send: {parseFloat(xlmAvailable).toLocaleString()} XLM
            </p>
          )}

          {/* All asset balances */}
          {visibleBalances.length > 0 && (
            <div className="mb-3 space-y-1">
              {visibleBalances.map((b) => {
                const assetMeta = currencies.find((c) => c.code === b.asset);
                const flag = assetMeta?.flag ?? 'XLM';
                const isSelected = b.asset === selectedCurrency;
                return (
                  <button
                    key={b.asset}
                    onClick={() => setSelectedCurrency(b.asset)}
                    className={`w-full flex items-center justify-between rounded-lg px-3 py-1.5 transition-colors text-sm ${
                      isSelected
                        ? 'bg-white/20 text-white font-semibold'
                        : 'bg-primary-800/30 text-primary-100 hover:bg-primary-800/50'
                    }`}
                    aria-pressed={isSelected}
                  >
                    <span>
                      {flag} {b.asset}
                    </span>
                    <span>{parseFloat(b.balance).toLocaleString()}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Show all / hide zero-balance toggle */}
          {allBalances.some((b) => parseFloat(b.balance) === 0) && (
            <button
              onClick={() => setShowZeroBalances((v) => !v)}
              className="flex items-center gap-1 text-primary-200 text-xs mb-3 hover:text-white transition-colors"
            >
              {showZeroBalances ? <EyeOff size={12} /> : <Eye size={12} />}
              {showZeroBalances ? 'Hide zero balances' : 'Show all assets'}
            </button>
          )}

          {/* Fiat currency selector */}
          <div className="flex gap-2 flex-wrap mb-3" role="group" aria-label="Display currency">
            {currencies
              .filter((c) => c.code !== 'XLM')
              .map((c) => (
                <button
                  key={c.code}
                  onClick={() => setSelectedCurrency(c.code)}
                  aria-label={`Display in ${c.name}`}
                  aria-pressed={selectedCurrency === c.code}
                  className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                    selectedCurrency === c.code
                      ? 'bg-white text-primary-700 font-semibold'
                      : 'bg-primary-500/40 text-primary-100 hover:bg-primary-500/60'
                  }`}
                >
                  {c.flag} {c.code}
                </button>
              ))}
          </div>
          {usingApproximateRates && (
            <p className="text-primary-200/90 text-xs mb-3 leading-snug">
              {t('common.rates_disclaimer')}
            </p>
          )}

          {/* Wallet address */}
          <div className="flex items-center gap-2 bg-primary-800/40 rounded-lg px-3 py-2">
            <span className="text-primary-200 text-xs font-mono flex-1 truncate">
              {truncateAddress(wallet?.public_key, 10)}
            </span>
            {wallet?.public_key && (
              <button
                onClick={copyAddress}
                className="text-primary-200 hover:text-white shrink-0 transition-colors"
                aria-label={copied ? 'Address copied to clipboard' : 'Copy wallet address'}
                title={copied ? 'Copied!' : 'Copy address'}
              >
                {copied ? <CheckCheck size={14} className="text-green-400" /> : <Copy size={14} />}
              </button>
            )}
          </div>
        </div>
      )}

      {/* All wallets balance summary (when user has more than one) */}
      {wallets.length > 1 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-400 mb-3">All Wallets</h3>
          <div className="space-y-2">
            {wallets.map((w) => {
              const xlm = w.balances?.find((b) => b.asset === 'XLM')?.balance || '0';
              const isActive = w.id === activeWalletId;
              return (
                <button
                  key={w.id}
                  onClick={() => setActiveWalletId(w.id)}
                  className={`w-full flex items-center justify-between rounded-lg px-3 py-2 transition-colors ${
                    isActive
                      ? 'bg-primary-500/10 border border-primary-500/30'
                      : 'hover:bg-gray-800'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Wallet size={14} className={isActive ? 'text-primary-400' : 'text-gray-500'} />
                    <span
                      className={`text-sm ${isActive ? 'text-primary-400 font-medium' : 'text-gray-300'}`}
                    >
                      {w.label}
                    </span>
                  </div>
                  <span className="text-sm font-semibold text-white">
                    {parseFloat(xlm).toLocaleString()} XLM
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => navigate(`/send${activeWalletId ? `?wallet_id=${activeWalletId}` : ''}`)}
          className="bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border border-gray-100 dark:border-gray-700 rounded-xl p-4 flex items-center gap-3 shadow-sm transition-all"
        >
          <div className="w-10 h-10 bg-primary-500/10 rounded-lg flex items-center justify-center text-primary-500">
            <Send size={20} />
          </div>
          <span className="font-semibold text-gray-900 dark:text-white">{t('dashboard.send')}</span>
        </button>
        <button
          onClick={() => navigate('/save')}
          className="bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border border-gray-100 dark:border-gray-700 rounded-xl p-4 flex items-center gap-3 shadow-sm transition-all"
        >
          <div className="w-10 h-10 bg-green-500/10 rounded-lg flex items-center justify-center text-green-500">
            <PiggyBank size={20} />
          </div>
          <span className="font-semibold text-gray-900 dark:text-white">Save</span>
        </button>
      </div>

      {/* Fiat on/off ramp */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => handleAnchorAction('deposit')}
          disabled={anchorLoading}
          className="bg-green-500/10 hover:bg-green-500/20 disabled:opacity-50 border border-green-500/30 rounded-xl p-4 flex items-center gap-3 shadow-sm transition-all"
        >
          <div className="w-10 h-10 bg-green-500/20 rounded-lg flex items-center justify-center text-green-500">
            {anchorLoading && anchorAction === 'deposit' ? (
              <div className="w-5 h-5 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
            ) : (
              <Plus size={20} />
            )}
          </div>
          <span className="font-semibold text-green-600 dark:text-green-400">
            {t('dashboard.add_money') || 'Add Money'}
          </span>
        </button>
        <button
          onClick={() => handleAnchorAction('withdraw')}
          disabled={anchorLoading}
          className="bg-blue-500/10 hover:bg-blue-500/20 disabled:opacity-50 border border-blue-500/30 rounded-xl p-4 flex items-center gap-3 shadow-sm transition-all"
        >
          <div className="w-10 h-10 bg-blue-500/20 rounded-lg flex items-center justify-center text-blue-500">
            {anchorLoading && anchorAction === 'withdraw' ? (
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            ) : (
              <Minus size={20} />
            )}
          </div>
          <span className="font-semibold text-blue-600 dark:text-blue-400">
            {t('dashboard.withdraw') || 'Withdraw'}
          </span>
        </button>
      </div>

      {/* Admin Dashboard: Contract State Viewer */}
      {user?.role === 'admin' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-primary-400 mb-3">
            Admin: Contract State Viewer
          </h3>
          <div className="flex gap-2 flex-wrap mb-3">
            <input
              type="text"
              placeholder="Contract ID (C...)"
              value={adminContractId}
              onChange={(e) => setAdminContractId(e.target.value)}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
            />
            <input
              type="text"
              placeholder="Key Prefix (optional)"
              value={adminKeyPrefix}
              onChange={(e) => setAdminKeyPrefix(e.target.value)}
              className="w-32 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
            />
            <button
              type="button"
              onClick={fetchContractState}
              disabled={adminStateLoading || !adminContractId}
              className="bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
            >
              {adminStateLoading ? 'Loading...' : 'View State'}
            </button>
          </div>
          {adminContractState && (
            <div className="bg-gray-800 p-3 rounded-lg overflow-x-auto text-xs font-mono text-gray-300">
              {JSON.stringify(adminContractState, null, 2)}
            </div>
          )}
        </div>
      )}

      {/* Upcoming Scheduled Payments */}
      {(scheduledLoading || scheduledPayments.length > 0) && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-900 dark:text-white">Upcoming Payments</h3>
            <button
              onClick={() => navigate('/scheduled')}
              className="text-primary-500 text-sm hover:underline"
            >
              See all
            </button>
          </div>
          {scheduledLoading ? (
            <div className="space-y-2">
              {[0, 1].map((i) => (
                <div key={i} className="skeleton h-14 rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {scheduledPayments.map((p) => (
                <div
                  key={p.id}
                  className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-3 flex items-center gap-3 shadow-sm"
                >
                  <div className="w-9 h-9 rounded-full bg-primary-500/10 text-primary-400 flex items-center justify-center shrink-0">
                    <Clock size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                      {p.recipient_wallet.slice(0, 8)}…{p.recipient_wallet.slice(-4)}
                    </p>
                    <p className="text-xs text-gray-500 capitalize">
                      {p.frequency} · Next: {new Date(p.next_run_at).toLocaleDateString()}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-primary-400 shrink-0">
                    {p.amount} {p.asset}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Issue #454: PIN setup modal on first login */}
      <PINSetupModal
        isOpen={showPINSetup}
        onClose={() => setShowPINSetup(false)}
        onSuccess={() => updateUser({ pin_setup_completed: true })}
      />

      {/* Recent transactions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-900 dark:text-white">
            {t('dashboard.recent_activity')}
          </h3>
          <button
            onClick={() => navigate('/history')}
            className="text-primary-500 text-sm hover:underline"
          >
            {t('common.see_all')}
          </button>
        </div>

        {loading && transactions.length === 0 ? (
          <div className="space-y-2" data-testid="transactions-skeleton" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <TransactionRowSkeleton key={i} />
            ))}
          </div>
        ) : (txError || transactionsError) && transactions.length === 0 ? (
          <div
            role="alert"
            className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-4 text-red-300 shadow-sm"
          >
            <p className="text-sm font-medium">Could not load recent activity.</p>
            <button
              type="button"
              onClick={() => loadDashboard(true)}
              disabled={refreshing}
              className="mt-3 inline-flex items-center gap-2 rounded-lg bg-red-500/20 px-3 py-2 text-sm font-semibold text-red-100 hover:bg-red-500/30 disabled:opacity-50"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              Retry
            </button>
          </div>
        ) : transactions.length === 0 ? (
          <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-8 text-center shadow-sm">
            <div className="w-16 h-16 bg-primary-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <Send size={28} className="text-primary-500" />
            </div>
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">
              No transactions yet
            </h3>
            <p className="text-gray-500 text-sm mb-6 max-w-xs mx-auto">
              Send your first payment or add funds to get started with AfriPay.
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => navigate(`/send${activeWalletId ? `?wallet_id=${activeWalletId}` : ''}`)}
                className="bg-primary-500 hover:bg-primary-600 text-white font-semibold py-2.5 px-5 rounded-xl text-sm transition-colors flex items-center gap-2"
              >
                <Send size={16} />
                Send Money
              </button>
              <button
                onClick={() => handleAnchorAction('deposit')}
                disabled={anchorLoading}
                className="bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-900 dark:text-white font-semibold py-2.5 px-5 rounded-xl text-sm transition-colors flex items-center gap-2 border border-gray-200 dark:border-gray-700"
              >
                <Plus size={16} />
                Add Funds
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {transactions.map((tx) => (
              <div
                key={tx.id}
                className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-3 flex items-center gap-3 shadow-sm"
              >
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                    tx.direction === 'sent'
                      ? 'bg-red-500/10 text-red-400'
                      : 'bg-primary-500/10 text-primary-400'
                  }`}
                >
                  {tx.direction === 'sent' ? <Send size={16} /> : <Download size={16} />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-900 dark:text-white font-medium truncate">
                    {tx.direction === 'sent'
                      ? `${t('dashboard.to')} ${truncateAddress(tx.recipient_wallet)}`
                      : `${t('dashboard.from')} ${truncateAddress(tx.sender_wallet)}`}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-xs text-gray-500">
                      {new Date(tx.created_at).toLocaleDateString()}
                    </p>
                    {tx.status && tx.status !== 'completed' && (
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                          tx.status === 'pending'
                            ? 'bg-yellow-500/10 text-yellow-400'
                            : tx.status === 'failed'
                              ? 'bg-red-500/10 text-red-400'
                              : tx.status === 'cancelled'
                                ? 'bg-gray-500/10 text-gray-400'
                                : 'bg-blue-500/10 text-blue-400'
                        }`}
                      >
                        {tx.status}
                      </span>
                    )}
                  </div>
                </div>
                <span
                  className={`text-sm font-semibold shrink-0 ${
                    tx.direction === 'sent' ? 'text-red-400' : 'text-primary-400'
                  }`}
                >
                  {tx.direction === 'sent' ? '-' : '+'}
                  {tx.amount} {tx.asset}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
