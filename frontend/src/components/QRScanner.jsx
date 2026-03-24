import React, { useState } from 'react';
import { QrReader } from 'react-qr-reader';
import { X, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

export default function QRScanner({ isOpen, onClose, onScan }) {
  const { t } = useTranslation();
  const [error, setError] = useState(null);

  const handleScan = (result) => {
    if (result?.text) {
      // Validate it looks like a Stellar address (starts with 'G' and is 56 chars)
      const address = result.text.trim();
      if (address.startsWith('G') && address.length === 56) {
        toast.success(t('send.qr_scanned'));
        onScan(address);
        onClose();
      } else {
        setError(t('send.qr_invalid'));
        toast.error(t('send.qr_invalid'));
      }
    }
  };

  const handleError = (err) => {
    console.error('QR Scanner error:', err);
    if (err.name === 'NotAllowedError') {
      setError(t('send.camera_permission_denied'));
      toast.error(t('send.camera_permission_denied'));
    } else if (err.name === 'NotFoundError') {
      setError(t('send.camera_not_found'));
      toast.error(t('send.camera_not_found'));
    } else {
      setError(t('send.camera_error'));
      toast.error(t('send.camera_error'));
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-2xl w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between bg-gray-800 px-4 py-4">
          <h3 className="text-lg font-semibold text-white">{t('send.scan_qr')}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X size={24} />
          </button>
        </div>

        {/* Scanner or Error */}
        <div className="aspect-square bg-black relative overflow-hidden">
          {error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 p-4">
              <AlertCircle size={48} className="text-red-500 mb-4" />
              <p className="text-red-400 text-center text-sm">{error}</p>
              <button
                onClick={() => setError(null)}
                className="mt-4 text-primary-500 hover:text-primary-400 text-sm font-medium"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : (
            <QrReader
              onResult={handleScan}
              onError={handleError}
              constraints={{ facingMode: 'environment' }}
              videoStyle={{ width: '100%', height: '100%' }}
              scanDelay={300}
            />
          )}
        </div>

        {/* Footer */}
        <div className="bg-gray-800 px-4 py-4">
          <p className="text-gray-400 text-xs text-center">{t('send.qr_hint')}</p>
        </div>
      </div>
    </div>
  );
}
