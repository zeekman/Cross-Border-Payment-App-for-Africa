import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Code, Copy, Check, ExternalLink } from 'lucide-react';
import { TransactionBuilder } from '@stellar/stellar-sdk';
// FE-129: Import from the shared network config instead of deriving inline.
import { NETWORK_PASSPHRASE, NETWORK_LABEL } from '../config/network';

// Keep a local alias so the rest of this file reads naturally.
const NETWORK = NETWORK_LABEL;

function formatMemo(memo) {
  if (!memo || memo.type === 'none') return null;
  if (memo.type === 'text') return `Text: ${memo.value}`;
  if (memo.type === 'id') return `ID: ${memo.value}`;
  if (memo.type === 'hash') return `Hash: ${Buffer.from(memo.value).toString('hex')}`;
  if (memo.type === 'return') return `Return: ${Buffer.from(memo.value).toString('hex')}`;
  return String(memo.value);
}

function describeOperation(op) {
  switch (op.type) {
    case 'payment':
      return `Payment — To: ${op.destination}, Amount: ${op.amount} ${
        op.asset.isNative() ? 'XLM' : op.asset.code
      }`;
    case 'pathPaymentStrictReceive':
      return `Path Payment (receive) — To: ${op.destination}, Dest Amount: ${op.destAmount} ${
        op.destAsset.isNative() ? 'XLM' : op.destAsset.code
      }`;
    case 'pathPaymentStrictSend':
      return `Path Payment (send) — From: ${op.sendAmount} ${
        op.sendAsset.isNative() ? 'XLM' : op.sendAsset.code
      }, To: ${op.destination}`;
    case 'changeTrust':
      return `Change Trust — Asset: ${op.line.isNative() ? 'XLM' : `${op.line.code}/${op.line.issuer}`}, Limit: ${op.limit}`;
    case 'allowTrust':
      return `Allow Trust — Trustor: ${op.trustor}, Asset: ${op.assetCode}`;
    case 'accountMerge':
      return `Account Merge — Destination: ${op.destination}`;
    case 'manageOffer':
    case 'manageSellOffer':
      return `Manage Sell Offer — ${op.amount} ${op.selling.isNative() ? 'XLM' : op.selling.code} @ ${op.price}`;
    case 'manageBuyOffer':
      return `Manage Buy Offer — ${op.buyAmount} ${op.buying.isNative() ? 'XLM' : op.buying.code} @ ${op.price}`;
    case 'createAccount':
      return `Create Account — Destination: ${op.destination}, Starting Balance: ${op.startingBalance} XLM`;
    case 'setOptions':
      return `Set Options`;
    case 'inflation':
      return `Inflation`;
    case 'manageData':
      return `Manage Data — Key: "${op.name}"`;
    case 'bumpSequence':
      return `Bump Sequence — To: ${op.bumpTo}`;
    case 'createClaimableBalance':
      return `Create Claimable Balance — Amount: ${op.amount} ${op.asset.isNative() ? 'XLM' : op.asset.code}`;
    case 'claimClaimableBalance':
      return `Claim Claimable Balance — ID: ${op.balanceId}`;
    case 'invokeHostFunction':
      return `Invoke Host Function (Soroban)`;
    default:
      return op.type;
  }
}

function getOperationDetails(op) {
  const raw = { ...op };
  // Stringify asset objects for display
  const stringify = (v) => {
    if (v && typeof v === 'object' && typeof v.isNative === 'function') {
      return v.isNative() ? 'XLM' : `${v.code}/${v.issuer}`;
    }
    return v;
  };
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([k]) => !['type', 'source'].includes(k))
      .map(([k, v]) => [k, stringify(v)])
  );
}

