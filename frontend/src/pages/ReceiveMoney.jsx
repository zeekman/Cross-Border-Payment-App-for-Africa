import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, CheckCheck, Share2, Link } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

export default function ReceiveMoney() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useTranslation();
  const [walletAddress, setWalletAddress] = useState(user?.wallet_address || '');
  const [federationAddress, setFederationAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');

  useEffect(() => {
    if (!walletAddress) {
      api.get('/wallet/balance').then(r => setWalletAddress(r.data.public_key)).catch(() => {});
    }
  }, [walletAddress]);

  useEffect(() => {
    if (user?.email && walletAddress) {
      const domain = process.env.REACT_APP_FEDERATION_DOMAIN || 'afripay.com';
      const username = user.email.split('@')[0];
      setFederationAddress(`${username}*${domain}`);
    }
  }, [user, walletAddress]);

  const paymentUri = (() => {
    if (!walletAddress) return '';
    const params = new URLSearchParams({ destination: walletAddress });
    if (amount) params.set('amount', amount);
    if (memo) params.set('memo', memo);
    return `web+stellar:pay?${params.toString()}`;
  })();

  const copyAddress = (addr) => {
    navigator.clipboard.writeText(addr);
    toast.success(t('receive.address_copied'));
  };

  const copyUri = () => {
    navigator.clipboard.writeText(paymentUri);
    toast.success('Payment link copied');
  };

  return (
    <div className="px-4 py-6 max-w-lg mx-auto">
      <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white mb-6 flex items-center gap-1">
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      <h2 className="text-2xl font-bold text-white mb-2">{t('receive.title')}</h2>
      <p className="text-gray-400 text-sm mb-8">{t('receive.subtitle')}</p>

      {/* QR Code */}
      <div className="bg-white rounded-2xl p-6 flex items-center justify-center mb-6 mx-auto w-fit">
        {walletAddress ? (
          <QRCodeSVG value={paymentUri || walletAddress} size={200} level="H" />
        ) : (
          <div className="w-48 h-48 flex items-center justify-center" role="status" aria-label="Loading">
            <div className="w-8 h-8 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Optional amount & memo */}
      <div className="space-y-2 mb-6">
        <input
          type="number"
          min="0"
          step="any"
          placeholder="Amount (optional)"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-primary-500"
        />
        <input
          type="text"
          maxLength={64}
          placeholder="Memo (optional)"
          value={memo}
          onChange={e => setMemo(e.target.value)}
          className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 font-mono focus:outline-none focus:border-primary-500"
        />
      </div>

      {/* Address display */}
      <div className="space-y-3 mb-4">
        {federationAddress && (
          <div className="bg-primary-500/10 border border-primary-500/30 rounded-xl p-4">
            <p className="text-xs text-gray-400 mb-2">{t('receive.federation_label') || 'Federation Address'}</p>
            <p className="text-white font-mono text-sm break-all leading-relaxed">{federationAddress}</p>
            <button
              onClick={() => copyAddress(federationAddress)}
              className="text-primary-400 hover:text-primary-300 text-xs mt-2 flex items-center gap-1"
            >
              <Copy size={14} /> {t('common.copy')}
            </button>
          </div>
        )}
        <div className="bg-gray-900 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-2">{t('receive.address_label')}</p>
          <p className="text-white font-mono text-sm break-all leading-relaxed">{walletAddress}</p>
          <button
            onClick={() => copyAddress(walletAddress)}
            className="text-gray-400 hover:text-gray-300 text-xs mt-2 flex items-center gap-1"
          >
            <Copy size={14} /> {t('common.copy')}
          </button>
        </div>
      </div>

      {/* Action buttons */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => copyAddress(walletAddress)}
          className="bg-gray-800 hover:bg-gray-700 rounded-xl py-3.5 flex items-center justify-center gap-2 text-white font-medium transition-colors"
        >
          <Copy size={18} /> {t('common.copy')}
        </button>
        <button
          onClick={() => navigator.share?.({ title: 'My AfriPay Wallet', text: federationAddress || walletAddress })}
          className="bg-primary-500 hover:bg-primary-600 rounded-xl py-3.5 flex items-center justify-center gap-2 text-white font-medium transition-colors"
        >
          <Share2 size={18} /> {t('common.share')}
        </button>
        <button
          onClick={copyUri}
          disabled={!walletAddress}
          className="col-span-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-xl py-3.5 flex items-center justify-center gap-2 text-white font-medium transition-colors"
        >
          <Link size={18} /> Share link
        </button>
      </div>

      <p className="text-center text-gray-600 text-xs mt-6">
        {t('receive.warning')}
      </p>
    </div>
  );
}
