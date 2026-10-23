import { Send, Download, RefreshCw, Plus } from 'lucide-react';
import { TransactionRowSkeleton } from '../../components/Skeleton';
import { truncateAddress } from '../../utils/currency';

export default function RecentTransactions({ navigate, t, activeWalletId, transactions, txError, loading, refreshing, anchorLoading, transactionsError, loadDashboard, handleAnchorAction }) {
  return (
    <>
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
    </>
  );
}
