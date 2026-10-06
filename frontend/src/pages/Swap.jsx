import React, { useEffect, useState, useCallback, useRef } from 'react';
import { ArrowUpDown, AlertTriangle, CheckCircle2, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '../utils/api';
import toast from 'react-hot-toast';

const REFRESH_INTERVAL = 15; // seconds
const HIGH_IMPACT_PCT = 2;
const PRICE_CHANGE_TOAST_THRESHOLD = 0.005; // 0.5%

const SLIPPAGE_PRESETS = [0.1, 0.5, 1.0];
const DEFAULT_SLIPPAGE = 0.5;
const MAX_SLIPPAGE = 5;
const SLIPPAGE_STORAGE_KEY = 'afripay_slippage'; // shared with SendMoney
// Single app-wide slippage preference shared by Swap and Send Money.
const SLIPPAGE_STORAGE_KEY = 'afripay_slippage';

// Stellar amounts are fixed-point with 7 decimals. Keep them as strings
// end-to-end and use integer (stroop) arithmetic for derived values so we
// never round-trip through IEEE-754 floats.
const AMOUNT_REGEX = /^\d+(\.\d{1,7})?$/;
const AMOUNT_DECIMALS = 7;
const AMOUNT_SCALE = 10n ** BigInt(AMOUNT_DECIMALS);

function isValidAmount(value) {
  return typeof value === 'string' && AMOUNT_REGEX.test(value.trim());
}

// Parse a decimal string into a scaled BigInt (value * 10^7).
function toScaled(value) {
  const [whole, frac = ''] = String(value).trim().split('.');
  const paddedFrac = (frac + '0'.repeat(AMOUNT_DECIMALS)).slice(0, AMOUNT_DECIMALS);
  return BigInt(whole) * AMOUNT_SCALE + BigInt(paddedFrac || '0');
}

// Render a scaled BigInt back to a fixed 7-decimal string.
function fromScaled(scaled) {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / AMOUNT_SCALE;
  const frac = (abs % AMOUNT_SCALE).toString().padStart(AMOUNT_DECIMALS, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

// Multiply a decimal string by a rational factor (num/den) using integer math.
function mulDiv(value, num, den) {
  return fromScaled((toScaled(value) * BigInt(num)) / BigInt(den));
}

function normalizeSlippage(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SLIPPAGE;
  return Math.min(MAX_SLIPPAGE, Math.max(parsed, 0.01));
}

function getSavedSlippage() {
  const raw = Number.parseFloat(localStorage.getItem(SLIPPAGE_STORAGE_KEY));
  if (!Number.isFinite(raw)) return DEFAULT_SLIPPAGE;
  return normalizeSlippage(raw);
}

export default function Swap() {
  const { t } = useTranslation();
  const [sellAsset, setSellAsset] = useState('XLM');
  const [buyAsset, setBuyAsset] = useState('USDC');
  const [sellAmount, setSellAmount] = useState('');
  const [quote, setQuote] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState(null);
  const [slippage, setSlippage] = useState(getSavedSlippage);
  const [customSlippage, setCustomSlippage] = useState('');
  const [showSlippagePopover, setShowSlippagePopover] = useState(false);
  const slippagePopoverRef = useRef(null);

  const minReceived = quote?.estimatedReceived
    ? mulDiv(quote.estimatedReceived, Math.round((100 - slippage) * 100), 10000)
    : null;

  // Minimum the backend will actually enforce (server-returned destMin).
  const enforcedMin = result?.destMin ?? result?.dest_min ?? null;

  const applySlippage = (value) => {
    const nextValue = normalizeSlippage(value);
    setSlippage(nextValue);
    localStorage.setItem(SLIPPAGE_STORAGE_KEY, String(nextValue));
  };

  // Close slippage popover on outside click
  useEffect(() => {
    if (!showSlippagePopover) return;
    const handler = (e) => {
      if (slippagePopoverRef.current && !slippagePopoverRef.current.contains(e.target)) {
        setShowSlippagePopover(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSlippagePopover]);

  // Auto-refresh countdown (counts down from REFRESH_INTERVAL to 0)
  const [refreshCountdown, setRefreshCountdown] = useState(REFRESH_INTERVAL);
  const prevMidPriceRef = useRef(null);
  const countdownRef = useRef(null);
  const refreshIntervalRef = useRef(null);

  const flipPair = () => {
    setSellAsset(buyAsset);
    setBuyAsset(sellAsset);
    setSellAmount('');
    setQuote(null);
    setResult(null);
    prevMidPriceRef.current = null;
  };

  const fetchQuote = useCallback(async (isAutoRefresh = false) => {
    if (!isValidAmount(sellAmount) || toScaled(sellAmount) <= 0n) { setQuote(null); return; }
    setQuoteLoading(true);
    try {
      const bookRes = await api.get(`/dex/orderbook?selling=${sellAsset}&buying=${buyAsset}`);
      const { midPrice, asks } = bookRes.data;

      const bestAsk = asks[0] ? parseFloat(asks[0].price) : null;
      const estimatedReceived = bestAsk
        ? mulDiv(sellAmount, Math.round((1 / bestAsk) * 1e7), 1e7)
        : null;
      const bestAskVolume = asks[0] ? parseFloat(asks[0].amount) : Infinity;
      const priceImpactPct = bestAskVolume > 0
        ? Math.min(((parseFloat(sellAmount) / bestAskVolume) * 100), 100)
        : 0;

      setQuote({ midPrice, estimatedReceived, priceImpactPct });

      // Notify on significant price change during auto-refresh
      if (isAutoRefresh && prevMidPriceRef.current !== null && midPrice) {
        const change = Math.abs((midPrice - prevMidPriceRef.current) / prevMidPriceRef.current);
        if (change > PRICE_CHANGE_TOAST_THRESHOLD) {
          toast('Price updated', {
            icon: '🔄',
            style: { background: '#1e293b', color: '#e2e8f0' },
            duration: 2500,
          });
        }
      }
      if (midPrice) prevMidPriceRef.current = midPrice;
    } catch {
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  }, [sellAsset, buyAsset, sellAmount]);

  // Debounce on user input
  useEffect(() => {
    const t = setTimeout(() => fetchQuote(false), 500);
    return () => clearTimeout(t);
  }, [fetchQuote]);

  // Start/stop the 15s auto-refresh cycle; pause when confirm modal is open
  useEffect(() => {
    if (confirmOpen) {
      clearInterval(refreshIntervalRef.current);
      clearInterval(countdownRef.current);
      return;
    }

    setRefreshCountdown(REFRESH_INTERVAL);

    // Countdown ticker (1s)
    countdownRef.current = setInterval(() => {
      setRefreshCountdown(prev => (prev <= 1 ? REFRESH_INTERVAL : prev - 1));
    }, 1000);

    // Auto-refresh trigger
    refreshIntervalRef.current = setInterval(() => {
      fetchQuote(true);
      setRefreshCountdown(REFRESH_INTERVAL);
    }, REFRESH_INTERVAL * 1000);

    return () => {
      clearInterval(refreshIntervalRef.current);
      clearInterval(countdownRef.current);
    };
  }, [confirmOpen, fetchQuote]);

  const handleManualRefresh = () => {
    fetchQuote(false);
    setRefreshCountdown(REFRESH_INTERVAL);
    // Reset the auto-refresh interval so it restarts from now
    clearInterval(refreshIntervalRef.current);
    clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setRefreshCountdown(prev => (prev <= 1 ? REFRESH_INTERVAL : prev - 1));
    }, 1000);
    refreshIntervalRef.current = setInterval(() => {
      fetchQuote(true);
      setRefreshCountdown(REFRESH_INTERVAL);
    }, REFRESH_INTERVAL * 1000);
  };

  const handleSwap = async (e) => {
    e.preventDefault();
    if (!isValidAmount(sellAmount)) {
      toast.error('Enter a valid amount with up to 7 decimal places');
      return;
    }
    if (!confirmOpen) { setConfirmOpen(true); return; }
    setSubmitting(true);
    setResult(null);
    try {
      const res = await api.post('/dex/swap', {
        sell_asset: sellAsset,
        sell_amount: sellAmount.trim(),
        buy_asset: buyAsset,
        // Backend honours slippage_pct; min_received kept for BE-139 forward-compat.
        slippage_pct: slippage,
        min_received: minReceived ? parseFloat(minReceived) : undefined,
        min_received: minReceived || undefined,
      });
      setResult(res.data);
      setSellAmount('');
      setQuote(null);
      prevMidPriceRef.current = null;
      toast.success('Swap executed successfully');
    } catch (err) {
      const errCode = err.response?.data?.code;
      if (errCode === 'PRICE_MOVED' || errCode === 'SLIPPAGE_EXCEEDED') {
        toast.error('Price moved too much. Increase your slippage tolerance and try again.');
      } else {
        toast.error(err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || 'Swap failed');
      }
    } finally {
      setSubmitting(false);
      setConfirmOpen(false);
    }
  };

  const highImpact = quote && quote.priceImpactPct >= HIGH_IMPACT_PCT;
  const progressPct = ((REFRESH_INTERVAL - refreshCountdown) / REFRESH_INTERVAL) * 100;

  return (
    <div className="px-4 py-6 max-w-lg mx-auto space-y-5">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">{t('swap.title')}</h2>

      {/* Rate display with slippage settings */}
      <div className="bg-primary-500/10 border border-primary-500/20 rounded-xl px-4 py-2.5 flex items-center justify-between text-sm">
        <span className="text-gray-500 dark:text-gray-400">
          {quote?.midPrice
            ? `1 ${sellAsset} ≈ ${(1 / quote.midPrice).toFixed(6)} ${buyAsset}`
            : t('swap.dex_rate')}
        </span>
        <div className="relative" ref={slippagePopoverRef}>
          <button
            type="button"
            onClick={() => setShowSlippagePopover((v) => !v)}
            className="flex items-center gap-1 text-gray-500 dark:text-gray-400 hover:text-primary-500 transition-colors"
            aria-label="Slippage tolerance settings"
          >
            <Settings size={14} />
            <span className="font-medium">{slippage}%</span>
          </button>
          {showSlippagePopover && (
            <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg p-3 z-20 space-y-2">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Slippage tolerance</p>
              <div className="flex gap-2">
            <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg p-3 z-10">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Slippage tolerance</p>
              <div className="flex gap-2 mb-2">
                {SLIPPAGE_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => applySlippage(preset)}
                    className={`flex-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors ${
                      slippage === preset
                        ? 'bg-primary-500 text-white'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                    className={`flex-1 py-1 rounded-lg text-xs font-medium transition-colors ${
                      slippage === preset
                        ? 'bg-primary-500 text-white'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                    }`}
                  >
                    {preset}%
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0.01"
                  max={MAX_SLIPPAGE}
                  step="0.1"
                  value={customSlippage}
                  onChange={(e) => setCustomSlippage(e.target.value)}
                  placeholder="Custom"
                  className="flex-1 px-2 py-1 rounded-lg text-xs bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white border border-transparent focus:border-primary-500 outline-none"
                />
                <button
                  type="button"
                  onClick={() => { applySlippage(customSlippage); setCustomSlippage(''); }}
                  className="px-2 py-1 rounded-lg text-xs font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors"
                >
                  Set
                </button>
              </div>
              {slippage > HIGH_IMPACT_PCT && (
                <p className="text-xs text-amber-500 flex items-center gap-1">
                  <AlertTriangle size={12} /> High slippage tolerance
                </p>
              )}
              <input
                type="number"
                step="0.1"
                min="0.01"
                max={MAX_SLIPPAGE}
                value={customSlippage}
                onChange={(e) => setCustomSlippage(e.target.value)}
                onBlur={() => {
                  if (customSlippage) applySlippage(customSlippage);
                  setCustomSlippage('');
                }}
                placeholder="Custom %"
                className="w-full px-2 py-1 text-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-transparent text-gray-900 dark:text-white"
              />
            </div>
          )}
        </div>
      </div>

      <form onSubmit={handleSwap} className="space-y-4">
        {/* Sell */}
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
          <label className="text-xs text-gray-500 dark:text-gray-400">You pay</label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="number"
              min="0"
              step="any"
              value={sellAmount}
              onChange={(e) => setSellAmount(e.target.value)}
              placeholder="0.00"
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
          <label className="text-xs text-gray-500 dark:text-gray-400">You sell</label>
          <div className="flex gap-2">
            <input
              type="text"
              inputMode="decimal"
              value={sellAmount}
              onChange={(e) => setSellAmount(e.target.value)}
              placeholder="0.0000000"
              className="flex-1 bg-transparent text-2xl font-semibold text-gray-900 dark:text-white outline-none"
            />
            <select
              value={sellAsset}
              onChange={(e) => setSellAsset(e.target.value)}
              className="bg-gray-100 dark:bg-gray-700 rounded-lg px-2 py-1 text-sm text-gray-900 dark:text-white outline-none"
              className="px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-transparent text-sm text-gray-900 dark:text-white"
            >
              <option value="XLM">XLM</option>
              <option value="USDC">USDC</option>
            </select>
          </div>
          {sellAmount && !isValidAmount(sellAmount) && (
            <p className="text-xs text-red-500">Amount must have at most 7 decimal places</p>
          )}
        </div>

        <div className="flex justify-center">
          <button
            type="button"
            onClick={flipPair}
            className="p-2 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:text-primary-500 transition-colors"
            className="p-2 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            aria-label="Flip pair"
          >
            <ArrowUpDown size={16} />
          </button>
        </div>

        {/* Buy */}
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
          <label className="text-xs text-gray-500 dark:text-gray-400">You receive</label>
          <div className="flex items-center gap-2 mt-1">
            <span className="flex-1 text-2xl font-semibold text-gray-900 dark:text-white">
              {quoteLoading ? '…' : quote?.estimatedReceived || '0.00'}
            </span>
            <select
              value={buyAsset}
              onChange={(e) => setBuyAsset(e.target.value)}
              className="bg-gray-100 dark:bg-gray-700 rounded-lg px-2 py-1 text-sm text-gray-900 dark:text-white outline-none"
            >
              <option value="XLM">XLM</option>
              <option value="USDC">USDC</option>
            </select>
          </div>
        </div>

        {/* Quote details */}
        {quote && (
          <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-3 text-xs space-y-1.5">
            <div className="flex justify-between text-gray-500 dark:text-gray-400">
              <span>Minimum received</span>
              <span className="font-medium text-gray-900 dark:text-white">
                {minReceived ? `${minReceived} ${buyAsset}` : '—'}
              </span>
            </div>
            <div className="flex justify-between text-gray-500 dark:text-gray-400">
              <span>Price impact</span>
              <span className={`font-medium ${highImpact ? 'text-amber-500' : 'text-gray-900 dark:text-white'}`}>
                {quote.priceImpactPct.toFixed(2)}%
              </span>
            </div>
            <div className="flex justify-between text-gray-500 dark:text-gray-400">
              <span>Auto-refresh in</span>
              <span className="font-medium text-gray-900 dark:text-white">{refreshCountdown}s</span>
            </div>
            <div className="h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-primary-500 transition-all" style={{ width: `${progressPct}%` }} />
            </div>
            <button
              type="button"
              onClick={handleManualRefresh}
              className="text-primary-500 hover:underline"
            >
              Refresh quote
            </button>
          </div>
        )}

        {highImpact && (
          <div className="flex items-start gap-2 text-xs text-amber-500 bg-amber-500/10 rounded-xl p-3">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>High price impact. You may receive significantly less than quoted.</span>
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
          <label className="text-xs text-gray-500 dark:text-gray-400">You receive (estimated)</label>
          <div className="flex gap-2 items-center">
            <span className="flex-1 text-2xl font-semibold text-gray-900 dark:text-white">
              {quoteLoading ? '…' : quote?.estimatedReceived || '0.0000000'}
            </span>
            <span className="px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-600 text-sm text-gray-900 dark:text-white">
              {buyAsset}
            </span>
          </div>
          {minReceived && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Minimum received: {minReceived} {buyAsset}
            </p>
          )}
        </div>

        {highImpact && (
          <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>High price impact ({quote.priceImpactPct.toFixed(2)}%). You may receive significantly less than estimated.</span>
          </div>
        )}

        <button
          type="submit"
          disabled={!quote || submitting}
          className="w-full py-3 rounded-xl bg-primary-500 text-white font-semibold hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          disabled={submitting || !isValidAmount(sellAmount)}
          className="w-full py-3 rounded-xl bg-primary-500 text-white font-semibold disabled:opacity-50 transition-opacity"
        >
          {submitting ? 'Swapping…' : confirmOpen ? 'Confirm swap' : 'Review swap'}
        </button>
      </form>

      {/* Confirmation / result */}
      {result && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 text-sm space-y-1.5">
          <div className="flex items-center gap-2 text-green-600 dark:text-green-400 font-medium">
            <CheckCircle2 size={16} /> Swap executed
          </div>
          {enforcedMin != null && (
            <div className="flex justify-between text-gray-500 dark:text-gray-400">
              <span>Minimum enforced</span>
              <span className="font-medium text-gray-900 dark:text-white">
                {enforcedMin} {buyAsset}
              </span>
            </div>
          )}
      {result && (
        <div className="flex items-start gap-2 bg-green-500/10 border border-green-500/20 rounded-xl px-3 py-2 text-xs text-green-600 dark:text-green-400">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          <span>Swap submitted successfully.</span>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
        <span>Auto-refresh in {refreshCountdown}s</span>
        <button type="button" onClick={handleManualRefresh} className="hover:text-primary-500 transition-colors">
          Refresh now
        </button>
      </div>
      <div className="h-1 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
        <div className="h-full bg-primary-500 transition-all" style={{ width: `${progressPct}%` }} />
      </div>
    </div>
  );
}
