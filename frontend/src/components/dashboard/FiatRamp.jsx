import { Plus, Minus } from 'lucide-react';

export default function FiatRamp({ t, anchorLoading, anchorAction, handleAnchorAction }) {
  return (
    <>
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
    </>
  );
}
