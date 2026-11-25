import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '../utils/api';

// Matches the backend multer limit in routes/contacts.js.
export const CSV_MAX_BYTES = 5 * 1024 * 1024;

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * CSV contact import dialog (FE-145).
 * Follows ConfirmModal's dialog pattern: role="dialog", focus trap, Escape to close,
 * focus restored to the opener. Calls `onImported` after a successful import so the
 * caller can re-fetch its contacts list.
 */
export default function ImportContactsModal({ isOpen, onClose, onImported }) {
  const { t } = useTranslation();
  const titleId = useId();
  const inputId = useId();
  const panelRef = useRef(null);
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return undefined;
    const previouslyFocused = document.activeElement;
    panelRef.current?.querySelector(FOCUSABLE_SELECTOR)?.focus();
    return () => {
      setFile(null);
      setResult(null);
      setError('');
      if (previouslyFocused && typeof previouslyFocused.focus === 'function' && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const close = () => {
    if (!loading) onClose?.();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = Array.from(panelRef.current.querySelectorAll(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const handleFileChange = (e) => {
    const selected = e.target.files?.[0] || null;
    setResult(null);
    if (selected && selected.size > CSV_MAX_BYTES) {
      setFile(null);
      setError(t('contacts_import.file_too_large'));
      return;
    }
    setError('');
    setFile(selected);
  };

  const handleDownloadTemplate = async () => {
    try {
      const response = await api.get('/contacts/import/template', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 'contacts_template.csv');
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      setError(t('contacts_import.template_failed'));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) {
      setError(t('contacts_import.no_file'));
      return;
    }
    const formData = new FormData();
    formData.append('file', file);
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const res = await api.post('/contacts/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(res.data);
      if (res.data.imported > 0) onImported?.();
    } catch (err) {
      setError(err.response?.data?.error || t('contacts_import.upload_failed'));
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    // Keyboard handling sits on the backdrop so it covers the whole dialog (same as ConfirmModal).
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center p-4"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-gray-900 rounded-2xl w-full max-w-lg p-6"
      >
        <div className="flex justify-between items-center mb-4">
          <h3 id={titleId} className="text-lg font-semibold text-white">{t('contacts_import.title')}</h3>
          <button
            type="button"
            onClick={close}
            disabled={loading}
            aria-label={t('common.close')}
            className="text-gray-400 hover:text-white transition-colors disabled:opacity-50"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <p className="text-sm text-gray-400 mb-4">{t('contacts_import.description')}</p>

        <button
          type="button"
          onClick={handleDownloadTemplate}
          className="mb-4 text-sm text-primary-500 hover:underline font-medium block"
        >
          {t('contacts_import.download_template')}
        </button>

        {error && <div role="alert" className="mb-4 p-3 bg-red-900/40 text-red-300 text-sm rounded-lg">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="mb-4 border-2 border-dashed border-gray-700 rounded-lg p-6 text-center">
            <label htmlFor={inputId} className="block text-sm text-gray-300 mb-2">
              {file ? file.name : t('contacts_import.select_file')}
            </label>
            <input id={inputId} type="file" accept=".csv,text/csv" onChange={handleFileChange} className="text-sm text-gray-400" />
          </div>

          {result && (
            <div role="status" className="mb-4 p-4 bg-gray-800 rounded-lg text-sm max-h-40 overflow-y-auto text-gray-300">
              <p className="text-green-400 font-semibold">{t('contacts_import.imported', { count: result.imported || 0 })}</p>
              <p>{t('contacts_import.skipped', { count: result.skipped_duplicates || 0 })}</p>
              <p>{t('contacts_import.failed', { count: result.failed || 0 })}</p>
              {result.errors?.length > 0 && (
                <ul className="list-disc pl-5 mt-2 space-y-1 text-red-400">
                  {result.errors.map((rowErr) => (
                    <li key={`${rowErr.row}-${rowErr.error}`}>
                      {t('contacts_import.row_error', { row: rowErr.row, error: rowErr.error })}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={close}
              disabled={loading}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-xl text-sm text-white disabled:opacity-50"
            >
              {t('common.close')}
            </button>
            <button
              type="submit"
              disabled={loading || !file}
              className="px-4 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-xl text-sm font-medium disabled:opacity-50"
            >
              {loading ? t('contacts_import.uploading') : t('contacts_import.upload')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
