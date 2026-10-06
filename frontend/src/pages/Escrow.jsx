import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import { useConfirm } from '../context/ConfirmContext';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

export default function Escrow() {
  const confirm = useConfirm();
  const { t } = useTranslation();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('create');
  const [escrows, setEscrows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [role, setRole] = useState('sender');
  const [statusFilter, setStatusFilter] = useState('');

  // Create escrow form
  const [createForm, setCreateForm] = useState({
    agent_wallet: '',
    recipient_wallet: '',
    amount: '',
    asset: 'USDC',
  });

  // Confirm/Cancel escrow
  const [selectedEscrow, setSelectedEscrow] = useState(null);

  // Partial release modal (issue #657)
  const [partialEscrow, setPartialEscrow] = useState(null);
  const [partialAmount, setPartialAmount] = useState('');
  const [partialLoading, setPartialLoading] = useState(false);

  const feeBps = partialEscrow?.fee_bps ?? 250; // platform fee from escrow, fallback 2.5%

  const remainingBalance = (escrow) =>
    parseFloat(escrow.amount) - parseFloat(escrow.released_amount || 0);

  const openPartialRelease = (escrow) => {
    setPartialEscrow(escrow);
    setPartialAmount(String(remainingBalance(escrow)));
  };

  const closePartialRelease = () => {
    setPartialEscrow(null);
    setPartialAmount('');
  };

  useEffect(() => {
    if (activeTab === 'list') {
      fetchEscrows();
    }
  }, [activeTab, role, statusFilter]);

  const fetchEscrows = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { role };
      if (statusFilter) params.status = statusFilter;
      const { data } = await api.get('/escrow', { params });
      setEscrows(data.escrows || []);
    } catch (err) {
      const message = err.response?.data?.error || 'Failed to fetch escrows';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateEscrow = async (e) => {
    e.preventDefault();
    if (!createForm.agent_wallet || !createForm.recipient_wallet || !createForm.amount) {
      toast.error('Please fill in all fields');
      return;
    }

    // Validate Stellar address format (56 chars, starts with 'G')
    const validateWallet = (addr, label) => {
      const trimmed = addr.trim();
      if (!trimmed.startsWith('G')) {
        toast.error(`${label} must be a valid Stellar address (starts with G)`);
        return false;
      }
      if (trimmed.length !== 56) {
        toast.error(`${label} must be 56 characters (got ${trimmed.length})`);
        return false;
      }
      if (!/^[A-Z0-9]+$/.test(trimmed)) {
        toast.error(`${label} contains invalid characters`);
        return false;
      }
      return true;
    };

    if (!validateWallet(createForm.agent_wallet, 'Agent wallet')) return;
    if (!validateWallet(createForm.recipient_wallet, 'Recipient wallet')) return;

    setLoading(true);
    try {
      const { data } = await api.post('/escrow/create', createForm);
      toast.success('Escrow created successfully');
      setCreateForm({ agent_wallet: '', recipient_wallet: '', amount: '', asset: 'USDC' });
      setActiveTab('list');
      fetchEscrows();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create escrow');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmEscrow = async (escrowId, escrow) => {
    const remaining = remainingBalance(escrow);
    if (!(await confirm(
      t('confirm.release_escrow', 'Fully release the remaining {{amount}} {{asset}}? This action cannot be undone.', { amount: remaining, asset: escrow.asset }),
      { title: t('confirm.release_escrow_title', 'Release escrow'), confirmLabel: t('confirm.release', 'Release') }
    ))) return;

    setLoading(true);
    try {
      await api.post(`/escrow/${escrowId}/confirm`);
      toast.success('Escrow confirmed');
      fetchEscrows();
      setSelectedEscrow(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to confirm escrow');
    } finally {
      setLoading(false);
    }
  };

  const handleCancelEscrow = async (escrowId) => {
    if (!(await confirm(t('confirm.cancel_escrow', 'Cancel this escrow? Locked funds will be returned to the sender.'), { title: t('confirm.cancel_escrow_title', 'Cancel escrow'), confirmLabel: t('confirm.cancel_escrow_btn', 'Cancel escrow') }))) return;

    setLoading(true);
    try {
      await api.post(`/escrow/${escrowId}/cancel`);
      toast.success('Escrow cancelled');
      fetchEscrows();
      setSelectedEscrow(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to cancel escrow');
    } finally {
      setLoading(false);
    }
  };

  const handlePartialRelease = async (e) => {
    e.preventDefault();
    if (!partialEscrow) return;

    const amount = parseFloat(partialAmount);
    const remaining = remainingBalance(partialEscrow);

    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter an amount greater than 0');
      return;
    }
    if (amount > remaining) {
      toast.error('Amount cannot exceed the escrowed balance');
      return;
    }

    setPartialLoading(true);
    try {
      const { data } = await api.post(`/contracts/escrow/${partialEscrow.id}/partial-release`, {
        amount,
      });
      toast.success('Partial release successful');
      // Update the affected row in place without a full reload.
      setEscrows((prev) =>
        prev.map((esc) =>
          esc.id === partialEscrow.id ? { ...esc, ...(data.escrow || {}) } : esc
        )
      );
      closePartialRelease();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to release escrow');
    } finally {
      setPartialLoading(false);
    }
  };

  const previewAmount = parseFloat(partialAmount) || 0;
  const previewFee = (previewAmount * feeBps) / 10000;
  const previewNet = previewAmount - previewFee;
  const partialError =
    partialEscrow && previewAmount > 0 && previewAmount > remainingBalance(partialEscrow)
      ? 'Amount cannot exceed the escrowed balance'
      : partialEscrow && partialAmount !== '' && previewAmount <= 0
      ? 'Amount must be greater than 0'
      : '';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">Agent Escrow</h1>

        {/* Tabs */}
        <div className="flex gap-4 mb-6 border-b border-gray-200 dark:border-gray-800" role="tablist" aria-label="Escrow views">
          <button
            onClick={() => setActiveTab('create')}
            role="tab"
            aria-selected={activeTab === 'create'}
            id="escrow-tab-create"
            aria-controls="escrow-panel-create"
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'create'
                ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            Create Escrow
          </button>
          <button
            onClick={() => setActiveTab('list')}
            role="tab"
            aria-selected={activeTab === 'list'}
            id="escrow-tab-list"
            aria-controls="escrow-panel-list"
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'list'
                ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            My Escrows
          </button>
        </div>

        {/* Create Escrow Tab */}
        {activeTab === 'create' && (
          <div
            className="bg-white dark:bg-gray-900 rounded-lg shadow p-6"
            role="tabpanel"
            id="escrow-panel-create"
            aria-labelledby="escrow-tab-create"
          >
            <form onSubmit={handleCreateEscrow} className="space-y-4" aria-busy={loading}>
              <div>
                <label htmlFor="escrow-agent-wallet" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Agent Wallet Address
                </label>
                <input
                  id="escrow-agent-wallet"
                  type="text"
                  value={createForm.agent_wallet}
                  onChange={(e) => setCreateForm({ ...createForm, agent_wallet: e.target.value })}
                  placeholder="G..."
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label htmlFor="escrow-recipient-wallet" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Recipient Wallet Address
                </label>
                <input
                  id="escrow-recipient-wallet"
                  type="text"
                  value={createForm.recipient_wallet}
                  onChange={(e) => setCreateForm({ ...createForm, recipient_wallet: e.target.value })}
                  placeholder="G..."
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="escrow-amount" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Amount
                  </label>
                  <input
                    id="escrow-amount"
                    type="number"
                    step="0.0000001"
                    min="0"
                    value={createForm.amount}
                    onChange={(e) => setCreateForm({ ...createForm, amount: e.target.value })}
                    placeholder="0.00"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label htmlFor="escrow-asset" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Asset
                  </label>
                  <select
                    id="escrow-asset"
                    value={createForm.asset}
                    onChange={(e) => setCreateForm({ ...createForm, asset: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="USDC">USDC</option>
                    <option value="XLM">XLM</option>
                  </select>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium py-2 rounded-lg transition-colors"
              >
                {loading ? 'Creating...' : 'Create Escrow'}
              </button>
            </form>
          </div>
        )}

        {/* List Escrows Tab */}
        {activeTab === 'list' && (
          <div
            className="bg-white dark:bg-gray-900 rounded-lg shadow p-6"
            role="tabpanel"
            id="escrow-panel-list"
            aria-labelledby="escrow-tab-list"
          >
            <div className="flex flex-wrap gap-4 mb-4">
              <div>
                <label htmlFor="escrow-role-filter" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Role
                </label>
                <select
                  id="escrow-role-filter"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="sender">Sender</option>
                  <option value="agent">Agent</option>
                </select>
              </div>
              <div>
                <label htmlFor="escrow-status-filter" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Status
                </label>
                <select
                  id="escrow-status-filter"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">All</option>
                  <option value="pending">Pending</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="released">Released</option>
                </select>
              </div>
            </div>

            {loading && (
              <div className="text-center py-8 text-gray-600 dark:text-gray-400" role="status">
                Loading escrows...
              </div>
            )}

            {!loading && error && (
              <div className="text-center py-8 text-red-600 dark:text-red-400" role="alert">
                {error}
              </div>
            )}

            {!loading && !error && escrows.length === 0 && (
              <div className="text-center py-8 text-gray-600 dark:text-gray-400">
                No escrows found.
              </div>
            )}

            {!loading && !error && escrows.length > 0 && (
              <div className="space-y-3">
                {escrows.map((escrow) => (
                  <div
                    key={escrow.id}
                    className="border border-gray-200 dark:border-gray-800 rounded-lg p-4"
                  >
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <p className="font-medium text-gray-900 dark:text-white">
                          {escrow.amount} {escrow.asset}
                        </p>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                          Status: {escrow.status}
                        </p>
                      </div>
                      <span className="text-xs px-2 py-1 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
                        {escrow.status}
                      </span>
                    </div>
                    <div className="flex gap-2 mt-3">
                      {escrow.status === 'pending' && (
                        <>
                          <button
                            onClick={() => handleConfirmEscrow(escrow.id, escrow)}
                            className="px-3 py-1 text-sm bg-green-600 hover:bg-green-700 text-white rounded transition-colors"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => handleCancelEscrow(escrow.id)}
                            className="px-3 py-1 text-sm bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                      {escrow.status !== 'cancelled' && escrow.status !== 'released' && (
                        <button
                          onClick={() => openPartialRelease(escrow)}
                          className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
                        >
                          Partial Release
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Partial Release Modal */}
        {partialEscrow && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-md w-full p-6">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-4">
                Partial Release
              </h2>
              <form onSubmit={handlePartialRelease} className="space-y-4">
                <div>
                  <label htmlFor="partial-amount" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Amount
                  </label>
                  <input
                    id="partial-amount"
                    type="number"
                    step="0.0000001"
                    min="0"
                    value={partialAmount}
                    onChange={(e) => setPartialAmount(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {partialError && (
                    <p className="text-sm text-red-600 dark:text-red-400 mt-1">{partialError}</p>
                  )}
                </div>

                <div className="bg-gray-50 dark:bg-gray-800 rounded p-3 text-sm space-y-1">
                  <div className="flex justify-between text-gray-700 dark:text-gray-300">
                    <span>Amount</span>
                    <span>{previewAmount.toFixed(7)}</span>
                  </div>
                  <div className="flex justify-between text-gray-700 dark:text-gray-300">
                    <span>Fee ({(feeBps / 100).toFixed(2)}%)</span>
                    <span>{previewFee.toFixed(7)}</span>
                  </div>
                  <div className="flex justify-between font-medium text-gray-900 dark:text-white">
                    <span>Net</span>
                    <span>{previewNet.toFixed(7)}</span>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={closePartialRelease}
                    className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={partialLoading || !!partialError}
                    className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg transition-colors"
                  >
                    {partialLoading ? 'Releasing...' : 'Release'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
