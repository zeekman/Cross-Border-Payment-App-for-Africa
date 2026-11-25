import { Send, PiggyBank } from 'lucide-react';

export default function ActionButtons({ navigate, t, activeWalletId }) {
  return (
    <>
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
    </>
  );
}
