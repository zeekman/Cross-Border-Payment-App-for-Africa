import React, { useRef, useState } from 'react';
import api from '../utils/api';

export default function SendMoney({ contacts, setContacts }) {
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef(null);

  // 1. Download CSV Template
  const handleDownloadTemplate = async () => {
    try {
      const response = await api.get('/api/contacts/import/template', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 'contacts_template.csv');
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
    } catch (err) {
      setError('Failed to download template. Please try again.');
    }
  };

  // 2. Upload CSV File
  const handleImportSubmit = async (e) => {
    e.preventDefault();
    if (!importFile) {
      setError('Please select a CSV file to import.');
      return;
    }

    const formData = new FormData();
    formData.append('file', importFile);

    setLoading(true);
    setError('');
    setImportResult(null);

    try {
      const res = await api.post('/api/contacts/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      setImportResult(res.data);

      // 3. Update contact picker state dynamically without reload if new contacts were added
      if (res.data.importedContacts && res.data.importedContacts.length > 0) {
        setContacts((prevContacts) => [...prevContacts, ...res.data.importedContacts]);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to import contacts. Check file format.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4">
      {/* Existing Send Money / Contact Picker Header */}
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold">Send Money & Contacts</h2>
        <button
          onClick={() => setShowImportModal(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition"
        >
          Import Contacts (CSV)
        </button>
      </div>

      {/* Import Modal Dialog */}
      {showImportModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl max-w-lg w-full p-6 shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Import Contacts via CSV</h3>
              <button
                onClick={() => {
                  setShowImportModal(false);
                  setImportResult(null);
                  setImportFile(null);
                  setError('');
                }}
                className="text-gray-400 hover:text-gray-600 text-xl font-bold"
              >
                &times;
              </button>
            </div>

            <p className="text-sm text-gray-600 mb-4">
              Upload a CSV file to bulk-add frequent recipients. First, download the template to ensure correct column headers.
            </p>

            <button
              onClick={handleDownloadTemplate}
              className="mb-4 text-sm text-blue-600 hover:underline font-medium block"
            >
              ↓ Download CSV Template
            </button>

            {error && <div className="mb-4 p-3 bg-red-50 text-red-700 text-sm rounded-lg">{error}</div>}

            <form onSubmit={handleImportSubmit}>
              <div className="mb-4 border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                <input
                  type="file"
                  accept=".csv"
                  ref={fileInputRef}
                  onChange={(e) => setImportFile(e.target.files[0])}
                  className="hidden"
                  id="csv-file-input"
                />
                <label
                  htmlFor="csv-file-input"
                  className="cursor-pointer text-sm text-blue-600 hover:underline font-medium"
                >
                  {importFile ? importFile.name : 'Click to select CSV file'}
                </label>
              </div>

              {/* Import Results & Row-Level Errors */}
              {importResult && (
                <div className="mb-4 p-4 bg-gray-50 rounded-lg text-sm max-h-40 overflow-y-auto">
                  <p className="font-semibold text-green-700 mb-1">
                    Successfully imported: {importResult.successCount || 0} contacts.
                  </p>
                  {importResult.errors && importResult.errors.length > 0 && (
                    <div className="mt-2 text-red-600">
                      <p className="font-semibold">Row-level errors:</p>
                      <ul className="list-disc pl-5 mt-1 space-y-1">
                        {importResult.errors.map((err, idx) => (
                          <li key={idx}>
                            Row {err.row}: {err.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={loading || !importFile}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? 'Uploading...' : 'Upload & Import'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
