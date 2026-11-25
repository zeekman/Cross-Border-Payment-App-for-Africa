import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, Shield } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../utils/api';

export default function TwoFactorAuth() {
  const { user, updateUser } = useAuth();

  // 2FA state
  const [twoFAStep, setTwoFAStep] = useState(null); // null | 'setup' | 'verify' | 'disable'
  const [twoFAData, setTwoFAData] = useState(null); // { qrCode, backupCodes, secret }
  const [twoFACode, setTwoFACode] = useState('');
  const [twoFAPassword, setTwoFAPassword] = useState('');
  const [twoFALoading, setTwoFALoading] = useState(false);
  const [backupCodesAcknowledged, setBackupCodesAcknowledged] = useState(false);

  const handleSetup2FA = async () => {
    setTwoFALoading(true);
    try {
      const res = await api.post('/auth/2fa/setup');
      setTwoFAData(res.data);
      setTwoFAStep('setup');
      setBackupCodesAcknowledged(false);
    } catch (err) {
      toast.error(err.response?.data?.error || '2FA setup failed');
    } finally {
      setTwoFALoading(false);
    }
  };

  const handleVerify2FA = async (e) => {
    e.preventDefault();
    setTwoFALoading(true);
    try {
      await api.post('/auth/2fa/verify', { totp_code: twoFACode });
      toast.success('2FA enabled successfully');
      setTwoFAStep(null);
      setTwoFAData(null);
      setTwoFACode('');
      updateUser({ totp_enabled: true });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Invalid code');
    } finally {
      setTwoFALoading(false);
    }
  };

  const handleDisable2FA = async (e) => {
    e.preventDefault();
    setTwoFALoading(true);
    try {
      await api.post('/auth/2fa/disable', { password: twoFAPassword });
      toast.success('2FA disabled');
      setTwoFAStep(null);
      setTwoFAPassword('');
      updateUser({ totp_enabled: false });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to disable 2FA');
    } finally {
      setTwoFALoading(false);
    }
  };

  return (
    <>
      {/* Two-Factor Authentication */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-primary-400" />
            <h3 className="font-semibold text-white">Two-Factor Authentication</h3>
          </div>
          {twoFAStep === null &&
            (user?.totp_enabled ? (
              <button
                onClick={() => setTwoFAStep('disable')}
                className="text-sm text-red-400 hover:text-red-300"
              >
                Disable
              </button>
            ) : (
              <button
                onClick={handleSetup2FA}
                disabled={twoFALoading}
                className="text-sm text-primary-500 hover:text-primary-400 disabled:opacity-50"
              >
                {twoFALoading ? 'Loading…' : 'Enable'}
              </button>
            ))}
          {twoFAStep !== null && (
            <button
              onClick={() => {
                setTwoFAStep(null);
                setTwoFAData(null);
                setTwoFACode('');
                setTwoFAPassword('');
              }}
              className="text-sm text-gray-400 hover:text-white"
            >
              Cancel
            </button>
          )}
        </div>
        <p className="text-xs text-gray-500 mb-3">
          {user?.totp_enabled
            ? 'Your account is protected with an authenticator app.'
            : 'Add an extra layer of security to your account.'}
        </p>

        {/* Setup step: show QR + backup codes */}
        {twoFAStep === 'setup' && twoFAData && (
          <div className="space-y-4">
            <div className="bg-gray-800 rounded-xl p-4 flex flex-col items-center gap-3">
              <p className="text-sm text-gray-300 text-center">
                Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)
              </p>
              <div className="bg-white p-2 rounded-lg">
                <QRCodeSVG
                  value={twoFAData.otpauthUri || twoFAData.qrCode}
                  size={176}
                />
              </div>
              {twoFAData.secret && (
                <div className="w-full text-center">
                  <p className="text-xs text-gray-400 mb-1">Or enter this key manually:</p>
                  <p className="font-mono text-xs text-white bg-gray-900 px-3 py-2 rounded-lg break-all tracking-widest select-all">
                    {twoFAData.secret}
                  </p>
                </div>
              )}
            </div>

            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
              <p className="text-yellow-400 text-xs font-semibold mb-2">⚠ Save your backup codes</p>
              <p className="text-yellow-300/70 text-xs mb-3">
                If you lose access to your authenticator app, these codes are your only recovery
                method. Each code can only be used once.
              </p>
              <div className="grid grid-cols-2 gap-1.5 mb-3">
                {twoFAData.backupCodes.map((code, i) => (
                  <span
                    key={i}
                    className="font-mono text-xs bg-gray-900 text-white px-2.5 py-1.5 rounded-lg text-center tracking-widest"
                  >
                    {code}
                  </span>
                ))}
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(twoFAData.backupCodes.join('\n'));
                  toast.success('Backup codes copied');
                }}
                className="w-full flex items-center justify-center gap-2 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 py-2 rounded-lg transition-colors"
              >
                <Copy size={12} /> Copy all codes
              </button>
            </div>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={backupCodesAcknowledged}
                onChange={(e) => setBackupCodesAcknowledged(e.target.checked)}
                className="accent-primary-500 mt-0.5"
              />
              <span className="text-xs text-gray-300">
                I have saved my backup codes in a safe place
              </span>
            </label>

            <button
              disabled={!backupCodesAcknowledged}
              onClick={() => setTwoFAStep('verify')}
              className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-40 text-white text-sm font-semibold py-2.5 rounded-xl transition-colors"
            >
              Continue to Verify
            </button>
          </div>
        )}

        {/* Verify step: enter TOTP code to activate */}
        {twoFAStep === 'verify' && (
          <form onSubmit={handleVerify2FA} className="space-y-3">
            <p className="text-sm text-gray-300">
              Enter the 6-digit code from your authenticator app to activate 2FA.
            </p>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              required
              placeholder="000000"
              value={twoFACode}
              onChange={(e) => setTwoFACode(e.target.value.replace(/\D/g, ''))}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-center text-xl font-mono tracking-widest placeholder-gray-600 focus:outline-none focus:border-primary-500"
            />
            <button
              type="submit"
              disabled={twoFALoading || twoFACode.length !== 6}
              className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-40 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
            >
              {twoFALoading ? 'Verifying…' : 'Activate 2FA'}
            </button>
          </form>
        )}

        {/* Disable step */}
        {twoFAStep === 'disable' && (
          <form onSubmit={handleDisable2FA} className="space-y-3">
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-xs text-red-400">
              Disabling 2FA will remove the extra security layer from your account.
            </div>
            <input
              type="password"
              required
              placeholder="Enter your password to confirm"
              value={twoFAPassword}
              onChange={(e) => setTwoFAPassword(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-red-500"
            />
            <button
              type="submit"
              disabled={twoFALoading}
              className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
            >
              {twoFALoading ? 'Disabling…' : 'Disable 2FA'}
            </button>
          </form>
        )}
      </div>
    </>
  );
}
