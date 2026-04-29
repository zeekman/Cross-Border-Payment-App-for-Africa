import React, { useEffect, useState, useCallback } from 'react';
import { ArrowUpDown, AlertTriangle, CheckCircle2 } from 'lucide-react';
import api from '../utils/api';
import toast from 'react-hot-toast';

const PAIRS = [
  { sell: 'XLM', buy: 'USDC' },
  { sell: 'USDC', buy: 'XLM' },
];

// Price impact is considered high above this threshold (%)
const HIGH_IMPACT_PCT = 2;

export default function Swap() {
  const [sellAsset, setSellAsset] = useState('XLM');
  const [buyAsset, setBuyAsset] = useState('USDC');
  const [sellAmount, setSellAmount] = useState('');
  const [quote, setQuote] = useState(null); // { midPrice, estimatedReceived, priceImpactPct }
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  const flipPair = () => {
    setSellAsset(buyAsset);
    setBuyAsset(sellAsset);
    setSellAmount('');
    setQuote(null);
    setResult(null);
  };

  const fetchQuote = useCallback(async () => {
    if (!sellAmount || parseFloat(sellAmount) <= 0) { setQuote(null); return; }
    setQuoteLoading(true);
    try {
      const [bookRes, pathRes] = await Promise.all([
        api.get(`/dex/orderbook?selling=${sellAsset}&buying=${buyAsset}`),
        api.get(`/dex/orderbook?selling=${buyAsset}&buying=${sellAsset}`), // reverse for impact calc
      ]);
      const { midPrice, asks } = bookRes.data;

      // Estimate received using best ask price
      const bestAsk = asks[0] ? parseFloat(asks[0].price) : null;
      const estimatedReceived = bestAsk ? (parseFloat(sellAmount) / bestAsk).toFixed(7) : null;

      // Rough price impact: compare sell amount to total ask liquidity at best price
      const bestAskVolume = asks[0] ? parseFloat(asks[0].amount) : Infinity;
      const priceImpactPct = bestAskVolume > 0
        ? Math.min(((parseFloat(sellAmount) / bestAskVolume) * 100), 100)
        : 0;

      setQuote({ midPrice, estimatedReceived, priceImpactPct });
    } catch {
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  }, [sellAsset, buyAsset, sellAmount]);

  // Debounce quote fetch
  useEffect(() => {
    const t = setTimeout(fetchQuote, 500);
    return () => clearTimeout(t);
  }, [fetchQuote]);

  const handleSwap = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const res = await api.post('/dex/swap', {
        sell_asset: sellAsset,
        sell_amount: parseFloat(sellAmount),
        buy_asset: buyAsset,
      });
      setResult(res.data);
      setSellAmount('');
      setQuote(null);
      toast.success('Swap executed successfully');
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || 'Swap failed');
    } finally {
      setSubmitting(false);
    }
  };

  const highImpact = quote && quote.priceImpactPct >= HIGH_IMPACT_PCT;

  return (
    <div className="px-4 py-6 max-w-lg mx-auto space-y-5">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Swap</h2>

      {/* Rate display */}
      {quote?.midPrice && (
        <div className="bg-primary-500/10 border border-primary-500/20 rounded-xl px-4 py-2.5 flex items-center justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">DEX rate</span>
          <span className="font-semibold text-gray-900 dark:text-white">
            1 {sellAsset} ≈ {(1 / quote.midPrice).toFixed(6)} {buyAsset}
          </span>
        </div>
      )}

      <form onSubmit={handleSwap} className="space-y-3">
        {/* Sell */}
        <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-2xl p-4 space-y-2">
          <label className="text-xs text-gray-500 uppercase tracking-wide">You sell</label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min="0"
              step="any"
              required
              placeholder="0.00"
              value={sellAmount}
              onChange={e => { setSellAmount(e.target.value); setResult(null); }}
              className="flex-1 bg-transparent text-2xl font-bold text-gray-900 dark:text-white outline-none placeholder-gray-300 dark:placeholder-gray-700"
            />
            <span className="text-lg font-semibold text-gray-700 dark:text-gray-300 shrink-0">{sellAsset}</span>
          </div>
        </div>

        {/* Flip button */}
        <div className="flex justify-center">
          <button
            type="button"
            onClick={flipPair}
            className="w-9 h-9 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full flex items-center justify-center text-gray-500 hover:text-primary-500 transition-colors shadow-sm"
            aria-label="Flip pair"
          >
            <ArrowUpDown size={16} />
          </button>
        </div>

        {/* Buy */}
        <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-2xl p-4 space-y-2">
          <label className="text-xs text-gray-500 uppercase tracking-wide">You receive (est.)</label>
          <div className="flex items-center gap-3">
            <span className="flex-1 text-2xl font-bold text-gray-400 dark:text-gray-600">
              {quoteLoading ? '…' : quote?.estimatedReceived ?? '0.00'}
            </span>
            <span className="text-lg font-semibold text-gray-700 dark:text-gray-300 shrink-0">{buyAsset}</span>
          </div>
        </div>

        {/* Price impact warning */}
        {highImpact && (
          <div className="flex items-start gap-2 bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 text-sm text-yellow-500">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>
              High price impact ({quote.priceImpactPct.toFixed(1)}%). Your order is large relative to
              available liquidity — you may receive significantly less than the quoted amount.
            </span>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !sellAmount || parseFloat(sellAmount) <= 0}
          className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-3.5 rounded-2xl transition-colors"
        >
          {submitting ? 'Swapping…' : `Swap ${sellAsset} → ${buyAsset}`}
        </button>
      </form>

      {/* Success result */}
      {result && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-2xl p-4 space-y-1">
          <div className="flex items-center gap-2 text-green-400 font-semibold text-sm mb-2">
            <CheckCircle2 size={16} /> Swap complete
          </div>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            Sold <span className="font-semibold">{result.soldAmount} {result.soldAsset}</span>
          </p>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            Est. received <span className="font-semibold">{result.estimatedReceived} {result.buyAsset}</span>
          </p>
          <a
            href={`https://stellar.expert/explorer/testnet/tx/${result.transactionHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary-400 hover:underline break-all"
          >
            {result.transactionHash}
          </a>
        </div>
      )}
    </div>
  );
}
