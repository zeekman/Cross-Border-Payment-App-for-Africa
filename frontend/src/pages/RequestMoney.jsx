import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, CheckCheck, Share2, Send, ExternalLink, Info } from 'lucide-react';
import api from '../utils/api';
import { CURRENCIES } from '../utils/currency';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

const PAGE_SIZE = 10;
const STATUS_STYLES = {
  pending: 'text-yellow-400',
  paid: 'text-green-400',
  expired: 'text-gray-500',
  cancelled: 'text-red-400',
};

function MyRequests() {
  const { t } = useTranslation();
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/payment-requests', {
        params: { page, limit: PAGE_SIZE, status: status || undefined },
      });
      setItems(data.requests);
      setTotal(data.total);
    } catch {
      toast.error(t('request.error') || 'Failed to load requests');
    } finally {
      setLoading(false);
    }
  }, [page, status, t]);

  useEffect(() => { load(); }, [load]);

  const reshare = async (id) => {
    const link = `${window.location.origin}/send?request=${id}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Payment Request', text: link });
      else {
        await navigator.clipboard.writeText(link);
        toast.success(t('common.copied'));
      }
    } catch {
      // share cancelled
    }
  };

  const cancelRequest = async (id) => {
    try {
      await api.delete(`/payment-requests/${id}`);
      toast.success('Request cancelled');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to cancel request');
    }
  };

  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  return (
    <div className="space-y-3">
      <select
        aria-label="Filter by status"
        value={status}
        onChange={(e) => { setStatus(e.target.value); setPage(1); }}
        className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-white text-sm"
      >
        <option value="">All</option>
        {Object.keys(STATUS_STYLES).map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      {loading && <p className="text-gray-400 text-sm">Loading…</p>}
      {!loading && items.length === 0 && <p className="text-gray-400 text-sm">No requests yet.</p>}
      {items.map((r) => (
        <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-white font-semibold">{parseFloat(r.amount)} {r.asset}</span>
            <span className={`text-xs uppercase font-semibold ${STATUS_STYLES[r.status]}`}>{r.status}</span>
          </div>
          <p className="text-xs text-gray-500">
            Created {new Date(r.created_at).toLocaleDateString()} · Expires {new Date(r.expires_at).toLocaleDateString()}
          </p>
          {r.claimed_tx_hash && (
            <a
              href={`https://stellar.expert/explorer/public/tx/${r.claimed_tx_hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary-400 font-mono break-all"
            >
              {r.claimed_tx_hash}
            </a>
          )}
          {r.status === 'pending' && (
            <div className="flex gap-2">
              <button onClick={() => reshare(r.id)} className="flex-1 bg-gray-800 hover:bg-gray-700 rounded-lg py-2 text-sm text-white">
                {t('common.share')}
              </button>
              <button onClick={() => cancelRequest(r.id)} className="flex-1 bg-gray-800 hover:bg-gray-700 rounded-lg py-2 text-sm text-red-400">
                {t('common.cancel')}
              </button>
            </div>
          )}
        </div>
      ))}
      <div className="flex justify-between items-center text-sm text-gray-400">
        <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="disabled:opacity-40">Previous</button>
        <span>{page} / {pages}</span>
        <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="disabled:opacity-40">Next</button>
      </div>
    </div>
  );
}