function decodeXdr(xdr) {
  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  const hashBytes = tx.hash();
  const hashHex = Array.from(new Uint8Array(hashBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const feeXlm = (parseInt(tx.fee, 10) / 1e7).toFixed(7);

  return {
    sourceAccount: tx.source,
    sequence: tx.sequence,
    fee: tx.fee,
    feeXlm,
    memo: formatMemo(tx.memo),
    operations: tx.operations.map((op) => ({
      type: op.type,
      label: describeOperation(op),
      sourceAccount: op.source || null,
      details: getOperationDetails(op),
    })),
    hash: hashHex,
  };
}

export default function XDRInspectorModal({ isOpen, onClose, xdr, txHash }) {
  const [activeTab, setActiveTab] = useState('decoded');
  const [decoded, setDecoded] = useState(null);
  const [decodeError, setDecodeError] = useState(null);
  const [copied, setCopied] = useState(false);
  const modalRef = useRef(null);
  const closeButtonRef = useRef(null);

  // Decode XDR client-side when modal opens or xdr changes
  useEffect(() => {
    if (!isOpen || !xdr) {
      setDecoded(null);
      setDecodeError(null);
      return;
    }
    try {
      setDecoded(decodeXdr(xdr));
      setDecodeError(null);
    } catch {
      setDecoded(null);
      setDecodeError('Could not decode XDR. Raw XDR is shown below.');
      setActiveTab('raw');
    }
  }, [isOpen, xdr]);

  // Focus trap and keyboard close
  useEffect(() => {
    if (!isOpen) return;
    closeButtonRef.current?.focus();

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const focusable = modalRef.current?.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const handleCopy = useCallback(() => {
    if (!xdr) return;
    navigator.clipboard.writeText(xdr).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [xdr]);

  if (!isOpen) return null;

  const resolvedHash = txHash || decoded?.hash;
  const explorerUrl = resolvedHash
    ? `https://stellar.expert/explorer/${NETWORK}/tx/${resolvedHash}`
    : null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="xdr-modal-title"
    >
      <div
        ref={modalRef}
        className="bg-gray-900 rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden shadow-2xl flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Code size={20} className="text-primary-400" />
            <h3 id="xdr-modal-title" className="text-lg font-bold text-white">
              Transaction XDR Inspector
            </h3>
          </div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            aria-label="Close modal"
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-800 flex-shrink-0">
          <button
            onClick={() => setActiveTab('decoded')}
            className={`px-5 py-3 text-sm font-medium transition-colors ${
              activeTab === 'decoded'
                ? 'text-primary-400 border-b-2 border-primary-400'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Decoded
          </button>
          <button
            onClick={() => setActiveTab('raw')}
            className={`px-5 py-3 text-sm font-medium transition-colors ${
              activeTab === 'raw'
                ? 'text-primary-400 border-b-2 border-primary-400'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Raw XDR
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto flex-1">
          {decodeError && (
            <div className="mb-4 p-3 bg-red-900/40 border border-red-700 rounded-lg text-sm text-red-300">
              {decodeError}
            </div>
          )}

          {activeTab === 'decoded' && decoded && (
            <div className="space-y-4">
              <div className="bg-gray-800 rounded-lg p-4">
                <p className="text-xs text-gray-400 mb-1">Source Account</p>
                <p className="text-sm text-white font-mono break-all">{decoded.sourceAccount}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-gray-800 rounded-lg p-4">
                  <p className="text-xs text-gray-400 mb-1">Fee</p>
                  <p className="text-sm text-white font-mono">
                    {decoded.fee} stroops
                    <span className="text-gray-400 ml-1">({decoded.feeXlm} XLM)</span>
                  </p>
                </div>
                <div className="bg-gray-800 rounded-lg p-4">
                  <p className="text-xs text-gray-400 mb-1">Sequence Number</p>
                  <p className="text-sm text-white font-mono">{decoded.sequence}</p>
                </div>
              </div>

              {decoded.memo && (
                <div className="bg-gray-800 rounded-lg p-4">
                  <p className="text-xs text-gray-400 mb-1">Memo</p>
                  <p className="text-sm text-white">{decoded.memo}</p>
                </div>
              )}

              <div className="bg-gray-800 rounded-lg p-4">
                <p className="text-xs text-gray-400 mb-2">
                  Operations ({decoded.operations.length})
                </p>
                <div className="space-y-3">
                  {decoded.operations.map((op, idx) => (
                    <div key={idx} className="bg-gray-900 rounded-lg p-3">
                      <p className="text-sm text-primary-400 font-semibold mb-1">{op.label}</p>
                      {op.sourceAccount && (
                        <p className="text-xs text-gray-500 mb-1">
                          Source: {op.sourceAccount}
                        </p>
                      )}
                      {Object.keys(op.details).length > 0 && (
                        <pre className="text-xs text-gray-300 overflow-x-auto mt-2">
                          {JSON.stringify(op.details, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {decoded.hash && (
                <div className="bg-gray-800 rounded-lg p-4">
                  <p className="text-xs text-gray-400 mb-1">Transaction Hash</p>
                  <p className="text-xs text-white font-mono break-all">{decoded.hash}</p>
                </div>
              )}

              {explorerUrl && (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-primary-400 hover:text-primary-300 transition-colors"
                >
                  <ExternalLink size={14} />
                  View on Stellar Expert
                </a>
              )}
            </div>
          )}

          {activeTab === 'raw' && (
            <div>
              {!xdr ? (
                <p className="text-center text-gray-500 py-8">No XDR data available</p>
              ) : (
                <pre className="text-xs text-gray-300 bg-gray-800 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-all">
                  {xdr}
                </pre>
              )}
            </div>
          )}

          {activeTab === 'decoded' && !decoded && !decodeError && (
            <p className="text-center text-gray-500 py-8">No XDR data available</p>
          )}
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-gray-800 flex gap-3 flex-shrink-0">
          <button
            onClick={handleCopy}
            disabled={!xdr}
            className="flex items-center gap-2 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl transition-colors text-sm"
          >
            {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
            {copied ? 'Copied!' : 'Copy XDR'}
          </button>
          <button
            onClick={onClose}
            className="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-xl transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
