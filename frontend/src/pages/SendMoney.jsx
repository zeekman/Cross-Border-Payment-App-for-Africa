import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Send, ChevronDown, Users, Camera, ArrowRightLeft } from 'lucide-react';
import api from '../utils/api';
import { useExchangeRates } from '../hooks/useExchangeRates';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import QRScanner from '../components/QRScanner';
import PINVerificationModal from '../components/PINVerificationModal';

const SLIPPAGE_OPTIONS = [0.5, 1, 2];
const DEFAULT_SLIPPAGE = 1;

export default function SendMoney() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [form, setForm] = useState({
    recipient_address: '',
    amount: '',
    asset: 'XLM',
    memo: '',
    destination_asset: '',
    slippage: DEFAULT_SLIPPAGE,
    memo_type: 'text'
  });
  const [contacts, setContacts] = useState([]);
  const [showContacts, setShowContacts] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [showPINVerification, setShowPINVerification] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const { currencies, convertFromXLM, usingApproximateRates } = useExchangeRates();
  const [pathResult, setPathResult] = useState(null);
  const [pathLoading, setPathLoading] = useState(false);

  const isCrossAsset = form.destination_asset && form.destination_asset !== form.asset;

  useEffect(() => {
    api.get('/wallet/contacts').then(r => setContacts(r.data.contacts || [])).catch(() => {});
  }, []);

  // Debounced path finding
  const findPath = useCallback(async () => {
    if (!isCrossAsset || !form.amount || !form.recipient_address) {
      setPathResult(null);
      return;
    }
    setPathLoading(true);
    try {
      const res = await api.post('/payments/find-path', {
        source_asset: form.asset,
        source_amount: parseFloat(form.amount),
        destination_asset: form.destination_asset,
        recipient_address: form.recipient_address,
      });
      setPathResult(res.data);
    } catch {
      setPathResult(null);
    } finally {
      setPathLoading(false);
    }
  }, [form.amount, form.asset, form.destination_asset, form.recipient_address, isCrossAsset]);

  useEffect(() => {
    const timer = setTimeout(findPath, 600);
    return () => clearTimeout(timer);
  }, [findPath]);

  const estimatedValue = form.amount && form.asset === 'XLM'
    ? `≈ ${convertFromXLM(form.amount, 'USD')} USD`
    : '';

  // Minimum destination amount after slippage
  const destMin = pathResult
    ? (parseFloat(pathResult.destinationAmount) * (1 - form.slippage / 100)).toFixed(7)
    : null;
  const memoTrimmed = form.memo.trim();
  const memoMaxLen =
    form.memo_type === 'id' ? 20 : form.memo_type === 'text' ? 28 : 64;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!confirmed) { setConfirmed(true); return; }
    setShowPINVerification(true);
  };

  const handlePINVerified = async () => {
    setLoading(true);
    try {
      if (isCrossAsset && pathResult) {
        await api.post('/payments/send-path', {
          recipient_address: form.recipient_address,
          source_asset: form.asset,
          source_amount: parseFloat(form.amount),
          destination_asset: form.destination_asset,
          destination_min_amount: parseFloat(destMin),
          path: pathResult.path,
          memo: form.memo || undefined,
        });
      } else {
        await api.post('/payments/send', {
          recipient_address: form.recipient_address,
          amount: parseFloat(form.amount),
          asset: form.asset,
          memo: form.memo || undefined,
        });
      }
      const m = form.memo.trim();
      const payload = {
        recipient_address: form.recipient_address,
        amount: parseFloat(form.amount),
        asset: form.asset
      };
      if (m) {
        payload.memo = m;
        payload.memo_type = form.memo_type;
      }
      await api.post('/payments/send', payload);
      toast.success(t('send.success'));
      navigate('/dashboard');
    } catch (err) {
      toast.error(err.response?.data?.error || t('send.error'));
      setConfirmed(false);
      setShowPINVerification(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="px-4 py-6 max-w-lg mx-auto">
      <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white mb-6 flex items-center gap-1">
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      <h2 className="text-2xl font-bold text-white mb-6">{t('send.title')}</h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Recipient */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm text-gray-400">{t('send.recipient_label')}</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowScanner(true)}
                className="text-primary-500 hover:text-primary-400 p-1.5 rounded-lg hover:bg-primary-500/10 transition-colors"
                title={t('send.scan_qr')}
              >
                <Camera size={16} />
              </button>
              {contacts.length > 0 && (
                <button type="button" onClick={() => setShowContacts(!showContacts)}
                  className="text-primary-500 text-xs flex items-center gap-1">
                  <Users size={12} /> {t('send.contacts')}
                </button>
              )}
            </div>
          </div>
          <input
            type="text"
            required
            placeholder={t('send.recipient_placeholder')}
            value={form.recipient_address}
            onChange={e => setForm({ ...form, recipient_address: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors font-mono text-sm"
          />
          {showContacts && contacts.length > 0 && (
            <div className="mt-1 bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
              {contacts.map(c => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => { setForm({ ...form, recipient_address: c.wallet_address }); setShowContacts(false); }}
                  className="w-full px-4 py-2.5 text-left hover:bg-gray-700 transition-colors"
                >
                  <p className="text-sm text-white">{c.name}</p>
                  <p className="text-xs text-gray-500 font-mono">{c.wallet_address.slice(0, 20)}...</p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Amount + Source Asset */}
        <div>
          <label className="text-sm text-gray-400 mb-1 block">{t('send.amount')}</label>
          <div className="flex gap-2">
            <input
              type="number"
              required
              min="0.0000001"
              step="any"
              placeholder="0.00"
              value={form.amount}
              onChange={e => setForm({ ...form, amount: e.target.value })}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
            />
            <div className="relative">
              <select
                value={form.asset}
                onChange={e => setForm({ ...form, asset: e.target.value })}
                className="appearance-none bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500 pr-8 transition-colors"
              >
                {currencies.map(c => (
                  <option key={c.code} value={c.code}>{c.flag} {c.code}</option>
                ))}
              </select>
              <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            </div>
          </div>
          {estimatedValue && (
            <div className="mt-1 space-y-1">
              <p className="text-xs text-gray-500">{estimatedValue}</p>
              {usingApproximateRates && (
                <p className="text-xs text-amber-500/90">{t('common.rates_disclaimer')}</p>
              )}
            </div>
          )}
        </div>

        {/* Destination Asset (cross-asset toggle) */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm text-gray-400 flex items-center gap-1">
              <ArrowRightLeft size={13} /> Recipient receives (optional)
            </label>
            {form.destination_asset && (
              <button type="button" onClick={() => { setForm({ ...form, destination_asset: '' }); setPathResult(null); }}
                className="text-xs text-gray-500 hover:text-white transition-colors">
                Clear
              </button>
            )}
          </div>
          <div className="relative">
            <select
              value={form.destination_asset}
              onChange={e => setForm({ ...form, destination_asset: e.target.value })}
              className="appearance-none w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500 pr-8 transition-colors"
            >
              <option value="">Same as sent ({form.asset})</option>
              {CURRENCIES.filter(c => c.code !== form.asset).map(c => (
                <option key={c.code} value={c.code}>{c.flag} {c.code}</option>
              ))}
            </select>
            <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          </div>

          {/* Path result / loading */}
          {isCrossAsset && (
            <div className="mt-2 px-3 py-2 bg-gray-800 border border-gray-700 rounded-xl text-sm">
              {pathLoading && <p className="text-gray-400 animate-pulse">Finding best rate...</p>}
              {!pathLoading && pathResult && (
                <div className="space-y-1">
                  <p className="text-green-400">
                    Recipient receives ≈ <span className="font-semibold">{pathResult.destinationAmount} {form.destination_asset}</span>
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-gray-500">Slippage tolerance:</span>
                    {SLIPPAGE_OPTIONS.map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setForm({ ...form, slippage: s })}
                        className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                          form.slippage === s
                            ? 'border-primary-500 text-primary-400'
                            : 'border-gray-600 text-gray-400 hover:border-gray-400'
                        }`}
                      >
                        {s}%
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500">Min received: {destMin} {form.destination_asset}</p>
                </div>
              )}
              {!pathLoading && !pathResult && form.amount && form.recipient_address && (
                <p className="text-yellow-500 text-xs">No conversion path found for these assets</p>
              )}
            </div>
          )}
        </div>

        {/* Memo */}
        <div>
          <label className="text-sm text-gray-400 mb-1 block">{t('send.memo')}</label>
          <input
            type="text"
            maxLength={memoMaxLen}
            placeholder={t('send.memo_placeholder')}
            value={form.memo}
            onChange={e => setForm({ ...form, memo: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors font-mono text-sm"
          />
          {memoTrimmed ? (
            <div className="mt-2">
              <label className="text-sm text-gray-400 mb-1 block" htmlFor="memo-type">
                {t('send.memo_type_label')}
              </label>
              <select
                id="memo-type"
                value={form.memo_type}
                onChange={e => setForm({ ...form, memo_type: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500 transition-colors"
              >
                <option value="text">{t('send.memo_type_text')}</option>
                <option value="id">{t('send.memo_type_id')}</option>
                <option value="hash">{t('send.memo_type_hash')}</option>
                <option value="return">{t('send.memo_type_return')}</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">{t(`send.memo_hint_${form.memo_type}`)}</p>
            </div>
          ) : null}
        </div>

        {/* Confirmation preview */}
        {confirmed && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 space-y-2">
            <p className="text-yellow-400 font-semibold text-sm">{t('send.confirm_title')}</p>
            <div className="text-sm text-gray-300 space-y-1">
              <p>{t('send.confirm_to')} <span className="font-mono text-xs">{form.recipient_address.slice(0, 20)}...</span></p>
              <p>{t('send.confirm_amount')} <span className="text-white font-semibold">{form.amount} {form.asset}</span></p>
              {isCrossAsset && pathResult && (
                <p>Recipient receives ≈ <span className="text-white font-semibold">{pathResult.destinationAmount} {form.destination_asset}</span> (min {destMin})</p>
              )}
              {form.memo && <p>{t('send.confirm_memo')} {form.memo}</p>}
              {form.memo.trim() ? (
                <>
                  <p>{t('send.confirm_memo')} {form.memo.trim()}</p>
                  <p className="text-gray-400 text-xs">
                    {t('send.confirm_memo_type')} {t(`send.memo_type_${form.memo_type}`)}
                  </p>
                </>
              ) : null}
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={loading || (isCrossAsset && !pathResult)}
          className={`w-full font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-colors ${
            confirmed
              ? 'bg-yellow-500 hover:bg-yellow-600 text-black'
              : 'bg-primary-500 hover:bg-primary-600 text-white'
          } disabled:opacity-50`}
        >
          {loading ? (
            <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
          ) : (
            <><Send size={18} /> {confirmed ? t('send.confirm_send') : t('send.review')}</>
          )}
        </button>

        {confirmed && (
          <button type="button" onClick={() => setConfirmed(false)}
            className="w-full text-gray-400 hover:text-white text-sm py-2 transition-colors">
            {t('common.cancel')}
          </button>
        )}
      </form>

      <QRScanner
        isOpen={showScanner}
        onClose={() => setShowScanner(false)}
        onScan={(address) => setForm({ ...form, recipient_address: address })}
      />

      <PINVerificationModal
        isOpen={showPINVerification}
        onClose={() => setShowPINVerification(false)}
        onSuccess={handlePINVerified}
        amount={`${form.amount} ${form.asset}`}
        recipient={form.recipient_address}
      />
    </div>
  );
}
