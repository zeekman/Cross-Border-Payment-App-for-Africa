import React, { useState } from 'react';
import { X, Code } from 'lucide-react';
import api from '../utils/api';
import toast from 'react-hot-toast';

export default function XDRInspectorModal({ isOpen, onClose, xdr }) {
  const [decoded, setDecoded] = useState(null);
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    if (isOpen && xdr) {
      setLoading(true);
      api.post('/dev/decode-xdr', { xdr })
        .then(res => setDecoded(res.data.decoded))
        .catch(err => toast.error(err.response?.data?.error || 'Failed to decode XDR'))
        .finally(() => setLoading(false));
    }
  }, [isOpen, xdr]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Code size={20} className="text-primary-400" />
            <h3 className="text-lg font-bold text-white">Transaction XDR Inspector</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto max-h-[calc(80vh-80px)]">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : decoded ? (
            <div className="space-y-4">
              <div className="bg-gray-800 rounded-lg p-4">
                <p className="text-xs text-gray-400 mb-1">Source Account</p>
                <p className="text-sm text-white font-mono break-all">{decoded.sourceAccount}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-gray-800 rounded-lg p-4">
                  <p className="text-xs text-gray-400 mb-1">Fee (stroops)</p>
                  <p className="text-sm text-white font-mono">{decoded.fee}</p>
                </div>

                <div className="bg-gray-800 rounded-lg p-4">
                  <p className="text-xs text-gray-400 mb-1">Sequence Number</p>
                  <p className="text-sm text-white font-mono">{decoded.seqNum}</p>
                </div>
              </div>

              {decoded.memo && (
                <div className="bg-gray-800 rounded-lg p-4">
                  <p className="text-xs text-gray-400 mb-1">Memo</p>
                  <p className="text-sm text-white">{decoded.memo}</p>
                </div>
              )}

              <div className="bg-gray-800 rounded-lg p-4">
                <p className="text-xs text-gray-400 mb-2">Operations ({decoded.operations.length})</p>
                <div className="space-y-2">
                  {decoded.operations.map((op, idx) => (
                    <div key={idx} className="bg-gray-900 rounded p-3">
                      <p className="text-sm text-primary-400 font-semibold mb-1">{op.type}</p>
                      {op.sourceAccount && (
                        <p className="text-xs text-gray-500 mb-1">Source: {op.sourceAccount}</p>
                      )}
                      <pre className="text-xs text-gray-300 overflow-x-auto">
                        {JSON.stringify(op.details, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-center text-gray-500 py-8">No XDR data available</p>
          )}
        </div>

        <div className="p-5 border-t border-gray-800">
          <button
            onClick={onClose}
            className="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-xl transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
