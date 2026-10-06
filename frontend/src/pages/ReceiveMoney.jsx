import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, CheckCheck, Share2, Link, Download, Printer } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

function downloadSvg(svgEl, filename) {
  const svgData = new XMLSerializer().serializeToString(svgEl);
  const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadPng(svgEl, filename) {
  const svgData = new XMLSerializer().serializeToString(svgEl);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const img = new Image();
  const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  img.onload = () => {
    canvas.width = img.width * 2;
    canvas.height = img.height * 2;
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0);
    canvas.toBlob((pngBlob) => {
      const pngUrl = URL.createObjectURL(pngBlob);
      const a = document.createElement('a');
      a.href = pngUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(pngUrl);
    }, 'image/png');
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

export default function ReceiveMoney() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useTranslation();
  const qrRef = useRef(null);
  const cardRef = useRef(null);
  const [walletAddress, setWalletAddress] = useState(user?.wallet_address || '');
  const [federationAddress, setFederationAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [includeCard, setIncludeCard] = useState(false);

  useEffect(() => {
    if (!walletAddress) {
      api
        .get('/wallet/balance')
        .then((r) => setWalletAddress(r.data.public_key))
        .catch(() => {});
    }
  }, [walletAddress]);

  // FE-131: Only show a federation address when the backend explicitly provides one.
  // Client-side derivation from the email local-part is removed: it produced
  // fabricated addresses that weren't registered anywhere and leaked part of the
  // user's email to anyone the QR card was shared with.
  useEffect(() => {
    if (user?.federation_name) {
      setFederationAddress(user.federation_name);
    } else {
      setFederationAddress('');
    }
  }, [user]);

  const paymentUri = (() => {
    if (!walletAddress) return '';
    const params = new URLSearchParams({ destination: walletAddress });
    if (amount) params.set('amount', amount);
    if (memo) params.set('memo', memo);
    return `web+stellar:pay?${params.toString()}`;
  })();

  const copyAddress = async (addr) => {
    try {
      await navigator.clipboard.writeText(addr);
      toast.success(t('receive.address_copied'));
    } catch {
      toast.error('Failed to copy address');
    }
  };

  const copyUri = async () => {
    try {
      await navigator.clipboard.writeText(paymentUri);
      toast.success('Payment link copied');
    } catch {
      toast.error('Failed to copy payment link');
    }
  };

  const handleDownloadPng = useCallback(() => {
    const svg = qrRef.current?.querySelector('svg');
    if (!svg) return;
    downloadPng(svg, `afripay-qr-${user?.display_name || 'wallet'}.png`);
    toast.success('QR code downloaded as PNG');
  }, [user]);

  const handleDownloadSvg = useCallback(() => {
    const svg = qrRef.current?.querySelector('svg');
    if (!svg) return;
    downloadSvg(svg, `afripay-qr-${user?.display_name || 'wallet'}.svg`);
    toast.success('QR code downloaded as SVG');
  }, [user]);

  // FE-132: Replaced document.write (HTML injection risk) with safe DOM APIs.
  // User-controlled strings (name, address) are set via textContent so they are
  // always treated as plain text — no escaping needed, no script execution possible.
  const handlePrint = useCallback(() => {
    const printWindow = window.open('', '_blank', 'noopener,noreferrer');
    if (!printWindow) return;

    const name = user?.display_name || user?.full_name || 'AfriPay User';
    const displayAddress = federationAddress || walletAddress;

    const doc = printWindow.document;

    // Build the page structure entirely with DOM APIs.
    doc.title = 'Print QR Code - AfriPay';

    const style = doc.createElement('style');
    style.textContent = [
      'body{font-family:"Segoe UI",Arial,sans-serif;display:flex;justify-content:center;',
      'align-items:center;min-height:100vh;margin:0;background:#f5f5f5;}',
      '.card{background:white;border-radius:16px;padding:32px;text-align:center;',
      'box-shadow:0 4px 24px rgba(0,0,0,.1);max-width:400px;}',
      '.name{font-size:20px;font-weight:700;color:#1a1a2e;margin-bottom:4px;}',
      '.label{font-size:12px;color:#888;margin-bottom:16px;text-transform:uppercase;letter-spacing:1px;}',
      '.qr-wrap{background:white;padding:16px;border-radius:12px;border:2px solid #e0e0e0;',
      'display:inline-block;margin-bottom:16px;}',
      '.address{font-family:"Courier New",monospace;font-size:11px;color:#555;word-break:break-all;}',
      '.footer{font-size:10px;color:#aaa;margin-top:16px;}',
      '@media print{body{background:white;}.card{box-shadow:none;border:1px solid #ddd;}}',
    ].join('');
    doc.head.appendChild(style);

    const card = doc.createElement('div');
    card.className = 'card';

    const nameEl = doc.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = name; // textContent — no HTML parsing, safe against injection
    card.appendChild(nameEl);

    const labelEl = doc.createElement('div');
    labelEl.className = 'label';
    labelEl.textContent = 'Scan to pay';
    card.appendChild(labelEl);

    const qrWrap = doc.createElement('div');
    qrWrap.className = 'qr-wrap';

    // Clone the SVG node from the live DOM and import it into the print window's
    // document. importNode copies the SVG safely without any innerHTML assignment.
    const liveSvg = qrRef.current?.querySelector('svg');
    if (liveSvg) {
      const importedSvg = doc.importNode(liveSvg, true /* deep */);
      qrWrap.appendChild(importedSvg);
    }
    card.appendChild(qrWrap);

    const addrEl = doc.createElement('div');
    addrEl.className = 'address';
    addrEl.textContent = displayAddress; // textContent — safe against injection
    card.appendChild(addrEl);

    const footerEl = doc.createElement('div');
    footerEl.className = 'footer';
    footerEl.textContent = 'AfriPay — Cross-Border Payments';
    card.appendChild(footerEl);

    doc.body.appendChild(card);

    // Trigger print after a short tick to let the browser lay out the new document.
    printWindow.setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 250);
  }, [user, walletAddress, federationAddress]);

  return (
    <div className="px-4 py-6 max-w-lg mx-auto">
      <button
        onClick={() => navigate(-1)}
        className="text-gray-400 hover:text-white mb-6 flex items-center gap-1"
      >
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      <h2 className="text-2xl font-bold text-white mb-2">{t('receive.title')}</h2>
      <p className="text-gray-400 text-sm mb-8">{t('receive.subtitle')}</p>

      {/* Printable Card Layout */}
      {includeCard ? (
        <div ref={cardRef} className="bg-white rounded-2xl p-6 mb-6 text-center">
          {user?.display_name && (
            <p className="text-lg font-bold text-gray-900 mb-1">{user.display_name}</p>
          )}
          {federationAddress && (
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-4">Scan to pay</p>
          )}
          <div ref={qrRef} className="inline-block bg-white p-3 rounded-xl border-2 border-gray-200 mb-3">
            {walletAddress ? (
              <QRCodeSVG
                value={paymentUri || walletAddress}
                size={180}
                level="H"
                aria-label={`QR code for wallet address ${walletAddress}`}
                role="img"
              />
            ) : (
              <div className="w-44 h-44 flex items-center justify-center" role="status" aria-label="Loading">
                <div className="w-8 h-8 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
          </div>
          <p className="font-mono text-xs text-gray-600 break-all">{federationAddress || walletAddress}</p>
          <p className="text-xs text-gray-400 mt-4">AfriPay — Cross-Border Payments</p>
        </div>
      ) : (
        /* QR Code */
        <div ref={qrRef} className="bg-white rounded-2xl p-6 flex flex-col items-center justify-center mb-6 mx-auto w-fit">
          {walletAddress ? (
            <>
              <QRCodeSVG
                value={paymentUri || walletAddress}
                size={200}
                level="H"
                aria-label={`QR code for wallet address ${walletAddress}`}
                role="img"
              />
              <div className="mt-3">
                <label className="sr-only" htmlFor="receive-wallet-address">
                  Wallet address
                </label>
                <button
                  id="receive-wallet-address"
                  type="button"
                  onClick={() => copyAddress(walletAddress)}
                  className="font-mono text-xs text-gray-700 underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-primary-500 rounded"
                >
                  {walletAddress}
                </button>
              </div>
            </>
          ) : (
            <div
              className="w-48 h-48 flex items-center justify-center"
              role="status"
              aria-label="Loading"
            >
              <div className="w-8 h-8 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
      )}

      {/* Optional amount & memo */}
      <div className="space-y-2 mb-6">
        <input
          type="number"
          min="0"
          step="any"
          placeholder="Amount (optional)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-primary-500"
        />
        <input
          type="text"
          maxLength={64}
          placeholder="Memo (optional)"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 font-mono focus:outline-none focus:border-primary-500"
        />
      </div>

      {/* Address display */}
      <div className="space-y-3 mb-4">
        {federationAddress && (
          <div className="bg-primary-500/10 border border-primary-500/30 rounded-xl p-4">
            <p className="text-xs text-gray-400 mb-2">
              {t('receive.federation_label') || 'Federation Address'}
            </p>
            <p className="text-white font-mono text-sm break-all leading-relaxed">
              {federationAddress}
            </p>
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
          onClick={() =>
            navigator.share?.({
              title: 'My AfriPay Wallet',
              text: federationAddress || walletAddress,
            })
          }
          className="bg-primary-500 hover:bg-primary-600 rounded-xl py-3.5 flex items-center justify-center gap-2 text-white font-medium transition-colors"
        >
          <Share2 size={18} /> {t('common.share')}
        </button>
        <button
          onClick={copyUri}
          disabled={!walletAddress}
          className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-xl py-3.5 flex items-center justify-center gap-2 text-white font-medium transition-colors"
        >
          <Link size={18} /> Share link
        </button>
        <div className="relative group">
          <button
            disabled={!walletAddress}
            className="w-full bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-xl py-3.5 flex items-center justify-center gap-2 text-white font-medium transition-colors"
          >
            <Download size={18} /> Download
          </button>
          <div className="absolute bottom-full left-0 right-0 mb-1 hidden group-hover:block z-10">
            <div className="bg-gray-800 rounded-xl shadow-lg overflow-hidden">
              <button
                onClick={handleDownloadPng}
                className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors"
              >
                Download as PNG
              </button>
              <button
                onClick={handleDownloadSvg}
                className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors"
              >
                Download as SVG
              </button>
            </div>
          </div>
        </div>
        <button
          onClick={handlePrint}
          disabled={!walletAddress}
          className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-xl py-3.5 flex items-center justify-center gap-2 text-white font-medium transition-colors"
        >
          <Printer size={18} /> Print
        </button>
        <label className="col-span-2 flex items-center justify-center gap-2 text-xs text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={includeCard}
            onChange={(e) => setIncludeCard(e.target.checked)}
            className="accent-primary-500"
          />
          Include name and address in printable card layout
        </label>
      </div>

      <p className="text-center text-gray-600 text-xs mt-6">{t('receive.warning')}</p>
    </div>
  );
}
