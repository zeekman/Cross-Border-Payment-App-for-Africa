import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Send, ChevronDown, Users, Camera, Code } from 'lucide-react';
import api from '../utils/api';
import { CURRENCIES, convertFromXLM } from '../utils/currency';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import QRScanner from '../components/QRScanner';
import PINVerificationModal from '../components/PINVerificationModal';
import XDRInspectorModal from '../components/XDRInspectorModal';

export default function SendMoney() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [form, setForm] = useState({ recipient_address: '', amount: '', asset: 'XLM', memo: '' });
  const [contacts, setContacts] = useState([]);
  const [showContacts, setShowContacts] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [showPINVerification, setShowPINVerification] = useState(false);
  const [showXDRInspector, setShowXDRInspector] = useState(false);
  const [transactionXDR, setTransactionXDR] = useState(null);
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    api.get('/wallet/contacts').then(r => setContacts(r.data.contacts || [])).catch(() => {});
  }, []);

  const estimatedValue = form.amount && form.asset === 'XLM'
    ? `≈ $${convertFromXLM(form.amount, 'USD')} USD`
    : '';

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!confirmed) { setConfirmed(true); return; }
    // Show PIN verification modal instead of directly submitting
    setShowPINVerification(true);
  };

  const handlePINVerified = async () => {
    setLoading(true);
    try {
      await api.post('/payments/send', {
        recipient_address: form.recipient_address,
        amount: parseFloat(form.amount),
        asset: form.asset,
        memo: form.memo || undefined
      });
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

        {/* Amount + Asset */}
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
                {CURRENCIES.map(c => (
                  <option key={c.code} value={c.code}>{c.flag} {c.code}</option>
                ))}
              </select>
              <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            </div>
          </div>
          {estimatedValue && <p className="text-xs text-gray-500 mt-1">{estimatedValue}</p>}
        </div>

        {/* Memo */}
        <div>
          <label className="text-sm text-gray-400 mb-1 block">{t('send.memo')}</label>
          <input
            type="text"
            maxLength={28}
            placeholder={t('send.memo_placeholder')}
            value={form.memo}
            onChange={e => setForm({ ...form, memo: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
          />
        </div>

        {/* Confirmation preview */}
        {confirmed && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 space-y-2">
            <p className="text-yellow-400 font-semibold text-sm">{t('send.confirm_title')}</p>
            <div className="text-sm text-gray-300 space-y-1">
              <p>{t('send.confirm_to')} <span className="font-mono text-xs">{form.recipient_address.slice(0, 20)}...</span></p>
              <p>{t('send.confirm_amount')} <span className="text-white font-semibold">{form.amount} {form.asset}</span></p>
              {form.memo && <p>{t('send.confirm_memo')} {form.memo}</p>}
            </div>
            <button
              type="button"
              onClick={() => setShowXDRInspector(true)}
              className="w-full mt-2 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm flex items-center justify-center gap-2 transition-colors"
            >
              <Code size={16} /> View Raw Transaction (XDR)
            </button>
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
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

      {/* QR Scanner Modal */}
      <QRScanner
        isOpen={showScanner}
        onClose={() => setShowScanner(false)}
        onScan={(address) => setForm({ ...form, recipient_address: address })}
      />

      {/* PIN Verification Modal */}
      <PINVerificationModal
        isOpen={showPINVerification}
        onClose={() => setShowPINVerification(false)}
        onSuccess={handlePINVerified}
        amount={`${form.amount} ${form.asset}`}
        recipient={form.recipient_address}
      />

      {/* XDR Inspector Modal */}
      <XDRInspectorModal
        isOpen={showXDRInspector}
        onClose={() => setShowXDRInspector(false)}
        xdr={transactionXDR}
      />
    </div>
  );
}
