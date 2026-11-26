import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Flag, Send, UserPlus, Download, CheckCircle2, Circle, XCircle } from 'lucide-react';
import api from '../utils/api';
import { explorerTxUrl } from '../config/network';
import { truncateAddress } from '../utils/currency';
import { fiatValueForTx, fiatTooltip } from '../utils/fxSnapshot';
import { useCurrency } from '../context/CurrencyContext';

const TIMELINE = ['pending', 'confirming', 'completed'];

function StatusTimeline({ status }) {
  const failed = status === 'failed' || status === 'cancelled';
  const reached = failed ? 1 : Math.max(TIMELINE.indexOf(status), 0);
  const steps = failed ? ['pending', status] : TIMELINE;
  return (
    <ol className="flex items-center gap-2" aria-label="Status timeline">
      {steps.map((step, i) => {
        const done = i <= reached;
        const Icon = step === 'failed' || step === 'cancelled' ? XCircle : done ? CheckCircle2 : Circle;
        return (
          <li key={step} className={`flex items-center gap-1 text-xs capitalize ${done ? (failed && i === steps.length - 1 ? 'text-red-400' : 'text-primary-400') : 'text-gray-500'}`}>
            <Icon size={14} /> {step}
            {i < steps.length - 1 && <span className="mx-1 text-gray-600">→</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex justify-between gap-4 py-2 border-b border-gray-800 last:border-0">
      <span className="text-sm text-gray-400 shrink-0">{label}</span>
      <span className="text-sm text-white text-right break-all">{children}</span>
    </div>
  );
}

function downloadReceipt(tx, counterparty) {
  const lines = [
    'AfriPay transaction receipt',
    `ID: ${tx.id}`,
    `Date: ${new Date(tx.created_at).toISOString()}`,
    `Direction: ${tx.direction}`,
    `Amount: ${tx.amount} ${tx.asset}`,
    `${tx.direction === 'sent' ? 'Recipient' : 'Sender'}: ${counterparty}`,
    `Status: ${tx.status}`,
    tx.memo ? `Memo: ${tx.memo}` : null,
    tx.tx_hash ? `Stellar transaction: ${explorerTxUrl(tx.tx_hash)}` : null,
  ].filter(Boolean);
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `afripay_receipt_${tx.id}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * FE-205: /history/:id — a deep-linkable page for a single transaction, used by
 * notifications, receipts and support. Only transactions the user is party to
 * are returned by GET /payments/:id; anything else renders a not-found state.
 */
export default function TransactionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { displayCurrency } = useCurrency() || {};
  const [tx, setTx] = useState(null);
  const [state, setState] = useState('loading');
  const [contactName, setContactName] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    api.get(`/payments/${encodeURIComponent(id)}`)
      .then(({ data }) => {
        if (cancelled) return;
        setTx(data);
        setState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        const code = err.response?.status;
        setState(code === 404 || code === 400 || code === 403 ? 'notfound' : 'error');
      });
    return () => { cancelled = true; };
  }, [id]);

  const counterparty = tx ? (tx.direction === 'sent' ? tx.recipient_wallet : tx.sender_wallet) : null;

  useEffect(() => {
    if (!counterparty) return;
    api.get('/contacts')
      .then(({ data }) => {
        const list = data.contacts || data || [];
        const match = Array.isArray(list) && list.find((c) => c.wallet_address === counterparty);
        if (match) setContactName(match.name);
      })
      .catch(() => {});
  }, [counterparty]);

  if (state === 'loading') {
    return (
      <div className="flex justify-center py-16" role="status" aria-label="Loading transaction">
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (state !== 'ready') {
    return (
      <div className="px-4 py-16 max-w-lg mx-auto text-center space-y-4">
        <h2 className="text-xl font-bold text-white">{state === 'notfound' ? 'Transaction not found' : 'Could not load transaction'}</h2>
        <p className="text-sm text-gray-400">
          {state === 'notfound'
            ? "This transaction doesn't exist or you aren't a party to it."
            : 'Please check your connection and try again.'}
        </p>
        <button onClick={() => navigate('/history')} className="text-primary-400 hover:underline text-sm">Back to history</button>
      </div>
    );
  }

  const fiat = fiatValueForTx(tx, displayCurrency, null);
  const fees = tx.fee_breakdown || null;

  return (
    <div className="px-4 py-6 max-w-lg mx-auto space-y-5">
      <button onClick={() => navigate('/history')} className="flex items-center gap-1 text-gray-400 hover:text-white text-sm">
        <ArrowLeft size={16} /> History
      </button>

      <div className="bg-gray-900 rounded-2xl p-5 space-y-3">
        <p className="text-sm text-gray-400 capitalize">{tx.direction}</p>
        <p className={`text-3xl font-bold ${tx.direction === 'sent' ? 'text-red-400' : 'text-primary-400'}`}>
          {tx.direction === 'sent' ? '-' : '+'}{tx.amount} {tx.asset}
        </p>
        {fiat && (
          <p className="text-sm text-gray-400" title={fiatTooltip(fiat, displayCurrency)}>
            ≈ {fiat.formatted} at time of transfer
          </p>
        )}
        <StatusTimeline status={tx.status} />
      </div>

      <div className="bg-gray-900 rounded-2xl px-5 py-2">
        <Row label={tx.direction === 'sent' ? 'To' : 'From'}>
          {contactName ? `${contactName} (${truncateAddress(counterparty)})` : truncateAddress(counterparty)}
        </Row>
        {tx.memo && <Row label="Memo">{tx.memo}</Row>}
        <Row label="Created">{new Date(tx.created_at).toLocaleString()}</Row>
        {tx.ledger_close_time && <Row label="Confirmed">{new Date(tx.ledger_close_time).toLocaleString()}</Row>}
        {fees && Object.entries(fees).map(([k, v]) => (
          <Row key={k} label={`Fee: ${k.replace(/_/g, ' ')}`}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</Row>
        ))}
        {tx.tx_hash && (
          <Row label="Transaction">
            <a href={explorerTxUrl(tx.tx_hash)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary-400 hover:underline">
              {truncateAddress(tx.tx_hash)} <ExternalLink size={12} />
            </a>
          </Row>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => downloadReceipt(tx, counterparty)} className="flex items-center justify-center gap-2 bg-gray-800 rounded-xl py-2.5 text-sm text-white">
          <Download size={14} /> Download receipt
        </button>
        <button onClick={() => navigate(`/history?tx=${encodeURIComponent(tx.tx_hash || tx.id)}&report=1`)} className="flex items-center justify-center gap-2 bg-gray-800 rounded-xl py-2.5 text-sm text-white">
          <Flag size={14} /> Report a problem
        </button>
        {tx.direction === 'sent' && (
          <button onClick={() => navigate(`/send?to=${encodeURIComponent(counterparty)}&amount=${encodeURIComponent(tx.amount)}&asset=${encodeURIComponent(tx.asset)}`)} className="flex items-center justify-center gap-2 bg-gray-800 rounded-xl py-2.5 text-sm text-white">
            <Send size={14} /> Send again
          </button>
        )}
        {!contactName && (
          <button onClick={() => navigate(`/send?to=${encodeURIComponent(counterparty)}&save_contact=1`)} className="flex items-center justify-center gap-2 bg-gray-800 rounded-xl py-2.5 text-sm text-white">
            <UserPlus size={14} /> Add to contacts
          </button>
        )}
      </div>
    </div>
  );
}
