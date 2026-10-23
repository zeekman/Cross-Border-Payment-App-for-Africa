import { useState } from 'react';
import api from '../../utils/api';
import toast from 'react-hot-toast';

export default function AdminContractViewer({ user }) {
  const [adminContractId, setAdminContractId] = useState('');
  const [adminKeyPrefix, setAdminKeyPrefix] = useState('');
  const [adminContractState, setAdminContractState] = useState(null);
  const [adminStateLoading, setAdminStateLoading] = useState(false);

  const fetchContractState = async () => {
    if (!adminContractId) return;
    setAdminStateLoading(true);
    try {
      const res = await api.get(`/contracts/${adminContractId}/state`, {
        params: { prefix: adminKeyPrefix },
      });
      setAdminContractState(res.data.data || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to fetch contract state');
    } finally {
      setAdminStateLoading(false);
    }
  };

  return (
    <>
      {/* Admin Dashboard: Contract State Viewer */}
      {user?.role === 'admin' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-primary-400 mb-3">
            Admin: Contract State Viewer
          </h3>
          <div className="flex gap-2 flex-wrap mb-3">
            <input
              type="text"
              placeholder="Contract ID (C...)"
              value={adminContractId}
              onChange={(e) => setAdminContractId(e.target.value)}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
            />
            <input
              type="text"
              placeholder="Key Prefix (optional)"
              value={adminKeyPrefix}
              onChange={(e) => setAdminKeyPrefix(e.target.value)}
              className="w-32 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
            />
            <button
              type="button"
              onClick={fetchContractState}
              disabled={adminStateLoading || !adminContractId}
              className="bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
            >
              {adminStateLoading ? 'Loading...' : 'View State'}
            </button>
          </div>
          {adminContractState && (
            <div className="bg-gray-800 p-3 rounded-lg overflow-x-auto text-xs font-mono text-gray-300">
              {JSON.stringify(adminContractState, null, 2)}
            </div>
          )}
        </div>
      )}
    </>
  );
}
