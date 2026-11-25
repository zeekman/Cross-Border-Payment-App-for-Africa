import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Copy, CheckCheck, ShieldAlert, Eye, EyeOff } from 'lucide-react';
import api from '../../utils/api';

export default function BackupWallet() {

  const [showBackup, setShowBackup] = useState(false);
  const [backupPassword, setBackupPassword] = useState('');
  const [exportedKey, setExportedKey] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);

  const handleExportKey = async (e) => {
    e.preventDefault();
    setBackupLoading(true);
    try {
      const res = await api.post('/wallet/export-key', { password: backupPassword });
      setExportedKey(res.data.secret_key);
      setBackupPassword('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Export failed');
    } finally {
      setBackupLoading(false);
    }
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(exportedKey);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 2000);
    } catch {
      toast.error('Failed to copy key');
    }
  };

  const closeBackup = () => {
    setShowBackup(false);
    setExportedKey(null);
    setBackupPassword('');
    setShowKey(false);
  };

  return (
    <>
      {/* Backup Wallet */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <ShieldAlert size={16} className="text-yellow-500" />
            <h3 className="font-semibold text-white">Backup Wallet</h3>
          </div>
          <button
            onClick={() => (showBackup ? closeBackup() : setShowBackup(true))}
            className="text-sm text-primary-500 hover:text-primary-400"
          >
            {showBackup ? 'Cancel' : 'Export Key'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Export your Stellar secret key to back up your wallet independently of AfriPay.
        </p>

        {showBackup && !exportedKey && (
          <form onSubmit={handleExportKey} className="space-y-3">
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3 text-xs text-yellow-400 space-y-1">
              <p className="font-semibold">⚠ Read before continuing</p>
              <p>
                Your secret key gives full control of your wallet. Never share it with anyone,
                including AfriPay support.
              </p>
              <p>Store it offline in a secure location. AfriPay cannot recover it if lost.</p>
            </div>
            <input
              type="password"
              required
              placeholder="Enter your account password to confirm"
              value={backupPassword}
              onChange={(e) => setBackupPassword(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-primary-500"
            />
            <button
              type="submit"
              disabled={backupLoading}
              className="w-full bg-yellow-500 hover:bg-yellow-600 disabled:opacity-50 text-black font-semibold py-2.5 rounded-xl text-sm transition-colors"
            >
              {backupLoading ? 'Verifying…' : 'Reveal Secret Key'}
            </button>
          </form>
        )}

        {exportedKey && (
          <div className="space-y-3">
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-xs text-red-400">
              <p className="font-semibold mb-1">🔑 Your secret key — shown once</p>
              <p>
                Copy it now and store it somewhere safe. This dialog will not show it again after
                you close it.
              </p>
            </div>
            <div className="relative bg-gray-800 rounded-xl px-4 py-3">
              <p className="font-mono text-sm text-white break-all pr-8">
                {showKey ? exportedKey : '•'.repeat(exportedKey.length)}
              </p>
              <button
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-3 top-3 text-gray-400 hover:text-white"
                aria-label={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <div className="flex gap-2">
              <button
                onClick={copyKey}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-white text-sm py-2.5 rounded-xl flex items-center justify-center gap-2 transition-colors"
              >
                {keyCopied ? (
                  <CheckCheck size={14} className="text-green-400" />
                ) : (
                  <Copy size={14} />
                )}
                {keyCopied ? 'Copied!' : 'Copy Key'}
              </button>
              <button
                onClick={closeBackup}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-400 text-sm py-2.5 rounded-xl transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
