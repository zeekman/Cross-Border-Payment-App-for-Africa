import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Gift } from 'lucide-react';
import api from '../../utils/api';

export default function LoyaltyCard() {

  // Loyalty points state (issue #480)
  const [loyaltyBalance, setLoyaltyBalance] = useState(null);
  const [loyaltyLoading, setLoyaltyLoading] = useState(true);
  const [redeemLoading, setRedeemLoading] = useState(false);

  const handleRedeemLoyalty = async () => {
    setRedeemLoading(true);
    try {
      await api.post('/loyalty/redeem');
      toast.success('100 loyalty points redeemed for 50% fee discount');
      // Refresh balance
      const res = await api.get('/loyalty/balance');
      setLoyaltyBalance(res.data.points || 0);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to redeem points');
    } finally {
      setRedeemLoading(false);
    }
  };

  React.useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/loyalty/balance');
        setLoyaltyBalance(res.data.points || 0);
      } catch {
        // non-critical, silently ignore
      } finally {
        setLoyaltyLoading(false);
      }
    })();
  }, []);

  return (
    <>
      {/* Loyalty Points (issue #480) */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Gift size={16} className="text-primary-400" />
            <h3 className="font-semibold text-white">Loyalty Points</h3>
          </div>
        </div>

        {loyaltyLoading ? (
          <p className="text-gray-500 text-sm mt-2">Loading…</p>
        ) : (
          <div className="mt-3 bg-gray-800 border border-gray-700 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-300 font-semibold text-2xl">{loyaltyBalance || 0}</p>
                <p className="text-gray-500 text-xs mt-1">Points available</p>
              </div>
              <button
                onClick={handleRedeemLoyalty}
                disabled={redeemLoading || (loyaltyBalance || 0) < 100}
                className="bg-primary-500 hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
              >
                {redeemLoading ? 'Redeeming…' : 'Redeem 100'}
              </button>
            </div>
            <p className="text-gray-500 text-xs mt-2">
              Redeem 100 points for a 50% fee discount on your next transaction.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
