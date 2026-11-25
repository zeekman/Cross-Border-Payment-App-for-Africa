import React from 'react';
import { RefreshCw } from 'lucide-react';
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
import { useWallet } from '../context/WalletContext';
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
import { useDashboard } from '../hooks/useDashboard';
import DashboardBanners from '../components/dashboard/DashboardBanners';
import DashboardGreeting from '../components/dashboard/DashboardGreeting';
import WalletSelector from '../components/dashboard/WalletSelector';
import BalanceCard from '../components/dashboard/BalanceCard';
import WalletsSummary from '../components/dashboard/WalletsSummary';
import ActionButtons from '../components/dashboard/ActionButtons';
import FiatRamp from '../components/dashboard/FiatRamp';
import AdminContractViewer from '../components/dashboard/AdminContractViewer';
import ScheduledPayments from '../components/dashboard/ScheduledPayments';
import RecentTransactions from '../components/dashboard/RecentTransactions';

export { safeAnchorUrl } from '../utils/anchorUrl';

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

  // Multi-wallet state
  const [wallets, setWallets] = useState([]);
  const { activeWalletId, setActiveWalletId } = useWallet();
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
    accountExists,
    activeWalletId,
    allBalances,
    anchorAction,
    anchorLoading,
    balanceIncreased,
    copied,
    copyAddress,
    creatingWallet,
    currencies,
    dismissPushBanner,
    displayBalance,
    fromCache,
    fundWallet,
    funding,
    handleAnchorAction,
    handleCreateWallet,
    isConnected,
    isOnline,
    isReconnecting,
    loadDashboard,
    loading,
    navigate,
    newWalletLabel,
    onTouchEnd,
    onTouchMove,
    onTouchStart,
    pullDistance,
    pullRefreshing,
    pushLoading,
    pushSubscribe,
    queueCount,
    refreshing,
    scheduledLoading,
    scheduledPayments,
    selectedCurrency,
    setActiveWalletId,
    setNewWalletLabel,
    setSelectedCurrency,
    setShowCreateForm,
    setShowEmailBanner,
    setShowPINSetup,
    setShowWalletDropdown,
    setShowZeroBalances,
    showCreateForm,
    showEmailBanner,
    showFundWalletButton,
    showPINSetup,
    showPushBanner,
    showWalletDropdown,
    showZeroBalances,
    streamError,
    t,
    transactions,
    transactionsError,
    txError,
    updateUser,
    user,
    usingApproximateRates,
    visibleBalances,
    wallet,
    walletUnavailable,
    wallets,
    xlmAvailable,
  } = useDashboard();

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
      <DashboardBanners user={user} t={t} pushLoading={pushLoading} pushSubscribe={pushSubscribe} showPushBanner={showPushBanner} dismissPushBanner={dismissPushBanner} wallet={wallet} funding={funding} queueCount={queueCount} isOnline={isOnline} showEmailBanner={showEmailBanner} setShowEmailBanner={setShowEmailBanner} isConnected={isConnected} isReconnecting={isReconnecting} streamError={streamError} loadDashboard={loadDashboard} fundWallet={fundWallet} accountExists={accountExists} showFundWalletButton={showFundWalletButton} />

      <DashboardGreeting user={user} t={t} wallet={wallet} refreshing={refreshing} isConnected={isConnected} isReconnecting={isReconnecting} loadDashboard={loadDashboard} walletUnavailable={walletUnavailable} />

      <WalletSelector t={t} wallets={wallets} activeWalletId={activeWalletId} setActiveWalletId={setActiveWalletId} showWalletDropdown={showWalletDropdown} setShowWalletDropdown={setShowWalletDropdown} creatingWallet={creatingWallet} newWalletLabel={newWalletLabel} setNewWalletLabel={setNewWalletLabel} showCreateForm={showCreateForm} setShowCreateForm={setShowCreateForm} wallet={wallet} handleCreateWallet={handleCreateWallet} walletUnavailable={walletUnavailable} />

      <BalanceCard t={t} wallet={wallet} loading={loading} copied={copied} selectedCurrency={selectedCurrency} setSelectedCurrency={setSelectedCurrency} balanceIncreased={balanceIncreased} fromCache={fromCache} showZeroBalances={showZeroBalances} setShowZeroBalances={setShowZeroBalances} currencies={currencies} usingApproximateRates={usingApproximateRates} copyAddress={copyAddress} xlmAvailable={xlmAvailable} allBalances={allBalances} visibleBalances={visibleBalances} displayBalance={displayBalance} walletUnavailable={walletUnavailable} />

      <WalletsSummary user={user} wallets={wallets} activeWalletId={activeWalletId} setActiveWalletId={setActiveWalletId} />

      <ActionButtons navigate={navigate} t={t} activeWalletId={activeWalletId} />

      <FiatRamp t={t} anchorLoading={anchorLoading} anchorAction={anchorAction} handleAnchorAction={handleAnchorAction} />

      <AdminContractViewer />

      <ScheduledPayments navigate={navigate} scheduledPayments={scheduledPayments} scheduledLoading={scheduledLoading} />
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

      <RecentTransactions navigate={navigate} t={t} activeWalletId={activeWalletId} transactions={transactions} txError={txError} loading={loading} refreshing={refreshing} anchorLoading={anchorLoading} transactionsError={transactionsError} loadDashboard={loadDashboard} handleAnchorAction={handleAnchorAction} />
    </div>
  );
}
