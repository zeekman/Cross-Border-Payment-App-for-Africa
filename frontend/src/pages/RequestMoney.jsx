import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, CheckCheck, Share2, Send } from 'lucide-react';
import api from '../utils/api';
import { CURRENCIES } from '../utils/currency';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

export default function RequestMoney() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [form, setForm] = useState({
    amount: '',
    asset: 'XLM',
    memo: ''
  });
  const [paymentLink, setPaymentLink] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

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
      toast.success(t('request.created') || 'Payment request created');
    } catch (err) {
      toast.error(err.response?.data?.error || t('request.error') || 'Failed to create request');
    } finally {
      setLoading(false);
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(paymentLink);
    setCopied(true);
    toast.success(t('common.copied'));
    setTimeout(() => setCopied(false), 2000);
  };

  const shareLink = async () => {
    if (navigator.share) {
      await navigator.share({ title: 'Payment Request', text: paymentLink });
    } else {
      copyLink();
    }
  };

  return (
    <div className="px-4 py-6 max-w-lg mx-auto pb-20">
      <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white mb-6 flex items-center gap-1">
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      <h2 className="text-2xl font-bold text-white mb-6">{t('request.title') || 'Request Payment'}</h2>

      {!paymentLink ? (
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

          <div className="bg-gray-900 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-2">{t('request.link') || 'Payment Link'}</p>
            <p className="text-white font-mono text-xs break-all leading-relaxed">{paymentLink}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={copyLink}
              className="bg-gray-800 hover:bg-gray-700 rounded-xl py-3.5 flex items-center justify-center gap-2 text-white font-medium transition-colors"
            >
              {copied ? <CheckCheck size={18} className="text-primary-500" /> : <Copy size={18} />}
              {copied ? t('common.copied') : t('common.copy')}
            </button>
            <button
              onClick={shareLink}
              className="bg-primary-500 hover:bg-primary-600 rounded-xl py-3.5 flex items-center justify-center gap-2 text-white font-medium transition-colors"
            >
              <Share2 size={18} /> {t('common.share')}
            </button>
          </div>

          <button
            onClick={() => { setPaymentLink(''); setForm({ amount: '', asset: 'XLM', memo: '' }); }}
            className="w-full text-gray-400 hover:text-white text-sm py-2 transition-colors"
          >
            {t('request.create_another') || 'Create Another'}
          </button>
        </div>
      )}
    </div>
  );
}
