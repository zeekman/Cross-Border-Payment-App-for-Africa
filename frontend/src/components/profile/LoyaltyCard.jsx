import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Gift } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '../../utils/api';
import { apiErrorMessage } from '../../utils/apiError';
import ConfirmModal from '../ConfirmModal';

export default function LoyaltyCard() {
  const { t, i18n } = useTranslation();
  const [loyaltyBalance, setLoyaltyBalance] = useState(null);
  const [loyaltyLoading, setLoyaltyLoading] = useState(true);
  const [redeemLoading, setRedeemLoading] = useState(false);
  const [loyaltyTiers, setLoyaltyTiers] = useState([]);
  const [loyaltyHistory, setLoyaltyHistory] = useState([]);
  const [confirmTier, setConfirmTier] = useState(null);

  const refreshLoyalty = async () => {
    const [bal, tiers, hist] = await Promise.all([
      api.get('/loyalty/balance'),
      api.get('/loyalty/tiers'),
      api.get('/loyalty/history'),
    ]);
    setLoyaltyBalance(bal.data.points || 0);
    setLoyaltyTiers(tiers.data.tiers || []);
    setLoyaltyHistory(hist.data.history || []);
  };

  const handleRedeemLoyalty = async () => {
    const tier = confirmTier;
    setRedeemLoading(true);
    try {
      await api.post('/loyalty/redeem', { tier_index: tier.index });
      toast.success(t('loyalty.redeemed', { points: tier.threshold, percent: tier.discount_bps / 100 }));
      setConfirmTier(null);
      await refreshLoyalty();
    } catch (err) {
      toast.error(apiErrorMessage(err));
      toast.error(err.response?.data?.error || t('loyalty.redeemFailed'));
    } finally {
      setRedeemLoading(false);
    }
  };

  useEffect(() => {
    refreshLoyalty()
      .catch(() => {}) // non-critical
      .finally(() => setLoyaltyLoading(false));
  }, []);

  return (
    <>
      {/* Loyalty Points (issue #480) */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <Gift size={16} className="text-primary-400" />
          <h3 className="font-semibold text-white">{t('loyalty.title')}</h3>
        </div>

        {loyaltyLoading ? (
          <p className="text-gray-500 text-sm mt-2">{t('loyalty.loading')}</p>
        ) : (
          <div className="mt-3 bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-4">
            <div>
              <p className="text-gray-300 font-semibold text-2xl">{loyaltyBalance || 0}</p>
              <p className="text-gray-500 text-xs mt-1">{t('loyalty.available')}</p>
            </div>
            <div>
              <p className="text-gray-400 text-xs font-semibold mb-2">{t('loyalty.tiers')}</p>
              {loyaltyTiers.length === 0 ? (
                <p className="text-gray-500 text-xs">{t('loyalty.noTiers')}</p>
              ) : (
                <ul className="space-y-2">
                  {loyaltyTiers.map((tier, i) => {
                    const tierObj = { ...tier, index: i };
                    const missing = Number(tier.threshold) - (loyaltyBalance || 0);
                    return (
                      <li key={i} className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-white text-sm">{t('loyalty.discount', { percent: tier.discount_bps / 100 })}</p>
                          <p className="text-gray-500 text-xs">
                            {t('loyalty.cost', { points: tier.threshold })}
                            {missing > 0 && ` · ${t('loyalty.needMore', { points: missing })}`}
                          </p>
                        </div>
                        <button
                          onClick={() => setConfirmTier(tierObj)}
                          disabled={redeemLoading || missing > 0}
                          className="bg-primary-500 hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
                        >
                          {t('loyalty.redeem')}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div>
              <p className="text-gray-400 text-xs font-semibold mb-2">{t('loyalty.history')}</p>
              {loyaltyHistory.length === 0 ? (
                <p className="text-gray-500 text-xs">{t('loyalty.noHistory')}</p>
              ) : (
                <ul className="space-y-1">
                  {loyaltyHistory.slice(0, 10).map((h) => (
                    <li key={h.id} className="flex justify-between text-xs text-gray-400">
                      <span>{h.event_type} · {new Date(h.created_at).toLocaleDateString(i18n.language)}</span>
                      <span>{h.points}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
      <ConfirmModal
        isOpen={!!confirmTier}
        onClose={() => setConfirmTier(null)}
        onConfirm={handleRedeemLoyalty}
        title={t('loyalty.confirmTitle')}
        message={confirmTier ? t('loyalty.confirmMsg', { points: confirmTier.threshold, percent: confirmTier.discount_bps / 100 }) : ''}
        confirmLabel={t('loyalty.redeem')}
        loading={redeemLoading}
      />
    </>
  );
}
