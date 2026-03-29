import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, ShieldCheck, Building2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import { truncateAddress } from '../utils/currency';
import toast from 'react-hot-toast';

export default function BusinessSettings() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [signers, setSigners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [upgrading, setUpgrading] = useState(false);

  const isBusiness = user?.account_type === 'business';

  useEffect(() => {
    api.get('/wallet/signers')
      .then(r => setSigners(r.data.signers))
      .catch(() => toast.error('Failed to load signers'))
      .finally(() => setLoading(false));
  }, []);

  const handleUpgrade = async () => {
    if (!window.confirm('Upgrade to a Business account? This enables multisig on your Stellar wallet.')) return;
    setUpgrading(true);
    try {
      await api.post('/wallet/upgrade-business');
      setUser(prev => ({ ...prev, account_type: 'business' }));
      toast.success('Account upgraded to Business');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Upgrade failed');
    } finally {
      setUpgrading(false);
    }
  };

  const handleAddSigner = async (e) => {
    e.preventDefault();
    setAdding(true);
    try {
      const res = await api.post('/wallet/signers', { signer_public_key: newKey.trim(), label: newLabel.trim() || undefined });
      setSigners(prev => [...prev, { signer_public_key: newKey.trim(), label: newLabel.trim() || null, added_at: new Date().toISOString() }]);
      setNewKey('');
      setNewLabel('');
      toast.success('Signer added');
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || 'Failed to add signer');
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveSigner = async (signerPublicKey) => {
    if (!window.confirm('Remove this signer? If no signers remain, the account reverts to personal.')) return;
    setRemoving(signerPublicKey);
    try {
      await api.delete(`/wallet/signers/${signerPublicKey}`);
      const remaining = signers.filter(s => s.signer_public_key !== signerPublicKey);
      setSigners(remaining);
      if (remaining.length === 0) {
        setUser(prev => ({ ...prev, account_type: 'personal' }));
        toast.success('Last signer removed — account reverted to personal');
      } else {
        toast.success('Signer removed');
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to remove signer');
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="px-4 py-6 max-w-lg mx-auto space-y-6">
      <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white flex items-center gap-1">
        <ArrowLeft size={18} /> Back
      </button>

      <div className="flex items-center gap-3">
        <Building2 size={22} className="text-primary-400" />
        <h2 className="text-2xl font-bold text-white">Business Account</h2>
      </div>

      {/* Upgrade banner */}
      {!isBusiness && (
        <div className="bg-primary-500/10 border border-primary-500/30 rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-primary-400">
            <ShieldCheck size={18} />
            <p className="font-semibold">Upgrade to Business</p>
          </div>
          <p className="text-sm text-gray-400">
            Business accounts require 2-of-N signatures for medium and high-threshold operations
            (payments, account changes). Low-threshold ops like trustlines still need only 1 signature.
          </p>
          <button
            onClick={handleUpgrade}
            disabled={upgrading}
            className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
          >
            {upgrading ? 'Upgrading…' : 'Upgrade to Business Account'}
          </button>
        </div>
      )}

      {/* Signers list */}
      <div className="bg-gray-900 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-white">Authorized Signers</h3>
          {isBusiness && (
            <span className="text-xs bg-primary-500/20 text-primary-400 px-2 py-0.5 rounded-full">
              threshold: 2-of-N
            </span>
          )}
        </div>

        {loading ? (
          <p className="text-gray-500 text-sm text-center py-4">Loading…</p>
        ) : signers.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">No additional signers configured.</p>
        ) : (
          <div className="space-y-2">
            {signers.map(s => (
              <div key={s.signer_public_key} className="flex items-center gap-3 bg-gray-800 rounded-xl px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white font-medium truncate">{s.label || 'Unnamed signer'}</p>
                  <p className="text-xs text-gray-500 font-mono">{truncateAddress(s.signer_public_key, 14)}</p>
                </div>
                <button
                  onClick={() => handleRemoveSigner(s.signer_public_key)}
                  disabled={removing === s.signer_public_key}
                  className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-40"
                  aria-label="Remove signer"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add signer form — only for business accounts */}
        {isBusiness && (
          <form onSubmit={handleAddSigner} className="space-y-2 pt-2 border-t border-gray-800">
            <p className="text-xs text-gray-500 font-semibold uppercase tracking-wide">Add signer</p>
            <input
              type="text"
              required
              placeholder="Stellar public key (G…)"
              value={newKey}
              onChange={e => setNewKey(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white font-mono placeholder-gray-500 focus:outline-none focus:border-primary-500"
            />
            <input
              type="text"
              placeholder="Label (optional)"
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-primary-500"
            />
            <button
              type="submit"
              disabled={adding}
              className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors flex items-center justify-center gap-2"
            >
              <Plus size={16} />
              {adding ? 'Adding…' : 'Add Signer'}
            </button>
          </form>
        )}
      </div>

      {isBusiness && (
        <p className="text-xs text-gray-600 text-center">
          Removing all signers reverts the account to personal and resets thresholds to 1.
        </p>
      )}
    </div>
  );
}
