import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, CheckCheck, Share2 } from 'lucide-react';
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

  const copyAddress = (addr) => {
    navigator.clipboard.writeText(addr);
    toast.success(t('receive.address_copied'));
  };

  const shareAddress = async () => {
    if (navigator.share) {
      await navigator.share({ title: 'My AfriPay Wallet', text: walletAddress });
    } else {
      copyAddress();
    }
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
          <QRCodeSVG value={walletAddress} size={200} level="H" />
        ) : (
          <div className="w-48 h-48 flex items-center justify-center" role="status" aria-label="Loading">
            <div className="w-8 h-8 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
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
      </div>

      <p className="text-center text-gray-600 text-xs mt-6">
        {t('receive.warning')}
      </p>
    </div>
  );
}
