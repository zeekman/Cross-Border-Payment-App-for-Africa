import { Plus, Wallet, ChevronDown } from 'lucide-react';
import { truncateAddress } from '../../utils/currency';

const MAX_WALLETS = 5;

export default function WalletSelector({ wallets, activeWalletId, setActiveWalletId, showWalletDropdown, setShowWalletDropdown, creatingWallet, newWalletLabel, setNewWalletLabel, showCreateForm, setShowCreateForm, wallet, handleCreateWallet, walletUnavailable }) {
  return (
    <>
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
    </>
  );
}
