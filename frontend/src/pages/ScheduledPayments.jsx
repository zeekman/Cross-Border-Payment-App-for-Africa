import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Edit2 } from 'lucide-react';
import api from '../utils/api';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { CURRENCIES } from '../utils/currency';

export default function ScheduledPayments() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    recipient_wallet: '',
    amount: '',
    asset: 'XLM',
    frequency: 'monthly',
    memo: ''
  });

  useEffect(() => {
    fetchPayments();
  }, []);

  const fetchPayments = async () => {
    try {
      const res = await api.get('/scheduled-payments');
      setPayments(res.data.payments || []);
    } catch (err) {
      toast.error(t('scheduled.error') || 'Failed to load scheduled payments');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.recipient_wallet || !form.amount) {
      toast.error(t('scheduled.invalid') || 'Invalid input');
      return;
    }

    try {
      await api.post('/scheduled-payments', {
        recipient_wallet: form.recipient_wallet,
        amount: parseFloat(form.amount),
        asset: form.asset,
        frequency: form.frequency,
        memo: form.memo || undefined
      });
      toast.success(t('scheduled.created') || 'Scheduled payment created');
      setForm({ recipient_wallet: '', amount: '', asset: 'XLM', frequency: 'monthly', memo: '' });
      setShowForm(false);
      fetchPayments();
    } catch (err) {
      toast.error(err.response?.data?.error || t('scheduled.error'));
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm(t('scheduled.confirm_delete') || 'Delete this scheduled payment?')) return;
    try {
      await api.delete(`/scheduled-payments/${id}`);
      toast.success(t('scheduled.deleted') || 'Deleted');
      fetchPayments();
    } catch (err) {
      toast.error(t('scheduled.error'));
    }
  };

  const handleToggle = async (id, active) => {
    try {
      await api.put(`/scheduled-payments/${id}`, { active: !active });
      fetchPayments();
    } catch (err) {
      toast.error(t('scheduled.error'));
    }
  };

  if (loading) {
    return (
      <div className="px-4 py-6 max-w-lg mx-auto flex items-center justify-center min-h-screen" role="status" aria-label="Loading">
        <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="px-4 py-6 max-w-lg mx-auto pb-20">
      <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white mb-6 flex items-center gap-1">
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-white">{t('scheduled.title') || 'Scheduled Payments'}</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="bg-primary-500 hover:bg-primary-600 text-white p-2 rounded-lg transition-colors"
        >
          <Plus size={18} />
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-gray-900 rounded-xl p-4 mb-6 space-y-3">
          <input
            type="text"
            placeholder="Recipient wallet"
            value={form.recipient_wallet}
            onChange={e => setForm({ ...form, recipient_wallet: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-500 text-sm"
          />
          <div className="flex gap-2">
            <input
              type="number"
              placeholder="Amount"
              min="0.0000001"
              step="any"
              value={form.amount}
              onChange={e => setForm({ ...form, amount: e.target.value })}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-500 text-sm"
            />
            <select
              value={form.asset}
              onChange={e => setForm({ ...form, asset: e.target.value })}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm"
            >
              {CURRENCIES.map(c => (
                <option key={c.code} value={c.code}>{c.code}</option>
              ))}
            </select>
          </div>
          <select
            value={form.frequency}
            onChange={e => setForm({ ...form, frequency: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm"
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
          <input
            type="text"
            placeholder="Memo (optional)"
            maxLength={28}
            value={form.memo}
            onChange={e => setForm({ ...form, memo: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-500 text-sm"
          />
          <div className="flex gap-2">
            <button type="submit" className="flex-1 bg-primary-500 hover:bg-primary-600 text-white py-2 rounded-lg text-sm font-medium">
              Create
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-white py-2 rounded-lg text-sm">
              Cancel
            </button>
          </div>
        </form>
      )}

      {payments.length === 0 ? (
        <p className="text-gray-400 text-center py-8">{t('scheduled.none') || 'No scheduled payments'}</p>
      ) : (
        <div className="space-y-3">
          {payments.map(p => (
            <div key={p.id} className="bg-gray-900 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <p className="text-white font-semibold">{p.amount} {p.asset}</p>
                  <p className="text-gray-400 text-xs font-mono">{p.recipient_wallet.slice(0, 16)}...</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleToggle(p.id, p.active)}
                    className={`px-3 py-1 rounded text-xs font-medium ${
                      p.active ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-400'
                    }`}
                  >
                    {p.active ? 'Active' : 'Inactive'}
                  </button>
                  <button onClick={() => handleDelete(p.id)} className="text-red-400 hover:text-red-300">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              <p className="text-gray-500 text-xs">{p.frequency} • Next: {new Date(p.next_run_at).toLocaleDateString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
