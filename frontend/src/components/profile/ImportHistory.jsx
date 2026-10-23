import React, { useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../utils/api';

export default function ImportHistory() {

  // Horizon history import state (issue #130)
  const [importingHistory, setImportingHistory] = useState(false);

  const handleImportHistory = async () => {
    setImportingHistory(true);
    try {
      const res = await api.post('/wallet/import-history');
      toast.success(`Import complete — ${res.data.imported} new transactions added`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Import failed');
    } finally {
      setImportingHistory(false);
    }
  };

  return (
    <>
      {/* Import Horizon History */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-white">Import Transaction History</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Fetch your complete Stellar history from Horizon
            </p>
          </div>
          <button
            onClick={handleImportHistory}
            disabled={importingHistory}
            className="text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg transition-colors"
          >
            {importingHistory ? 'Importing…' : 'Import History'}
          </button>
        </div>
      </div>
    </>
  );
}
