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
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';

function TransactionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [tx, setTx] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [receiptBusy, setReceiptBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(`/payments/${id}`)
      .then((res) => {
        if (!cancelled) setTx(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || 'Failed to load transaction');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const fetchReceipt = async (format) => {
    const res = await api.get(`/payments/${id}/receipt`, {
      params: { format },
      responseType: 'blob',
      headers: { 'Accept-Language': i18n.language },
    });
    return res.data;
  };

  const triggerDownload = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleDownload = async () => {
    setReceiptBusy(true);
    try {
      const blob = await fetchReceipt('pdf');
      triggerDownload(blob, `receipt-${id}.pdf`);
    } catch (err) {
      setError(err?.message || 'Failed to download receipt');
    } finally {
      setReceiptBusy(false);
    }
  };

  const handleShare = async () => {
    setReceiptBusy(true);
    try {
      const blob = await fetchReceipt('png');
      const file = new File([blob], `receipt-${id}.png`, { type: 'image/png' });
      if (
        typeof navigator !== 'undefined' &&
        navigator.canShare &&
        navigator.canShare({ files: [file] })
      ) {
        await navigator.share({ files: [file] });
      } else {
        triggerDownload(blob, `receipt-${id}.png`);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        setError(err?.message || 'Failed to share receipt');
      }
    } finally {
      setReceiptBusy(false);
    }
  };

  if (loading) {
    return <div className="transaction-detail">{t('common.loading')}</div>;
  }

  if (error && !tx) {
    return (
      <div className="transaction-detail">
        <p className="error">{error}</p>
        <button type="button" onClick={() => navigate(-1)}>
          {t('common.back')}
        </button>
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
  return (
    <div className="transaction-detail">
      <button type="button" className="back-link" onClick={() => navigate(-1)}>
        {t('common.back')}
      </button>
      <h1>{t('transaction.detailTitle')}</h1>
      {tx && (
        <dl className="transaction-detail__fields">
          <dt>{t('transaction.amount')}</dt>
          <dd>{tx.amount}</dd>
          <dt>{t('transaction.asset')}</dt>
          <dd>{tx.asset}</dd>
          <dt>{t('transaction.recipient')}</dt>
          <dd>{tx.recipient}</dd>
          <dt>{t('transaction.status')}</dt>
          <dd>{tx.status}</dd>
          <dt>{t('transaction.date')}</dt>
          <dd>{tx.createdAt}</dd>
        </dl>
      )}
      <div className="transaction-detail__receipt-actions">
        <button type="button" onClick={handleDownload} disabled={receiptBusy}>
          {t('transaction.downloadReceipt')}
        </button>
        <button type="button" onClick={handleShare} disabled={receiptBusy}>
          {t('transaction.shareReceipt')}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export default TransactionDetail;
