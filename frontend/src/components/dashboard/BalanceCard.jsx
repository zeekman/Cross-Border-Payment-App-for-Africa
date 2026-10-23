import { Copy, CheckCheck, WifiOff, Eye, EyeOff } from 'lucide-react';
import { BalanceCardSkeleton } from '../../components/Skeleton';
import { truncateAddress } from '../../utils/currency';
import { useCountUp } from '../../hooks/useCountUp';

function BalanceDisplay({ balance }) {
  const numericBalance = Number.isFinite(balance) ? balance : 0;
  const animated = useCountUp(numericBalance);

  return (
    <span className="text-4xl font-bold text-white">
      {animated.toLocaleString()}
    </span>
  );
}

export default function BalanceCard({ t, wallet, loading, copied, selectedCurrency, setSelectedCurrency, balanceIncreased, fromCache, showZeroBalances, setShowZeroBalances, currencies, usingApproximateRates, copyAddress, xlmAvailable, allBalances, visibleBalances, displayBalance, walletUnavailable }) {
  return (
    <>
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
    </>
  );
}
