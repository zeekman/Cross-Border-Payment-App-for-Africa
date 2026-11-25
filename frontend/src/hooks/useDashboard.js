import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import api from '../utils/api';
import { useExchangeRates } from '../hooks/useExchangeRates';
import { usePaymentStream } from '../hooks/usePaymentStream';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { setCacheEntry, getCacheEntry } from '../utils/offlineDB';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { getQueueCountForUser } from '../utils/offlineDB';
import { IS_TESTNET } from '../config/network';
import { safeAnchorUrl } from '../utils/anchorUrl';


function normalizeWalletsResponse(data) {
  if (Array.isArray(data?.wallets)) return data.wallets;
  if (data?.public_key) return [data];
  return [];
}

export function useDashboard() {
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
    // Prevent reverse tabnabbing: the third-party anchor must not get a handle to this tab.
    if (win) win.opener = null;
    try {
      const asset = 'USDC';
      const endpoint = action === 'deposit' ? '/anchor/deposit' : '/anchor/withdraw';
      const res = await api.post(endpoint, { asset });
      const url = safeAnchorUrl(res.data?.url);
      if (!url) throw new Error('Refusing to open an untrusted anchor URL');
      if (win) {
        win.location.href = url;
      } else {
        toast(
          (tst) => (
            <a href={url} target="_blank" rel="noopener noreferrer" onClick={() => toast.dismiss(tst.id)}>
              Continue to anchor
            </a>
          ),
          { duration: 15000 }
        );
      }
    } catch (err) {
      if (win) win.close();
      toast.error(err.response?.data?.error || err.message || `Failed to ${action}`);
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

  return {
    user,
    updateUser,
    navigate,
    t,
    showPINSetup,
    setShowPINSetup,
    mountedRef,
    pushSupported,
    pushSubscribed,
    pushLoading,
    pushSubscribe,
    pushDismissed,
    setPushDismissed,
    showPushBanner,
    dismissPushBanner,
    wallets,
    setWallets,
    activeWalletId,
    setActiveWalletId,
    showWalletDropdown,
    setShowWalletDropdown,
    creatingWallet,
    setCreatingWallet,
    newWalletLabel,
    setNewWalletLabel,
    showCreateForm,
    setShowCreateForm,
    wallet,
    transactions,
    setTransactions,
    txError,
    setTxError,
    scheduledPayments,
    setScheduledPayments,
    scheduledLoading,
    setScheduledLoading,
    loading,
    setLoading,
    refreshing,
    setRefreshing,
    copied,
    setCopied,
    selectedCurrency,
    setSelectedCurrency,
    funding,
    setFunding,
    anchorLoading,
    setAnchorLoading,
    anchorAction,
    setAnchorAction,
    balanceIncreased,
    setBalanceIncreased,
    fromCache,
    setFromCache,
    showZeroBalances,
    setShowZeroBalances,
    walletError,
    setWalletError,
    transactionsError,
    setTransactionsError,
    queueCount,
    setQueueCount,
    currencies,
    convertFromXLM,
    usingApproximateRates,
    isOnline,
    showEmailBanner,
    setShowEmailBanner,
    handlePayment,
    isConnected,
    isReconnecting,
    streamError,
    loadDashboard,
    copyAddress,
    fundWallet,
    handleAnchorAction,
    handleCreateWallet,
    xlmBalance,
    xlmAvailable,
    accountExists,
    showFundWalletButton,
    allBalances,
    visibleBalances,
    selectedAssetBalance,
    displayBalance,
    walletUnavailable,
    pullDistance,
    pullRefreshing,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
  };
}
