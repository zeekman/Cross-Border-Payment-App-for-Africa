import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, AlertCircle, CheckCircle, CheckCircle2, Download, FileUp, Loader2, Plus, RotateCcw, Send, Trash2, Upload, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import api from '../utils/api';
import { CURRENCIES, truncateAddress } from '../utils/currency';
import { validateStellarAddress } from '../utils/validation';
import useStepUp from '../hooks/useStepUp';

const SINGLE_TRANSFER_LIMIT = 10000;
// Matches the Soroban batch_create_escrow contract hard-cap and BE-010 server-side cap
const MAX_BATCH_SIZE = 20;

function createEmptyRecipient() {
  return { recipient_address: '', amount: '', memo: '' };
}

function splitCsvLine(line) {
  const values = [];
  let current = '';
  let insideQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (insideQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (char === ',' && !insideQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

function validateAmount(amount) {
  if (!amount && amount !== 0) {
    return i18n.t('batch.amountRequired');
  }
  
  const numAmount = parseFloat(amount);
  
  if (isNaN(numAmount)) {
    return i18n.t('batch.amountNumber');
  }
  
  if (numAmount <= 0) {
    return i18n.t('batch.amountPositive');
  }
  
  if (numAmount > SINGLE_TRANSFER_LIMIT) {
    return i18n.t('batch.amountLimit', { limit: SINGLE_TRANSFER_LIMIT.toLocaleString(i18n.language) });
  }
  
  return null;
}

function validateRecipient(recipient, rowNumber) {
  const errors = [];
  
  const addressError = validateStellarAddress(recipient.recipient_address);
  if (addressError) {
    errors.push(addressError);
  }
  
  const amountError = validateAmount(recipient.amount);
  if (amountError) {
    errors.push(amountError);
  }
  
  if (errors.length > 0) {
    return {
      rowNumber,
      address: recipient.recipient_address,
      amount: recipient.amount,
      memo: recipient.memo || '',
      error: errors.join('; ')
    };
  }
  
  return null;
}

function parseRecipientsCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return { recipients: [], errors: [] };

  const [headerLine, ...rows] = lines;
  const headers = splitCsvLine(headerLine).map((header) => header.toLowerCase());
  
  const addressIndex = headers.findIndex((header) =>
    ['recipient_address', 'address', 'wallet_address', 'recipient'].includes(header)
  );
  const amountIndex = headers.findIndex((header) => header === 'amount');
  const memoIndex = headers.findIndex((header) => header === 'memo');

  if (addressIndex === -1 || amountIndex === -1) {
    throw new Error(i18n.t('batch.csvColumns'));
  }

  const recipients = [];
  const validationErrors = [];

  rows.forEach((row, index) => {
    const columns = splitCsvLine(row);
    const recipient = {
      recipient_address: columns[addressIndex] || '',
      amount: columns[amountIndex] || '',
      memo: memoIndex >= 0 ? columns[memoIndex] || '' : ''
    };

    // Skip completely empty rows
    if (!recipient.recipient_address && !recipient.amount) {
      return;
    }

    const error = validateRecipient(recipient, index + 2); // +2 for header row and 0-indexing
    
    if (error) {
      validationErrors.push(error);
    }
    
    recipients.push(recipient);
  });

  return { recipients, errors: validationErrors };
}

function downloadCsvTemplate() {
  const template = `address,amount,memo
GABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOP,100.50,Optional memo
GXYZ234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCD,250.75,Another example`;
  
  const blob = new Blob([template], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'batch_payment_template.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast.success(i18n.t('batch.templateDownloaded'));
}

export default function BatchPayment() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { requestStepUp, stepUpModal } = useStepUp();
  const [asset, setAsset] = useState('XLM');
  const [memo, setMemo] = useState('');
  const [memoType, setMemoType] = useState('text');
  const [recipients, setRecipients] = useState([createEmptyRecipient()]);
  const [validationErrors, setValidationErrors] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState(null);
  const [rowStatuses, setRowStatuses] = useState({}); // { [index]: { status, error, txHash } }

  const batchSummary = useMemo(() => {
    const values = Object.values(rowStatuses);
    return {
      confirmed: values.filter((s) => s.status === 'confirmed' || s.status === 'success').length,
      failed: values.filter((s) => s.status === 'failed').length,
      processing: values.filter((s) => s.status !== 'confirmed' && s.status !== 'success' && s.status !== 'failed').length,
    };
  }, [rowStatuses]);

  const handleRetry = async (rowIndex) => {
    const row = (results?.results || []).find((r) => r.index === rowIndex);
    if (!row) return;
    try {
      const stepUpToken = await requestStepUp();
      if (!stepUpToken) return;
      setRowStatuses((prev) => ({ ...prev, [rowIndex]: { ...prev[rowIndex], status: 'pending' } }));
      const { data } = await api.post(
        '/payments/batch',
        {
          asset,
          recipients: [{ recipient_address: row.recipient_address, amount: parseFloat(row.amount) }],
        },
        { headers: { 'X-Step-Up-Token': stepUpToken, 'Idempotency-Key': crypto.randomUUID() } }
      );
      const r = data.results?.[0] || {};
      setRowStatuses((prev) => ({
        ...prev,
        [rowIndex]: { status: r.status || 'failed', error: r.error, txHash: r.tx_hash || data.transaction?.tx_hash },
      }));
    } catch (err) {
      const r = err.response?.data?.results?.[0];
      setRowStatuses((prev) => ({
        ...prev,
        [rowIndex]: { status: 'failed', error: r?.error || err.response?.data?.error || t('batch.retryFailed') },
      }));
    }
  };

  const exportBatchCsv = () => {
    const header = 'recipient_address,amount,status,tx_hash,error';
    const rows = (results?.results || []).map((r) => {
      const s = rowStatuses[r.index] || {};
      return [r.recipient_address, r.amount, s.status || r.status || '', s.txHash || '', s.error || r.error || '']
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(',');
    });
    const csv = [header, ...rows].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'batch_results.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const filledRecipients = useMemo(
    () => recipients.filter((recipient) => recipient.recipient_address.trim() || recipient.amount),
    [recipients]
  );

  const validRecipients = useMemo(() => {
    return filledRecipients.filter((recipient, index) => {
      const error = validateRecipient(recipient, index + 1);
      return error === null;
    });
  }, [filledRecipients]);

  const totalAmount = useMemo(
    () => validRecipients.reduce((sum, recipient) => sum + (parseFloat(recipient.amount) || 0), 0),
    [validRecipients]
  );

  const hasInvalidRows = validationErrors.length > 0;

  const handleRecipientChange = (index, field, value) => {
    setRecipients((current) =>
      current.map((recipient, currentIndex) =>
        currentIndex === index ? { ...recipient, [field]: value } : recipient
      )
    );
    // Clear validation errors when user makes changes
    setValidationErrors([]);
  };

  const handleCsvUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const { recipients: parsed, errors } = parseRecipientsCsv(text);
      
      if (!parsed.length) {
        toast.error(t('batch.noRecipientsCsv'));
        return;
      }

      setRecipients(parsed.slice(0, MAX_BATCH_SIZE));
      setValidationErrors(errors.slice(0, MAX_BATCH_SIZE));
      setResults(null);
      
      if (errors.length > 0) {
        toast.error(t('batch.csvErrors', { count: errors.length }));
      } else {
        toast.success(t('batch.imported', { count: Math.min(parsed.length, MAX_BATCH_SIZE) }));
      }
    } catch (error) {
      toast.error(error.message || t('batch.csvParseFailed'));
    } finally {
      event.target.value = '';
    }
  };

  const validateCurrentRecipients = () => {
    const errors = [];
    filledRecipients.forEach((recipient, index) => {
      const error = validateRecipient(recipient, index + 1);
      if (error) {
        errors.push(error);
      }
    });
    setValidationErrors(errors);
    return errors.length === 0;
  };

  const addRecipient = () => {
    if (recipients.length >= MAX_BATCH_SIZE) return;
    setRecipients((current) => [...current, createEmptyRecipient()]);
  };

  const removeRecipient = (index) => {
    setRecipients((current) => {
      const next = current.filter((_, currentIndex) => currentIndex !== index);
      return next.length ? next : [createEmptyRecipient()];
    });
    setValidationErrors([]);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!filledRecipients.length) {
      toast.error(t('batch.addOne'));
      return;
    }

    // Validate before submission
    const isValid = validateCurrentRecipients();
    if (!isValid) {
      toast.error(t('batch.fixToSubmit'));
      return;
    }

    try {
      const stepUpToken = await requestStepUp();
      if (!stepUpToken) return;
      setSubmitting(true);

      const payload = {
        asset,
        recipients: validRecipients.map((recipient) => ({
          recipient_address: recipient.recipient_address.trim(),
          amount: parseFloat(recipient.amount),
        })),
      };

      if (memo.trim()) {
        payload.memo = memo.trim();
        payload.memo_type = memoType;
      }

      const response = await api.post('/payments/batch', payload, {
        headers: { 'X-Step-Up-Token': stepUpToken },
      });
      const data = response.data;
      setResults(data);
      toast.success(data.message || t('batch.submitted'));

      const initial = {};
      (data.results || []).forEach((r) => {
        initial[r.index] = { status: r.status, error: r.error, txHash: r.tx_hash };
      });
      setRowStatuses(initial);
    } catch (error) {
      const responseData = error.response?.data;
      if (responseData?.results) {
        setResults(responseData);
      }
      toast.error(responseData?.error || responseData?.message || t('batch.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="px-4 py-6 max-w-5xl mx-auto space-y-6 pb-24">
      <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white flex items-center gap-1">
        <ArrowLeft size={18} /> {t('batch.back')}
      </button>

      <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6 space-y-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-primary-400">{t('batch.bulk')}</p>
            <h1 className="text-3xl font-bold text-white">{t('batch.title')}</h1>
            <p className="text-gray-400 mt-2 max-w-2xl">
              {t('batch.intro', { max: MAX_BATCH_SIZE })}
            </p>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={downloadCsvTemplate}
              className="inline-flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white px-4 py-3 rounded-2xl transition-colors"
            >
              <Download size={18} />
              <span className="hidden md:inline">{t('batch.template')}</span>
            </button>
            <label className="inline-flex items-center gap-2 bg-primary-500 hover:bg-primary-600 text-white px-4 py-3 rounded-2xl cursor-pointer transition-colors">
              <Upload size={18} />
              <span>{t('batch.importCsv')}</span>
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={handleCsvUpload} />
            </label>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className="text-sm text-gray-400 mb-2 block">{t('batch.asset')}</label>
              <select
                value={asset}
                onChange={(event) => setAsset(event.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3 text-white"
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.flag} {currency.code}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="text-sm text-gray-400 mb-2 block">{t('batch.memoLabel')}</label>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
                <input
                  type="text"
                  value={memo}
                  onChange={(event) => setMemo(event.target.value)}
                  maxLength={memoType === 'text' ? 28 : 64}
                  placeholder={t('batch.memoPlaceholder')}
                  className="w-full bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3 text-white placeholder-gray-500"
                />
                <select
                  value={memoType}
                  onChange={(event) => setMemoType(event.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3 text-white"
                >
                  <option value="text">{t('batch.memoText')}</option>
                  <option value="id">ID</option>
                  <option value="hash">Hash</option>
                  <option value="return">Return</option>
                </select>
              </div>
            </div>
          </div>

          {/* Validation Errors Table */}
          {validationErrors.length > 0 && (
            <div className="bg-red-950/30 border border-red-500/50 rounded-3xl overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 bg-red-900/30 border-b border-red-500/50">
                <AlertCircle size={20} className="text-red-400" />
                <div>
                  <p className="text-red-300 font-semibold">{t('batch.validationErrors')}</p>
                  <p className="text-xs text-red-400">{t('batch.rowsWithErrors', { count: validationErrors.length })}</p>
                </div>
              </div>
              
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-red-900/20 border-b border-red-500/50">
                    <tr className="text-left">
                      <th className="px-4 py-3 text-xs uppercase tracking-wider text-red-300">{t('batch.row')}</th>
                      <th className="px-4 py-3 text-xs uppercase tracking-wider text-red-300">{t('batch.address')}</th>
                      <th className="px-4 py-3 text-xs uppercase tracking-wider text-red-300">{t('batch.amount')}</th>
                      <th className="px-4 py-3 text-xs uppercase tracking-wider text-red-300">{t('batch.error')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-red-500/30">
                    {validationErrors.map((error, index) => (
                      <tr key={index} className="hover:bg-red-900/20">
                        <td className="px-4 py-3 text-red-200 font-mono text-sm">{error.rowNumber}</td>
                        <td className="px-4 py-3 text-red-200 font-mono text-sm truncate max-w-xs" title={error.address}>
                          {error.address || <span className="text-red-400 italic">{t('batch.empty')}</span>}
                        </td>
                        <td className="px-4 py-3 text-red-200 font-mono text-sm">
                          {error.amount || <span className="text-red-400 italic">{t('batch.empty')}</span>}
                        </td>
                        <td className="px-4 py-3 text-red-300 text-sm">{error.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Valid Recipients Preview */}
          {validRecipients.length > 0 && validationErrors.length > 0 && (
            <div className="bg-green-950/30 border border-green-500/50 rounded-3xl overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 bg-green-900/30 border-b border-green-500/50">
                <CheckCircle size={20} className="text-green-400" />
                <div>
                  <p className="text-green-300 font-semibold">{t('batch.readyToSend')}</p>
                  <p className="text-xs text-green-400">{t('batch.validRows', { count: validRecipients.length, total: totalAmount.toFixed(7), asset })}</p>
                </div>
              </div>
              
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-green-900/20 border-b border-green-500/50">
                    <tr className="text-left">
                      <th className="px-4 py-3 text-xs uppercase tracking-wider text-green-300">{t('batch.address')}</th>
                      <th className="px-4 py-3 text-xs uppercase tracking-wider text-green-300">{t('batch.amount')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-green-500/30">
                    {validRecipients.slice(0, 5).map((recipient, index) => (
                      <tr key={index} className="hover:bg-green-900/20">
                        <td className="px-4 py-3 text-green-200 font-mono text-sm truncate max-w-xs" title={recipient.recipient_address}>
                          {truncateAddress(recipient.recipient_address, 12)}
                        </td>
                        <td className="px-4 py-3 text-green-200 font-mono text-sm">{recipient.amount}</td>
                      </tr>
                    ))}
                    {validRecipients.length > 5 && (
                      <tr>
                        <td colSpan="2" className="px-4 py-3 text-center text-green-400 text-sm italic">
                          {t('batch.andMore', { count: validRecipients.length - 5 })}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="bg-gray-950 border border-gray-800 rounded-3xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <div>
                <p className="text-sm text-gray-400">{t('batch.recipients')}</p>
                <p className="text-xs text-gray-500">
                  {t('batch.recipientCount', { count: filledRecipients.length, max: MAX_BATCH_SIZE })}
                  {recipients.length >= MAX_BATCH_SIZE && (
                    <span className="ml-2 text-yellow-400 font-medium">{t('batch.limitReached')}</span>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={addRecipient}
                disabled={recipients.length >= MAX_BATCH_SIZE}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                title={recipients.length >= MAX_BATCH_SIZE ? t('batch.maxReached', { max: MAX_BATCH_SIZE }) : t('batch.addRecipient')}
              >
                <Plus size={16} /> {t('batch.addRow')}
              </button>
            </div>

            <div className="hidden md:grid md:grid-cols-[80px_minmax(0,1fr)_180px_72px] gap-3 px-4 py-3 text-xs uppercase tracking-[0.2em] text-gray-500 border-b border-gray-800">
              <span>{t('batch.row')}</span>
              <span>{t('batch.recipientAddress')}</span>
              <span>{t('batch.amount')}</span>
              <span>{t('batch.delete')}</span>
            </div>

            <div className="divide-y divide-gray-800 max-h-[600px] overflow-y-auto">
              {recipients.map((recipient, index) => (
                <div key={`${index}-${recipient.recipient_address}`} className="grid gap-3 px-4 py-4 md:grid-cols-[80px_minmax(0,1fr)_180px_72px] md:items-center">
                  <p className="text-xs uppercase tracking-[0.2em] text-gray-500 md:text-sm">{index + 1}</p>
                  <input
                    type="text"
                    value={recipient.recipient_address}
                    onChange={(event) => handleRecipientChange(index, 'recipient_address', event.target.value)}
                    placeholder="G..."
                    className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-white placeholder-gray-500 font-mono text-sm"
                  />
                  <input
                    type="number"
                    min="0.0000001"
                    step="any"
                    value={recipient.amount}
                    onChange={(event) => handleRecipientChange(index, 'amount', event.target.value)}
                    placeholder="0.00"
                    className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-white placeholder-gray-500"
                  />
                  <button
                    type="button"
                    onClick={() => removeRecipient(index)}
                    className="inline-flex items-center justify-center h-12 rounded-2xl bg-gray-900 border border-gray-700 text-red-400 hover:text-red-300"
                    aria-label={t('batch.removeRecipient', { n: index + 1 })}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="bg-gray-950 border border-gray-800 rounded-2xl p-4">
              <p className="text-gray-500 text-sm">{t('batch.validRecipients')}</p>
              <p className="text-2xl font-semibold text-white mt-1">{validRecipients.length}</p>
              {validationErrors.length > 0 && (
                <p className="text-xs text-red-400 mt-1">{t('batch.invalid', { count: validationErrors.length })}</p>
              )}
            </div>
            <div className="bg-gray-950 border border-gray-800 rounded-2xl p-4">
              <p className="text-gray-500 text-sm">{t('batch.totalAmount')}</p>
              <p className="text-2xl font-semibold text-white mt-1">{totalAmount.toFixed(7)} {asset}</p>
            </div>
            <div className="bg-gray-950 border border-gray-800 rounded-2xl p-4">
              <p className="text-gray-500 text-sm">{t('batch.shape')}</p>
              <p className="text-white mt-1">{t('batch.shapeValue', { max: MAX_BATCH_SIZE })}</p>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting || !validRecipients.length || hasInvalidRows}
            className="w-full md:w-auto inline-flex items-center justify-center gap-2 bg-primary-500 hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-3 rounded-2xl font-semibold"
            title={hasInvalidRows ? t('batch.fixToSubmit') : ''}
          >
            {submitting ? <FileUp size={18} className="animate-pulse" /> : <Send size={18} />}
            {hasInvalidRows ? t('batch.fixErrors') : t('batch.submit')}
          </button>
        </form>
      </div>

      {results && (
        <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6 space-y-5">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-2xl font-bold text-white">{t('batch.results')}</h2>
              {Object.keys(rowStatuses).length > 0 ? (
                <div className="flex items-center gap-4 mt-1 text-sm">
                  <span className="text-green-400">{t('batch.confirmedCount', { count: batchSummary.confirmed })}</span>
                  <span className="text-red-400">{t('batch.failedCount', { count: batchSummary.failed })}</span>
                  {batchSummary.processing > 0 && (
                    <span className="text-blue-400 flex items-center gap-1">
                      <Loader2 size={13} className="animate-spin" />
                      {t('batch.processingCount', { count: batchSummary.processing })}
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-gray-400 mt-1">
                  {t('batch.summary', { ok: results.summary?.successful || 0, failed: results.summary?.failed || 0 })}
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              {results.transaction?.tx_hash && (
                <div className="text-sm text-gray-400">
                  <p>{t('batch.ledger', { ledger: results.transaction.ledger })}</p>
                  <p className="font-mono text-xs">{results.transaction.tx_hash}</p>
                </div>
              )}
              <button
                type="button"
                onClick={exportBatchCsv}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm transition-colors"
              >
                <Download size={15} /> {t('batch.exportCsv')}
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {(results.results || []).map((result) => {
              const rowStatus = rowStatuses[result.index] || {};
              const displayStatus = rowStatus.status || result.status;
              const displayError = rowStatus.error || result.error;
              const isPending = displayStatus === 'pending';
              const isProcessing = displayStatus === 'processing';
              const isConfirmed = displayStatus === 'confirmed' || displayStatus === 'success';
              const isFailed = displayStatus === 'failed';

              return (
                <div
                  key={`${result.index}-${result.recipient_address}`}
                  className={`rounded-2xl border px-4 py-3 ${
                    isConfirmed
                      ? 'border-green-500/30 bg-green-500/10'
                      : isFailed
                      ? 'border-red-500/30 bg-red-500/10'
                      : 'border-gray-700 bg-gray-800/50'
                  }`}
                >
                  <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-white font-medium">
                        {t('batch.rowN', { n: result.index + 1, address: truncateAddress(result.recipient_address, 10) })}
                      </p>
                      <p className="text-sm text-gray-300">{result.amount} {asset}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {isPending && <Loader2 size={16} className="animate-spin text-yellow-400" />}
                      {isProcessing && <Loader2 size={16} className="animate-spin text-blue-400" />}
                      {isConfirmed && <CheckCircle2 size={16} className="text-green-400" />}
                      {isFailed && <XCircle size={16} className="text-red-400" />}
                      <span className={
                        isConfirmed ? 'text-green-400' :
                        isFailed ? 'text-red-400' :
                        isPending ? 'text-yellow-400' :
                        'text-blue-400'
                      }>
                        {isConfirmed ? t('batch.confirmed') : isFailed ? t('batch.failed') : isPending ? t('batch.pending') : t('batch.processing')}
                      </span>
                      {isFailed && (
                        <button
                          type="button"
                          onClick={() => handleRetry(result.index)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs transition-colors"
                        >
                          <RotateCcw size={12} /> {t('batch.retry')}
                        </button>
                      )}
                    </div>
                  </div>
                  {displayError && <p className="text-sm text-red-300 mt-2">{displayError}</p>}
                  {rowStatus.txHash && (
                    <p className="text-xs text-gray-500 font-mono mt-1 truncate">{rowStatus.txHash}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {stepUpModal}
    </div>
  );
}
