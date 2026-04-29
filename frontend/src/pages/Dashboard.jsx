import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, Download, RefreshCw, Copy, CheckCheck, FlaskConical, Plus, Minus, WifiOff, Wallet, ChevronDown } from 'lucide-react';
import { Send, Download, RefreshCw, Copy, CheckCheck, FlaskConical, Plus, Minus, PiggyBank } from 'lucide-react';
import { Send, Download, RefreshCw, Copy, CheckCheck, FlaskConical, Plus, Minus, WifiOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { BalanceCardSkeleton, TransactionRowSkeleton } from '../components/Skeleton';
import api from '../utils/api';
import { truncateAddress } from '../utils/currency';
import { useExchangeRates } from '../hooks/useExchangeRates';
import { usePaymentStream } from '../hooks/usePaymentStream';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { setCacheEntry, getCacheEntry } from '../utils/offlineDB';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

const IS_TESTNET = process.env.REACT_APP_STELLAR_NETWORK !== 'mainnet';
const MAX_WALLETS = 5;

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  // Admin Contract State Viewer
  const [adminContractId, setAdminContractId] = useState('');
  const [adminKeyPrefix, setAdminKeyPrefix] = useState('');
  const [adminContractState, setAdminContractState] = useState(null);
  const [adminStateLoading, setAdminStateLoading] = useState(false);

  const fetchContractState = async () => {
    if (!adminContractId) return;
    setAdminStateLoading(true);
    try {
      const res = await api.get(`/contracts/${adminContractId}/state`, { params: { prefix: adminKeyPrefix } });
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [selectedCurrency, setSelectedCurrency] = useState('XLM');
  const [funding, setFunding] = useState(false);
  const [balanceIncreased, setBalanceIncreased] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const { currencies, convertFromXLM, usingApproximateRates } = useExchangeRates();
  const { isOnline } = useOnlineStatus();

  // Handle incoming payment from stream
  const handlePayment = useCallback(
    (payment) => {
      if (payment.to === wallet?.public_key) {
        toast.success(`Received ${payment.amount} ${payment.asset}`);
        setBalanceIncreased(true);
        setTimeout(() => setBalanceIncreased(false), 2000);
        Promise.all([
          api.get('/wallet/list'),
          api.get('/payments/history'),
        ]).then(([walletsRes, txRes]) => {
          setWallets(walletsRes.data.wallets);
          setTransactions(txRes.data.transactions.slice(0, 5));
        }).catch(() => { });
      }
    },
    [wallet?.public_key],
  );

  const { isConnected, isReconnecting, error: streamError } = usePaymentStream(wallet?.public_key, handlePayment);

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
      const [walletsRes, txRes] = await Promise.all([
        api.get('/wallet/list'),
        api.get('/payments/history'),
      ]);
      const walletsData = walletsRes.data.wallets;
      const txData = txRes.data.transactions;

      setWallets(walletsData);
      setActiveWalletId((id) => id || walletsData[0]?.id || null);
      setTransactions(txData.slice(0, 5));
      setFromCache(false);

      await Promise.all([
        setCacheEntry('wallets', walletsData),
        setCacheEntry('history', txData),
      ]);
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
        }
        if (cachedHistory?.data) {
          setTransactions(cachedHistory.data.slice(0, 5));
        }
        if (!cachedWallets?.data) toast.error('Failed to load wallet data');
      } catch {
        toast.error('Failed to load wallet data');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const copyAddress = () => {
    navigator.clipboard.writeText(wallet?.public_key || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const fundWallet = async () => {
    setFunding(true);
    try {
      const res = await api.post('/dev/fund-wallet');
      toast.success(res.data.message);
      const walletsRes = await api.get('/wallet/list');
      setWallets(walletsRes.data.wallets);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Funding failed');
    } finally {
      setFunding(false);
    }
  };

  const handleAnchorAction = async (action) => {
    try {
      const asset = 'USDC';
      const endpoint = action === 'deposit' ? '/anchor/deposit' : '/anchor/withdraw';
      const res = await api.post(endpoint, { asset });
      window.open(res.data.url, 'anchor', 'width=500,height=600');
    } catch (err) {
      toast.error(err.response?.data?.error || `Failed to ${action}`);
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

  const xlmBalance = wallet?.balances?.find((b) => b.asset === 'XLM')?.balance || '0';
  const xlmAvailable = wallet?.balances?.find((b) => b.asset === 'XLM')?.available_balance || null;
  const accountExists = wallet?.account_exists !== false; // treat undefined (cached) as true
  const displayBalance =
    selectedCurrency === 'XLM' ? xlmBalance : convertFromXLM(xlmBalance, selectedCurrency);

  if (loading)
    return (
      <div className="px-4 py-6 max-w-lg mx-auto space-y-6" aria-busy="true" aria-label="Loading dashboard">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <div className="skeleton h-3 w-20 rounded-lg" />
            <div className="skeleton h-5 w-32 rounded-lg" />
          </div>
        </div>
        <BalanceCardSkeleton />
        <div className="grid grid-cols-2 gap-3">
          <div className="skeleton h-16 rounded-xl" />
          <div className="skeleton h-16 rounded-xl" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <TransactionRowSkeleton key={i} />
          ))}
        </div>
      </div>
    );

  return (
    <div className="px-4 py-6 max-w-lg mx-auto space-y-6">
      {/* Testnet banner */}
      {IS_TESTNET && (
        <div className="flex items-center justify-between bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2 text-yellow-400 text-sm">
            <FlaskConical size={15} />
            <span>Testnet mode — funds have no real value</span>
          </div>
          {!accountExists && (
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

      {/* Greeting */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-gray-600 dark:text-gray-400 text-sm">{t('dashboard.greeting')}</p>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">
            {user?.full_name?.split(' ')[0]} 👋
          </h2>
        </div>
        <button
          onClick={() => loadDashboard(true)}
          disabled={refreshing}
          className="text-gray-400 hover:text-white disabled:opacity-50 transition-opacity"
          aria-label={refreshing ? 'Refreshing dashboard…' : 'Refresh dashboard'}
        >
          <RefreshCw
            size={18}
            className={refreshing ? 'animate-spin' : ''}
          />
        </button>
      </div>

      {/* Wallet Selector */}
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
                  className={`w-full flex items-center justify-between px-4 py-3 text-left transition-colors ${w.id === activeWalletId
                      ? 'bg-primary-500/20 text-primary-400'
                      : 'hover:bg-gray-700 text-white'
                    }`}
                >
                  <div>
                    <p className="font-medium text-sm">{w.label}</p>
                    <p className="text-xs text-gray-500 font-mono">{truncateAddress(w.public_key, 8)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold">{parseFloat(xlm).toLocaleString()} XLM</p>
                    {w.is_default && (
                      <p className="text-xs text-primary-400">Default</p>
                    )}
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
                      onClick={() => { setShowCreateForm(false); setNewWalletLabel(''); }}
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

      {/* Balance Card */}
      <div
        className={`bg-gradient-to-br from-primary-600 to-primary-700 rounded-2xl p-5 shadow-lg shadow-primary-500/20 transition-all duration-500 ${balanceIncreased ? 'ring-4 ring-green-400 ring-opacity-50' : ''
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
        <div className="flex items-end gap-2 mb-4">
          <span className="text-4xl font-bold text-white">
            {parseFloat(displayBalance).toLocaleString()}
          </span>
          <span className="text-primary-200 mb-1">{selectedCurrency}</span>
        </div>
        {xlmAvailable !== null && selectedCurrency === 'XLM' && (
          <p className="text-primary-200 text-xs mb-3">
            Available to send: {parseFloat(xlmAvailable).toLocaleString()} XLM
          </p>
        )}

        {/* Currency selector */}
        <div className="flex gap-2 flex-wrap mb-4">
          {currencies.map((c) => (
            <button
              key={c.code}
              onClick={() => setSelectedCurrency(c.code)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${selectedCurrency === c.code
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
          <button
            onClick={copyAddress}
            className="text-primary-200 hover:text-white shrink-0"
            aria-label={copied ? 'Address copied' : 'Copy wallet address'}
          >
            {copied ? <CheckCheck size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </div>

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
                  className={`w-full flex items-center justify-between rounded-lg px-3 py-2 transition-colors ${isActive ? 'bg-primary-500/10 border border-primary-500/30' : 'hover:bg-gray-800'
                    }`}
                >
                  <div className="flex items-center gap-2">
                    <Wallet size={14} className={isActive ? 'text-primary-400' : 'text-gray-500'} />
                    <span className={`text-sm ${isActive ? 'text-primary-400 font-medium' : 'text-gray-300'}`}>
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
          className="bg-green-500/10 hover:bg-green-500/20 border border-green-500/30 rounded-xl p-4 flex items-center gap-3 shadow-sm transition-all"
        >
          <div className="w-10 h-10 bg-green-500/20 rounded-lg flex items-center justify-center text-green-500">
            <Plus size={20} />
          </div>
          <span className="font-semibold text-green-600 dark:text-green-400">
            {t('dashboard.add_money') || 'Add Money'}
          </span>
        </button>
        <button
          onClick={() => handleAnchorAction('withdraw')}
          className="bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 rounded-xl p-4 flex items-center gap-3 shadow-sm transition-all"
        >
          <div className="w-10 h-10 bg-blue-500/20 rounded-lg flex items-center justify-center text-blue-500">
            <Minus size={20} />
          </div>
          <span className="font-semibold text-blue-600 dark:text-blue-400">
            {t('dashboard.withdraw') || 'Withdraw'}
          </span>
        </button>
      </div>

      {/* Admin Dashboard: Contract State Viewer */}
      {user?.role === 'admin' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-primary-400 mb-3">Admin: Contract State Viewer</h3>
          <div className="flex gap-2 flex-wrap mb-3">
            <input
              type="text"
              placeholder="Contract ID (C...)"
              value={adminContractId}
              onChange={e => setAdminContractId(e.target.value)}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
            />
            <input
              type="text"
              placeholder="Key Prefix (optional)"
              value={adminKeyPrefix}
              onChange={e => setAdminKeyPrefix(e.target.value)}
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

      {/* Recent transactions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-900 dark:text-white">{t('dashboard.recent_activity')}</h3>
          <button onClick={() => navigate('/history')} className="text-primary-500 text-sm hover:underline">
            {t('common.see_all')}
          </button>
        </div>

        {transactions.length === 0 ? (
          <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-6 text-center text-gray-500 text-sm shadow-sm">
            {t('dashboard.no_transactions')}
          </div>
        ) : (
          <div className="space-y-2">
            {transactions.map((tx) => (
              <div
                key={tx.id}
                className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-3 flex items-center gap-3 shadow-sm"
              >
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${tx.direction === 'sent'
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
                  <p className="text-xs text-gray-500">{new Date(tx.created_at).toLocaleDateString()}</p>
                </div>
                <span
                  className={`text-sm font-semibold shrink-0 ${tx.direction === 'sent' ? 'text-red-400' : 'text-primary-400'
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
