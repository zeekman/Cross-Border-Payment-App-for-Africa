import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Paperclip } from 'lucide-react';
import api from '../utils/api';
import AttachmentInput from '../components/AttachmentInput';

export default function SupportTicket() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const [ticket, setTicket] = useState(null);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState('');
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);

  const load = useCallback(async (isActive = () => true) => {
    try {
      const { data } = await api.get(`/support/tickets/${id}`);
      if (!isActive()) return;
      setTicket(data.ticket);
      setMessages(data.messages || data.ticket.messages || []);
      setError(false);
    } catch {
      if (isActive()) setError(true);
    } finally {
      if (isActive()) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setTicket(null);
    load(() => active);
    return () => { active = false; };
  }, [load]);

  const openAttachment = async (attachment) => {
    // Open synchronously so popup blockers see the click; blob URL is set once fetched.
    const win = window.open('', '_blank');
    if (win) win.opener = null;
    try {
      const { data } = await api.get(
        `/support/tickets/${id}/attachments/${encodeURIComponent(attachment.filename)}`,
        { responseType: 'blob' },
      );
      const url = URL.createObjectURL(data);
      if (win) win.location.href = url;
      else window.location.assign(url);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      win?.close();
      toast.error(t('support.attachment_error'));
    }
  };

  const sendReply = async (e) => {
    e.preventDefault();
    setSending(true);
    try {
      const body = new FormData();
      body.append('body', reply);
      files.forEach((f) => body.append('attachments', f));
      await api.post(`/support/tickets/${id}/messages`, body);
      setReply('');
      setFiles([]);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || t('support.reply_error'));
    } finally {
      setSending(false);
    }
  };

  const renderAttachments = (attachments) => (attachments || []).map((a) => (
    <button
      key={a.id || a.filename}
      type="button"
      onClick={() => openAttachment(a)}
      className="flex items-center gap-1 text-xs text-primary-400 hover:underline"
    >
      <Paperclip size={12} aria-hidden="true" /> {a.original_name || a.filename}
    </button>
  ));

  if (loading) return <p role="status" className="p-6 text-center text-gray-400">{t('common.loading')}</p>;
  if (error || !ticket) {
    return (
      <div role="alert" className="p-6 text-center text-gray-400 space-y-3">
        <p>{t('support.load_error')}</p>
        <button type="button" onClick={() => { setLoading(true); load(); }} className="text-primary-500">{t('support.retry')}</button>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-6 space-y-4 text-start">
      <Link to="/profile" className="inline-flex items-center gap-1 text-sm text-gray-400">
        <ArrowLeft size={16} className="rtl:rotate-180" aria-hidden="true" /> {t('common.back')}
      </Link>
      <div className="bg-gray-900 rounded-2xl p-5 space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-white">{t(`support.types.${ticket.type}`, ticket.type)}</h2>
          <span className="text-xs px-2 py-0.5 rounded-full bg-primary-500/10 text-primary-400">
            {t(`support.statuses.${ticket.status}`, ticket.status)}
          </span>
        </div>
        <p className="text-xs text-gray-500">{new Date(ticket.created_at).toLocaleString(i18n.language)}</p>
        <p className="text-sm text-gray-300 whitespace-pre-wrap break-words">{ticket.description}</p>
        {ticket.transaction_id && (
          <Link
            to={`/history?tx=${encodeURIComponent(ticket.transaction?.tx_hash || ticket.tx_hash || ticket.transaction_id)}`}
            className="text-sm text-primary-400 hover:underline"
          >
            {t('support.view_transaction')}
          </Link>
        )}
        {renderAttachments(ticket.attachments)}
      </div>

      {messages.length === 0 ? (
        <p className="text-center text-sm text-gray-500">{t('support.no_messages')}</p>
      ) : (
        <ul className="space-y-2">
          {messages.map((m) => (
            <li key={m.id} className={`rounded-xl p-3 ${m.author_role === 'admin' ? 'bg-gray-800 me-8' : 'bg-primary-500/10 ms-8'}`}>
              <p className="text-xs text-gray-500">
                {m.author_role === 'admin' ? t('support.team') : t('support.you')} · {new Date(m.created_at).toLocaleString(i18n.language)}
              </p>
              <p className="text-sm text-gray-200 whitespace-pre-wrap break-words">{m.body}</p>
              {renderAttachments(m.attachments)}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={sendReply} className="bg-gray-900 rounded-2xl p-4 space-y-3">
        <textarea
          required
          maxLength={2000}
          rows={3}
          aria-label={t('support.reply_placeholder')}
          placeholder={t('support.reply_placeholder')}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          className="w-full bg-gray-800 rounded-lg px-3 py-2 text-white text-sm"
        />
        <AttachmentInput files={files} onChange={setFiles} />
        <button
          type="submit"
          disabled={sending || !reply.trim()}
          className="w-full bg-primary-500 disabled:opacity-50 text-white text-sm py-2 rounded-lg"
        >
          {sending ? t('support.submitting') : t('support.send_reply')}
        </button>
      </form>
    </div>
  );
}
