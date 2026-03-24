import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, Download, RefreshCw, Copy, CheckCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import { truncateAddress, CURRENCIES, convertFromXLM } from '../utils/currency';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [wallet, setWallet] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [selectedCurrency, setSelectedCurrency] = useState('XLM');

  useEffect(() => {
    Promise.all([
      api.get('/wallet/balance'),
      api.get('/payments/history')
    ]).then(([walletRes, txRes]) => {
      setWallet(walletRes.data);
      setTransactions(txRes.data.transactions.slice(0, 5));
    }).catch(() => toast.error('Failed to load wallet data'))
      .finally(() => setLoading(false));
  }, []);

  const copyAddress = () => {
    navigator.clipboard.writeText(wallet?.public_key || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const xlmBalance = wallet?.balances?.find(b => b.asset === 'XLM')?.balance || '0';
  const displayBalance = selectedCurrency === 'XLM'
    ? xlmBalance
    : convertFromXLM(xlmBalance, selectedCurrency);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="px-4 py-6 max-w-lg mx-auto space-y-6">
      {/* Greeting */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-gray-400 text-sm">{t('dashboard.greeting')}</p>
          <h2 className="text-xl font-bold text-white">{user?.full_name?.split(' ')[0]} 👋</h2>
        </div>
        <button onClick={() => window.location.reload()} className="text-gray-400 hover:text-white">
          <RefreshCw size={18} />
        </button>
      </div>

      {/* Balance Card */}
      <div className="bg-gradient-to-br from-primary-600 to-primary-700 rounded-2xl p-5 shadow-lg shadow-primary-500/20">
        <p className="text-primary-100 text-sm mb-1">{t('dashboard.total_balance')}</p>
        <div className="flex items-end gap-2 mb-4">
          <span className="text-4xl font-bold text-white">{parseFloat(displayBalance).toLocaleString()}</span>
          <span className="text-primary-200 mb-1">{selectedCurrency}</span>
        </div>

        {/* Currency selector */}
        <div className="flex gap-2 flex-wrap mb-4">
          {CURRENCIES.map(c => (
            <button
              key={c.code}
              onClick={() => setSelectedCurrency(c.code)}
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

        {/* Wallet address */}
        <div className="flex items-center gap-2 bg-primary-800/40 rounded-lg px-3 py-2">
          <span className="text-primary-200 text-xs font-mono flex-1 truncate">
            {truncateAddress(wallet?.public_key, 10)}
          </span>
          <button onClick={copyAddress} className="text-primary-200 hover:text-white shrink-0">
            {copied ? <CheckCheck size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </div>

      {/* Action buttons */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => navigate('/send')}
          className="bg-gray-800 hover:bg-gray-700 rounded-xl p-4 flex items-center gap-3 transition-colors"
        >
          <div className="w-10 h-10 bg-primary-500/10 rounded-lg flex items-center justify-center text-primary-500">
            <Send size={20} />
          </div>
          <span className="font-semibold text-white">{t('dashboard.send')}</span>
        </button>
        <button
          onClick={() => navigate('/receive')}
          className="bg-gray-800 hover:bg-gray-700 rounded-xl p-4 flex items-center gap-3 transition-colors"
        >
          <div className="w-10 h-10 bg-primary-500/10 rounded-lg flex items-center justify-center text-primary-500">
            <Download size={20} />
          </div>
          <span className="font-semibold text-white">{t('dashboard.receive')}</span>
        </button>
      </div>

      {/* Recent transactions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-white">{t('dashboard.recent_activity')}</h3>
          <button onClick={() => navigate('/history')} className="text-primary-500 text-sm hover:underline">
            {t('common.see_all')}
          </button>
        </div>

        {transactions.length === 0 ? (
          <div className="bg-gray-900 rounded-xl p-6 text-center text-gray-500 text-sm">
            {t('dashboard.no_transactions')}
          </div>
        ) : (
          <div className="space-y-2">
            {transactions.map(tx => (
              <div key={tx.id} className="bg-gray-900 rounded-xl p-3 flex items-center gap-3">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                  tx.direction === 'sent' ? 'bg-red-500/10 text-red-400' : 'bg-primary-500/10 text-primary-400'
                }`}>
                  {tx.direction === 'sent' ? <Send size={16} /> : <Download size={16} />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white font-medium truncate">
                    {tx.direction === 'sent'
                      ? `${t('dashboard.to')} ${truncateAddress(tx.recipient_wallet)}`
                      : `${t('dashboard.from')} ${truncateAddress(tx.sender_wallet)}`}
                  </p>
                  <p className="text-xs text-gray-500">{new Date(tx.created_at).toLocaleDateString()}</p>
                </div>
                <span className={`text-sm font-semibold shrink-0 ${tx.direction === 'sent' ? 'text-red-400' : 'text-primary-400'}`}>
                  {tx.direction === 'sent' ? '-' : '+'}{tx.amount} {tx.asset}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
