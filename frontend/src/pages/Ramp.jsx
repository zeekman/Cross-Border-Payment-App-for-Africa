import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { localeCountry } from '../utils/currency';
import { safeAnchorUrl } from '../utils/anchorUrl';
import { useVisibleInterval } from '../hooks/useVisibleInterval';
import PINVerificationModal from '../components/PINVerificationModal';

const POLL_MS = 5000;
const FINAL = ['completed', 'refunded', 'expired', 'error', 'no_market', 'too_small', 'too_large'];
const STAGES = ['Started', 'In progress', 'Completed'];
const stageOf = (s) => (s === 'completed' ? 2 : s && s !== 'incomplete' && s !== 'pending' ? 1 : 0);
const label = (s) => (s || 'pending').replace(/_/g, ' ');

export default function Ramp() {
  const [params, setParams] = useSearchParams();
  const type = params.get('type') === 'withdraw' ? 'withdraw' : 'deposit';
  const { user } = useAuth();
  const country = user?.kyc_country || user?.country_code || localeCountry() || '';
  const [options, setOptions] = useState([]);
  const [choice, setChoice] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [tx, setTx] = useState(null);
  const [url, setUrl] = useState(null);
  const [history, setHistory] = useState([]);
  const [pinOpen, setPinOpen] = useState(false);
  const [paidId, setPaidId] = useState(null);

  useEffect(() => {
    api
      .get('/anchor/available', { params: { country } })
      .then(({ data }) =>
        setOptions(
          (data?.anchors || []).flatMap((a) =>
            (a.methods?.length ? a.methods : [{ id: '', name: 'Bank' }]).map((m) => ({
              key: `${a.id}:${m.id}`,
              anchor: a,
              method: m,
            }))
          )
        )
      )
      .catch(() => setOptions([]));
  }, [country]);

  const loadHistory = useCallback(() => {
    api
      .get('/anchor/transactions')
      .then(({ data }) => setHistory(data?.transactions || []))
      .catch(() => {});
  }, []);
  useEffect(loadHistory, [loadHistory, tx?.status]);

  const selected = options.find((o) => o.key === choice) || options[0];
  const asset = selected?.anchor.asset || 'USDC';
  const fee = selected?.anchor.info?.[type]?.[asset];

  const txId = tx?.id;
  const poll = useCallback(async () => {
    if (!txId) return;
    try {
      const { data } = await api.get(`/anchor/transactions/${encodeURIComponent(txId)}`);
      const next = data?.transaction || data;
      setTx((prev) => (prev?.id === txId ? { ...prev, ...next, id: txId } : prev));
    } catch {
      // Retried on the next tick.
    }
  }, [txId]);
  useVisibleInterval(poll, POLL_MS, { enabled: Boolean(txId) && !FINAL.includes(tx?.status) });

  const start = async (e) => {
    e.preventDefault();
    // Opened synchronously so popup blockers allow it. The opener is cleared before navigation.
    const win = window.open('', 'anchor', 'width=500,height=600');
    if (win) win.opener = null;
    setBusy(true);
    setUrl(null);
    try {
      const { data } = await api.post(`/anchor/${type}`, {
        asset,
        amount,
        ...(selected && { anchor_id: selected.anchor.id, method: selected.method.id || undefined }),
      });
      const safe = safeAnchorUrl(data?.url);
      if (!safe) throw new Error('Refusing to open an untrusted anchor URL');
      setTx({ id: data.id, type, status: 'incomplete' });
      setUrl(safe);
      if (win) win.location.href = safe;
    } catch (err) {
      if (win) win.close();
      toast.error(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  // The server pays the destination and memo it holds for this transaction.
  const pay = async (stepUpToken) => {
    setPinOpen(false);
    setPaidId(tx.id);
    try {
      await api.post(`/anchor/transactions/${encodeURIComponent(tx.id)}/pay`, {}, {
        headers: { 'X-Step-Up-Token': stepUpToken, 'Idempotency-Key': `anchor-${tx.id}` },
      });
      toast.success('Withdrawal payment sent');
      poll();
    } catch (err) {
      setPaidId(null);
      toast.error(err.response?.data?.error || 'Payment failed');
    }
  };

  const needsPayment =
    tx?.type === 'withdraw' && tx.status === 'pending_user_transfer_start' && paidId !== tx.id;

  return (
    <div className="px-4 py-6 max-w-lg mx-auto space-y-5 text-white">
      <div className="grid grid-cols-2 gap-2" role="tablist">
        {['deposit', 'withdraw'].map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={type === k}
            onClick={() => setParams({ type: k })}
            className={`py-2 rounded-xl capitalize ${type === k ? 'bg-primary-500' : 'bg-gray-800'}`}
          >
            {k}
          </button>
        ))}
      </div>

      <form onSubmit={start} className="space-y-3">
        {options.length > 0 && (
          <select
            aria-label="Anchor and method"
            value={selected.key}
            onChange={(e) => setChoice(e.target.value)}
            className="w-full bg-gray-800 rounded-xl px-4 py-3"
          >
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.anchor.name} — {o.method.name || o.method.id}
              </option>
            ))}
          </select>
        )}
        <input
          aria-label="Amount"
          type="number"
          required
          min="0.0000001"
          step="any"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={`Amount (${asset})`}
          className="w-full bg-gray-800 rounded-xl px-4 py-3"
        />
        {fee && (
          <p className="text-xs text-gray-400">
            Fee: {fee.fee_fixed ?? 0} {asset} + {fee.fee_percent ?? 0}%
          </p>
        )}
        <button type="submit" disabled={busy} className="w-full bg-primary-500 disabled:opacity-50 rounded-xl py-3">
          Continue
        </button>
      </form>

      {tx && (
        <section className="bg-gray-900 rounded-xl p-4 space-y-3" aria-live="polite">
          <ol className="flex justify-between text-xs">
            {STAGES.map((s, i) => (
              <li key={s} className={i <= stageOf(tx.status) ? 'text-primary-400' : 'text-gray-500'}>
                ● {s}
              </li>
            ))}
          </ol>
          <p className="text-sm">Status: {label(tx.status)}</p>
          {url && !FINAL.includes(tx.status) && (
            <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary-400 underline text-sm">
              Open anchor page
            </a>
          )}
          {needsPayment && (
            <div className="space-y-2 text-sm">
              <p>
                Send {tx.amount_in} {asset}
              </p>
              <p className="break-all">To: {tx.withdraw_anchor_account}</p>
              <p className="break-all">Memo: {tx.withdraw_memo || '—'}</p>
              <button
                type="button"
                disabled={!tx.withdraw_anchor_account || !tx.amount_in}
                onClick={() => setPinOpen(true)}
                className="w-full bg-primary-500 disabled:opacity-50 rounded-xl py-3"
              >
                Confirm and send
              </button>
            </div>
          )}
        </section>
      )}

      {history.length > 0 && (
        <section>
          <h3 className="font-semibold mb-2">History</h3>
          <ul className="space-y-2">
            {history.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => {
                    setUrl(null);
                    setTx({ ...h, type: h.type === 'deposit' ? 'deposit' : 'withdraw' });
                  }}
                  className="w-full flex justify-between bg-gray-900 rounded-xl px-4 py-2 text-sm"
                >
                  <span className="capitalize">{h.type} {h.asset}</span>
                  <span>{label(h.status)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PINVerificationModal
        isOpen={pinOpen}
        onClose={() => setPinOpen(false)}
        onSuccess={pay}
        amount={`${tx?.amount_in || ''} ${asset}`}
        recipient={tx?.withdraw_anchor_account}
      />
    </div>
  );
}
