import React, { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, AlertCircle } from 'lucide-react';
import api from '../../utils/api';
import { apiErrorMessage } from '../../utils/apiError';
import { truncateAddress } from '../../utils/currency';
import AttachmentInput from '../AttachmentInput';

const TYPES = ['wrong_address', 'wrong_amount', 'failed_deducted', 'other'];
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const inputClass = 'w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-primary-500';

export default function SupportTickets() {
  const { t, i18n } = useTranslation();
  const [searchParams] = useSearchParams();
  const prefillOpen = searchParams.get('support') === 'new';
  const prefillTx = prefillOpen ? searchParams.get('tx') || '' : '';
  const prefillType = prefillOpen && TYPES.includes(searchParams.get('type')) ? searchParams.get('type') : '';

  const [showForm, setShowForm] = useState(prefillOpen);
  const [form, setForm] = useState({ type: prefillType, description: '', transaction_id: prefillTx });
  const [files, setFiles] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [tickets, setTickets] = useState([]);
  const [ticketsLoading, setTicketsLoading] = useState(true);
  const sectionRef = useRef(null);

  const loadTickets = useCallback(async () => {
    try {
      const res = await api.get('/support/tickets');
      setTickets(res.data.tickets || []);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } catch {
      // non-critical, silently ignore
    } finally {
      setTicketsLoading(false);
    }
  }, []);

  useEffect(() => { loadTickets(); }, [loadTickets]);

  useEffect(() => {
    if (!prefillOpen) return;
    setShowForm(true);
    setForm((f) => ({ ...f, type: prefillType, transaction_id: prefillTx }));
    sectionRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [prefillOpen, prefillTx, prefillType]);

  useEffect(() => {
    if (!showForm) return undefined;
    let active = true;
    const from = new Date(Date.now() - THIRTY_DAYS_MS).toISOString().split('T')[0];
    (async () => {
      const all = [];
      let cursor = null;
      try {
        do {
          const { data } = await api.get('/payments/history', { params: { from, limit: 100, ...(cursor ? { cursor } : {}) } });
          all.push(...(data.transactions || []));
          cursor = data.has_more ? data.next_cursor : null;
        } while (cursor && active);
      } catch {
        // the picker is optional; keep whatever loaded
      }
      if (active) setTransactions(all);
    })();
    return () => { active = false; };
  }, [showForm]);

  const txLabel = (tx) => [
    `${tx.amount} ${tx.asset}`,
    truncateAddress(tx.recipient_wallet || ''),
    new Date(tx.created_at).toLocaleDateString(i18n.language),
  ].join(' · ');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const body = new FormData();
      body.append('type', form.type);
      body.append('description', form.description);
      if (form.transaction_id) body.append('transaction_id', form.transaction_id);
      files.forEach((f) => body.append('attachments', f));
      await api.post('/support/tickets', body);
      toast.success(t('support.created'));
      setShowForm(false);
      setForm({ type: '', description: '', transaction_id: '' });
      setFiles([]);
      await loadTickets();
    } catch (err) {
      toast.error(err.response?.data?.error || t('support.create_error'));
    } finally {
      setSubmitting(false);
    }
  };

  const prefillMissing = form.transaction_id && !transactions.some((tx) => String(tx.id) === form.transaction_id);

  return (
    <div ref={sectionRef} className="bg-gray-900 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <AlertCircle size={16} className="text-primary-400" />
          <h3 className="font-semibold text-white">{t('support.title')}</h3>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="text-primary-500 hover:text-primary-400 flex items-center gap-1 text-sm"
        >
          <Plus size={16} /> {t('support.new')}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="mb-4 space-y-3 bg-gray-800 rounded-xl p-4">
          <select
            required
            aria-label={t('support.select_type')}
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
            className={inputClass}
          >
            <option value="">{t('support.select_type')}</option>
            {TYPES.map((type) => <option key={type} value={type}>{t(`support.types.${type}`)}</option>)}
          </select>
          <select
            aria-label={t('support.transaction')}
            value={form.transaction_id}
            onChange={(e) => setForm({ ...form, transaction_id: e.target.value })}
            className={inputClass}
          >
            <option value="">{t('support.no_transaction')}</option>
            {prefillMissing && <option value={form.transaction_id}>{t('support.selected_transaction')}</option>}
            {transactions.map((tx) => <option key={tx.id} value={String(tx.id)}>{txLabel(tx)}</option>)}
          </select>
          <textarea
            required
            aria-label={t('support.describe')}
            placeholder={t('support.describe')}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={3}
            maxLength={2000}
            className={`${inputClass} resize-none`}
          />
          <AttachmentInput files={files} onChange={setFiles} />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="flex-1 bg-gray-600 hover:bg-gray-500 text-white text-sm py-2 rounded-lg transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm py-2 rounded-lg transition-colors"
            >
              {submitting ? t('support.submitting') : t('support.submit')}
            </button>
          </div>
        </form>
      )}

      {ticketsLoading ? (
        <p className="text-gray-500 text-sm text-center py-4">{t('common.loading')}</p>
      ) : tickets.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-4">{t('support.none')}</p>
      ) : (
        <div className="space-y-2">
          {tickets.map((ticket) => (
            <Link key={ticket.id} to={`/support/${ticket.id}`} className="block bg-gray-800 rounded-xl px-3 py-2.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-white">
                  {t(`support.types.${ticket.type}`, ticket.type)}
                  {ticket.unread_count > 0 && (
                    <span className="ms-2 px-1.5 rounded-full bg-red-500" aria-label={t('support.unread', { count: ticket.unread_count })}>
                      {ticket.unread_count}
                    </span>
                  )}
                </span>
                <span className="text-xs text-gray-500">
                  {new Date(ticket.created_at).toLocaleDateString(i18n.language)}
                </span>
              </div>
              <p className="text-xs text-gray-400 line-clamp-2">{ticket.description}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
