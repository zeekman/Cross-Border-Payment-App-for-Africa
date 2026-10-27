import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Coins } from 'lucide-react';
import api from '../../utils/api';
import { useConfirm } from '../../context/ConfirmContext';

export default function ManageAssets() {
  const confirm = useConfirm();
  const { t } = useTranslation();

  const [trustlines, setTrustlines] = useState([]);
  const [newAsset, setNewAsset] = useState('');
  const [trustlineLoading, setTrustlineLoading] = useState(false);

  const handleAddTrustline = async (e) => {
    e.preventDefault();
    setTrustlineLoading(true);
    try {
      await api.post('/wallet/trustline', { asset: newAsset.trim().toUpperCase() });
      const r = await api.get('/wallet/trustlines');
      setTrustlines(r.data.trustlines || []);
      setNewAsset('');
      toast.success('Trustline added');
    } catch (err) {
      toast.error(
        err.response?.data?.error ||
          err.response?.data?.errors?.[0]?.msg ||
          'Failed to add trustline'
      );
    } finally {
      setTrustlineLoading(false);
    }
  };

  const handleRemoveTrustline = async (asset) => {
    if (!(await confirm(t('confirm.remove_trustline', 'Remove {{asset}} trustline? Your {{asset}} balance must be zero.', { asset }), { title: t('confirm.remove_trustline_title', 'Remove trustline'), confirmLabel: t('confirm.remove', 'Remove') }))) return;
    try {
      await api.delete(`/wallet/trustline/${asset}`);
      setTrustlines((prev) => prev.filter((t) => t.asset !== asset));
      toast.success(`${asset} trustline removed`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to remove trustline');
    }
  };

  React.useEffect(() => {
    (async () => {
      try {
        const r = await api.get('/wallet/trustlines');
        setTrustlines(r.data.trustlines || []);
      } catch {
        // non-critical
      }
    })();
  }, []);

  return (
    <>
      {/* Manage Assets */}
      <div className="bg-gray-900 rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Coins size={16} className="text-gray-500" />
          <h3 className="font-semibold text-white">Manage Assets</h3>
        </div>

        {trustlines.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-2">No asset trustlines yet.</p>
        ) : (
          <div className="space-y-2">
            {trustlines.map((t) => (
              <div
                key={t.asset}
                className="flex items-center gap-3 bg-gray-800 rounded-xl px-3 py-2.5"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white">{t.asset}</p>
                  <p className="text-xs text-gray-500">
                    Balance: {parseFloat(t.balance).toLocaleString()}
                  </p>
                </div>
                <button
                  onClick={() => handleRemoveTrustline(t.asset)}
                  className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                  aria-label={`Remove ${t.asset} trustline`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handleAddTrustline} className="flex gap-2 pt-1 border-t border-gray-800">
          <input
            type="text"
            required
            placeholder="Asset code (e.g. USDC)"
            value={newAsset}
            onChange={(e) => setNewAsset(e.target.value)}
            maxLength={12}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-primary-500"
          />
          <button
            type="submit"
            disabled={trustlineLoading}
            className="bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors flex items-center gap-1.5"
          >
            <Plus size={14} />
            {trustlineLoading ? '…' : 'Add'}
          </button>
        </form>
      </div>
    </>
  );
}
