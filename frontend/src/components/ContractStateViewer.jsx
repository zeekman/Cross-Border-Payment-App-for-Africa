import React, { useState } from 'react';
import { StrKey } from '@stellar/stellar-sdk';
import { Copy } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../utils/api';

const display = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

export default function ContractStateViewer() {
  const [contractId, setContractId] = useState('');
  const [keyPrefix, setKeyPrefix] = useState('');
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const copy = (text) =>
    navigator.clipboard?.writeText(text).then(() => toast.success('Copied'), () => toast.error('Copy failed'));

  const fetchState = async () => {
    const id = contractId.trim();
    if (!StrKey.isValidContract(id)) {
      setError('Enter a valid contract ID (C…, 56 characters)');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await api.get(`/contracts/${id}/state`, { params: { prefix: keyPrefix } });
      setState(res.data.data || []);
    } catch (err) {
      setState(null);
      const msg = err.response?.data?.error || 'Failed to fetch contract state';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const inputCls =
    'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors';

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-primary-400 mb-3">Contract State Viewer</h3>
      <div className="flex gap-2 flex-wrap mb-3">
        <input
          type="text"
          aria-label="Contract ID"
          placeholder="Contract ID (C...)"
          value={contractId}
          onChange={(e) => setContractId(e.target.value)}
          className={`flex-1 ${inputCls}`}
        />
        <input
          type="text"
          aria-label="Key prefix"
          placeholder="Key Prefix (optional)"
          value={keyPrefix}
          onChange={(e) => setKeyPrefix(e.target.value)}
          className={`w-32 ${inputCls}`}
        />
        <button
          type="button"
          onClick={fetchState}
          disabled={loading || !contractId}
          className="bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
        >
          {loading ? 'Loading...' : 'View State'}
        </button>
      </div>
      {error && <p role="alert" className="text-sm text-red-400 mb-3">{error}</p>}
      {state && (state.length === 0 ? (
        <p className="text-sm text-gray-400">No entries found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono text-gray-300">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-1 pr-3">Key</th>
                <th className="py-1 pr-3">Value</th>
              </tr>
            </thead>
            <tbody>
              {state.map((e, i) => (
                <tr key={i} className="border-t border-gray-800 align-top">
                  <td className="py-1 pr-3 break-all">
                    {display(e.key)}{' '}
                    <button type="button" aria-label="Copy key" onClick={() => copy(display(e.key))}><Copy size={12} /></button>
                  </td>
                  <td className="py-1 pr-3 break-all">
                    {display(e.val ?? e.value)}{' '}
                    <button type="button" aria-label="Copy value" onClick={() => copy(display(e.val ?? e.value))}><Copy size={12} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
