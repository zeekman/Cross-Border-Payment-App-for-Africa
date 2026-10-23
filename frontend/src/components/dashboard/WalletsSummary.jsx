import { Wallet } from 'lucide-react';

export default function WalletsSummary({ wallets, activeWalletId, setActiveWalletId }) {
  return (
    <>
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
    </>
  );
}