export default function RequestMoney() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [form, setForm] = useState({
    amount: '',
    asset: 'XLM',
    memo: ''
  });
  const [tab, setTab] = useState('new');
  const [paymentLink, setPaymentLink] = useState('');
  const [requestDetails, setRequestDetails] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedDeep, setCopiedDeep] = useState(false);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.amount || parseFloat(form.amount) <= 0) {
      toast.error(t('request.invalid_amount') || 'Invalid amount');
      return;
    }

    setLoading(true);
    try {
      const res = await api.post('/payment-requests', {
        amount: parseFloat(form.amount),
        asset: form.asset,
        memo: form.memo || undefined
      });
      setPaymentLink(res.data.paymentLink);
      setRequestDetails({ id: res.data.id, amount: res.data.amount, asset: res.data.asset });
      toast.success(t('request.created') || 'Payment request created');
    } catch (err) {
      toast.error(err.response?.data?.error || t('request.error') || 'Failed to create request');
    } finally {
      setLoading(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(paymentLink);
      setCopied(true);
      toast.success(t('common.copied'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy link');
    }
  };

  const copyDeepLink = async () => {
    try {
      await navigator.clipboard.writeText(paymentLink);
      setCopiedDeep(true);
      toast.success('Deep link copied');
      setTimeout(() => setCopiedDeep(false), 2000);
    } catch {
      toast.error('Failed to copy deep link');
    }
  };

  const shareLink = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Payment Request', text: paymentLink });
      } catch {
        // user cancelled or share failed — fall back to copy
      }
    } else {
      copyLink();
    }
  };

  const testDeepLink = () => {
    window.open(paymentLink, '_blank');
  };

  return (
    <div className="px-4 py-6 max-w-lg mx-auto pb-20">
      <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white mb-6 flex items-center gap-1">
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      <h2 className="text-2xl font-bold text-white mb-6">{t('request.title') || 'Request Payment'}</h2>

      <div className="flex gap-2 mb-6" role="tablist">
        {[['new', t('request.title') || 'New request'], ['mine', 'My requests']].map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`flex-1 py-2 rounded-xl text-sm font-medium ${tab === key ? 'bg-primary-500 text-white' : 'bg-gray-800 text-gray-400'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'mine' && <MyRequests />}

      {tab === 'new' && (!paymentLink ? (
        <form onSubmit={handleCreate} className="space-y-4">
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
                className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500"
              />
              <select
                value={form.asset}
                onChange={e => setForm({ ...form, asset: e.target.value })}
                className="appearance-none bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500"
              >
                {CURRENCIES.map(c => (
                  <option key={c.code} value={c.code}>{c.flag} {c.code}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="text-sm text-gray-400 mb-1 block">{t('send.memo')}</label>
            <input
              type="text"
              maxLength={28}
              placeholder={t('send.memo_placeholder')}
              value={form.memo}
              onChange={e => setForm({ ...form, memo: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 font-mono text-sm"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary-500 hover:bg-primary-600 text-white font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" role="status" aria-label="Loading" />
            ) : (
              <><Send size={18} /> {t('request.create') || 'Create Request'}</>
            )}
          </button>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4">
            <p className="text-green-400 font-semibold text-sm">{t('request.success') || 'Payment request created!'}</p>
          </div>

          <div className="bg-gray-900 rounded-xl p-4 border border-primary-500/30">
            <div className="flex items-center gap-2 mb-2">
              <ExternalLink size={14} className="text-primary-400" />
              <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider">Deep Link</p>
            </div>
            <p className="text-white font-mono text-xs break-all leading-relaxed">{paymentLink}</p>
          </div>

          <div className="bg-gray-800/50 rounded-xl p-3 flex items-start gap-2">
            <Info size={14} className="text-gray-500 shrink-0 mt-0.5" />
            <p className="text-xs text-gray-400">
              Recipients with an AfriPay account will be taken directly to the send form with the amount and your address pre-filled. New users will be guided to register first, then redirected to complete the payment.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <button
              onClick={copyDeepLink}
              className="bg-gray-800 hover:bg-gray-700 rounded-xl py-3.5 flex items-center justify-center gap-2 text-white font-medium transition-colors"
            >
              {copiedDeep ? <CheckCheck size={18} className="text-primary-500" /> : <Copy size={18} />}
              {copiedDeep ? t('common.copied') : 'Copy Link'}
            </button>
            <button
              onClick={shareLink}
              className="bg-primary-500 hover:bg-primary-600 rounded-xl py-3.5 flex items-center justify-center gap-2 text-white font-medium transition-colors"
            >
              <Share2 size={18} /> {t('common.share')}
            </button>
            <button
              onClick={testDeepLink}
              className="bg-gray-800 hover:bg-gray-700 rounded-xl py-3.5 flex items-center justify-center gap-2 text-white font-medium transition-colors"
            >
              <ExternalLink size={18} /> Preview
            </button>
          </div>

          <button
            onClick={() => { setPaymentLink(''); setRequestDetails(null); setForm({ amount: '', asset: 'XLM', memo: '' }); }}
            className="w-full text-gray-400 hover:text-white text-sm py-2 transition-colors"
          >
            {t('request.create_another') || 'Create Another'}
          </button>
        </div>
      ))}
    </div>
  );
}
