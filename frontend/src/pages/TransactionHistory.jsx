import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Send, Download, ExternalLink, Filter } from 'lucide-react';
import api from '../utils/api';
import { truncateAddress } from '../utils/currency';
import { useTranslation } from 'react-i18next';

const STATUS_COLORS = {
  completed: 'text-primary-400 bg-primary-500/10',
  pending: 'text-yellow-400 bg-yellow-500/10',
  failed: 'text-red-400 bg-red-500/10'
};

export default function TransactionHistory() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    api.get('/payments/history')
      .then(r => setTransactions(r.data.transactions))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filtered = transactions.filter(tx => {
    if (filter === 'sent') return tx.direction === 'sent';
    if (filter === 'received') return tx.direction === 'received';
    return true;
  });

  const filters = [
    { key: 'all', label: t('history.filter_all') },
    { key: 'sent', label: t('history.filter_sent') },
    { key: 'received', label: t('history.filter_received') },
  ];

  return (
    <div className="px-4 py-6 max-w-lg mx-auto">
      <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white mb-6 flex items-center gap-1">
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-white">{t('history.title')}</h2>
        <Filter size={18} className="text-gray-400" />
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-6">
        {filters.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium capitalize transition-colors ${
              filter === f.key ? 'bg-primary-500 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-4xl mb-3">📭</p>
          <p>{t('common.no_transactions')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(tx => (
            <div key={tx.id} className="bg-gray-900 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                  tx.direction === 'sent' ? 'bg-red-500/10 text-red-400' : 'bg-primary-500/10 text-primary-400'
                }`}>
                  {tx.direction === 'sent' ? <Send size={16} /> : <Download size={16} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-white capitalize">{tx.direction}</p>
                    <span className={`text-sm font-bold ${tx.direction === 'sent' ? 'text-red-400' : 'text-primary-400'}`}>
                      {tx.direction === 'sent' ? '-' : '+'}{tx.amount} {tx.asset}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {tx.direction === 'sent'
                      ? `${t('history.to')} ${truncateAddress(tx.recipient_wallet)}`
                      : `${t('history.from')} ${truncateAddress(tx.sender_wallet)}`}
                  </p>
                  {tx.memo && <p className="text-xs text-gray-600 mt-0.5">"{tx.memo}"</p>}
                  <div className="flex items-center justify-between mt-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[tx.status] || STATUS_COLORS.pending}`}>
                      {tx.status}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-600">
                        {new Date(tx.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </span>
                      {tx.tx_hash && (
                        <a
                          href={`https://stellar.expert/explorer/testnet/tx/${tx.tx_hash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-500 hover:text-primary-400 transition-colors"
                        >
                          <ExternalLink size={12} />
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
