import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield } from 'lucide-react';
import api from '../../utils/api';

export default function KycStatusCard() {
  const navigate = useNavigate();

  // KYC status
  const [kycStatus, setKycStatus] = useState(null); // null | 'unverified' | 'pending' | 'verified' | 'rejected'
  const [kycLoading, setKycLoading] = useState(true);
  const [kycRejectionReason, setKycRejectionReason] = useState('');

  React.useEffect(() => {
    setKycLoading(true);
    api
      .get('/kyc/status')
      .then((r) => {
        const status = r.data?.kyc_status || r.data?.status || 'unverified';
        setKycStatus(status);
        setKycRejectionReason(r.data?.rejection_reason || r.data?.reason || '');
      })
      .catch(() => {
        setKycStatus('unverified');
        setKycRejectionReason('');
      })
      .finally(() => setKycLoading(false));
  }, []);

  return (
    <>
      {/* KYC Status */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-primary-400" />
            <h3 className="font-semibold text-white">KYC Verification</h3>
          </div>
        </div>

        {kycLoading ? (
          <p className="text-gray-500 text-sm mt-2">Loading…</p>
        ) : (
          <>
            {kycStatus === 'unverified' && (
              <div className="mt-3 bg-gray-800 border border-gray-700 rounded-xl p-4">
                <p className="text-gray-300 font-semibold">Unverified</p>
                <p className="text-gray-500 text-xs mt-1">
                  Verify your identity to unlock higher transaction limits.
                </p>
                <button
                  type="button"
                  onClick={() => navigate('/kyc')}
                  className="mt-3 w-full bg-primary-500 hover:bg-primary-600 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
                >
                  Start KYC Verification
                </button>
              </div>
            )}

            {kycStatus === 'pending' && (
              <div className="mt-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4">
                <p className="text-yellow-400 font-semibold">Pending Review</p>
                <p className="text-gray-400 text-xs mt-1">Your KYC submission is being reviewed.</p>
              </div>
            )}

            {kycStatus === 'verified' && (
              <div className="mt-3 bg-green-500/10 border border-green-500/20 rounded-xl p-4">
                <p className="text-green-400 font-semibold">Verified</p>
                <p className="text-gray-400 text-xs mt-1">
                  You can send transactions of any amount.
                </p>
              </div>
            )}

            {kycStatus === 'rejected' && (
              <div className="mt-3 bg-red-500/10 border border-red-500/20 rounded-xl p-4">
                <p className="text-red-400 font-semibold">Rejected</p>
                {kycRejectionReason && (
                  <p className="text-red-300 text-xs mt-1">Reason: {kycRejectionReason}</p>
                )}
                <button
                  type="button"
                  onClick={() => navigate('/kyc')}
                  className="mt-3 w-full bg-red-500/15 hover:bg-red-500/25 text-red-200 font-semibold py-2.5 rounded-xl text-sm transition-colors border border-red-500/30"
                >
                  Resubmit
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
