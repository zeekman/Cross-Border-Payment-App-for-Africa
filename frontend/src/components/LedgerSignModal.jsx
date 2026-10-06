import React, { useState } from 'react';
import TransportWebUSB from '@ledgerhq/hw-transport-webusb';
import Str from '@ledgerhq/hw-app-str';
import { X, Usb, AlertTriangle, Eye } from 'lucide-react';
import toast from 'react-hot-toast';
import XDRInspectorModal from './XDRInspectorModal';

/**
 * LedgerSignModal
 * Prompts the user to review the decoded transaction (via XDRInspectorModal) and
 * then sign it on their Ledger device.
 *
 * Security: users MUST pass through the XDR decoded-operation view before the
 * "Sign Transaction" button becomes enabled, preventing "blind signing" attacks.
 *
 * @param {boolean}  show              - Whether the modal is visible
 * @param {function} onClose           - Callback to close the modal
 * @param {string}   xdr               - Unsigned transaction XDR
 * @param {string}   networkPassphrase - Stellar network passphrase
 * @param {function} onSigned          - Callback with signed XDR
 * @param {string}   [expectedAmount]  - Amount shown in the preceding flow (e.g. SendMoney),
 *                                       used to detect mismatches with the decoded XDR.
 * @param {string}   [expectedRecipient] - Recipient shown in the preceding flow, used
 *                                        to detect mismatches with the decoded XDR.
 */
const LEDGER_ERROR_MAP = {
  '0x6985': 'Transaction was rejected on your Ledger device.',
  '0x6982': 'Your Ledger device is locked. Please unlock it and try again.',
  '0x6700': 'Invalid data received. Make sure the Stellar app is open on your device.',
  '0x6a80': 'Invalid data. Make sure the Stellar app is up to date.',
  '0x6b00': 'Wrong parameters. Reconnect your Ledger and try again.',
  '0x6d00': 'Stellar app is not open on your Ledger device. Open it and try again.',
  '0x6e00': 'Unsupported command. Make sure the Stellar app is up to date.',
  '0x6f00': 'Unknown error from Ledger device. Reconnect and try again.',
  '0x6511': 'Device memory exhausted. Close other apps on your Ledger.',
};

function mapLedgerError(err) {
  const msg = err.message || '';
  if (msg.includes('denied by user')) return LEDGER_ERROR_MAP['0x6985'];
  if (msg.includes('locked')) return LEDGER_ERROR_MAP['0x6982'];
  const match = msg.match(/0x[0-9a-fA-F]{4}/);
  if (match && LEDGER_ERROR_MAP[match[0]]) return LEDGER_ERROR_MAP[match[0]];
  return 'Failed to sign with Ledger. Ensure the Stellar app is open and try again.';
}

/**
 * Attempt a lightweight decode of the XDR to extract the first payment operation's
 * amount and destination for mismatch checking.  Returns null on any decode failure
 * rather than throwing — callers must handle null gracefully.
 */
function tryDecodePaymentFields(xdr, networkPassphrase) {
  try {
    // Dynamic import is intentional here; stellar-sdk is a large dep and we only
    // need it for this narrow decode path.
    const StellarSdk = require('@stellar/stellar-sdk');
    const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, networkPassphrase);
    const op = tx.operations[0];
    if (!op) return null;
    if (op.type === 'payment') {
      return {
        amount: op.amount,
        recipient: op.destination,
      };
    }
    if (op.type === 'pathPaymentStrictReceive' || op.type === 'pathPaymentStrictSend') {
      return {
        amount: op.type === 'pathPaymentStrictReceive' ? op.destAmount : op.sendAmount,
        recipient: op.destination,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Normalise amounts to 7 dp strings for comparison, trimming trailing zeros. */
function normaliseAmount(v) {
  if (v == null) return '';
  const n = parseFloat(v);
  if (Number.isNaN(n)) return String(v).trim();
  return n.toFixed(7).replace(/\.?0+$/, '');
}

export default function LedgerSignModal({
  show,
  onClose,
  xdr,
  networkPassphrase,
  onSigned,
  expectedAmount,
  expectedRecipient,
}) {
  const [signing, setSigning] = useState(false);
  // Gate: user must open the inspector before the Sign button becomes active.
  const [inspectorOpened, setInspectorOpened] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  if (!show) return null;

  // Mismatch detection — only surfaces when caller provides expected values.
  let mismatch = null;
  if ((expectedAmount != null || expectedRecipient != null) && xdr) {
    const decoded = tryDecodePaymentFields(xdr, networkPassphrase);
    if (decoded) {
      const amountMismatch =
        expectedAmount != null &&
        normaliseAmount(decoded.amount) !== normaliseAmount(expectedAmount);
      const recipientMismatch =
        expectedRecipient != null &&
        decoded.recipient !== expectedRecipient;

      if (amountMismatch || recipientMismatch) {
        mismatch = {
          amountMismatch,
          recipientMismatch,
          decodedAmount: decoded.amount,
          decodedRecipient: decoded.recipient,
        };
      }
    }
  }

  const handleOpenInspector = () => {
    setInspectorOpen(true);
    setInspectorOpened(true);
  };

  const handleCloseInspector = () => {
    setInspectorOpen(false);
  };

  const handleSign = async () => {
    if (!inspectorOpened) return; // defensive — button is disabled anyway

    setSigning(true);
    try {
      const transport = await TransportWebUSB.create();
      const str = new Str(transport);

      const { signature } = await str.signTransaction(
        "44'/148'/0'",
        Buffer.from(xdr, 'base64')
      );

      const StellarSdk = await import('@stellar/stellar-sdk');
      const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, networkPassphrase);
      const keypair = StellarSdk.Keypair.fromPublicKey(signature.publicKey);
      tx.addSignature(keypair.publicKey(), signature.signature);

      const signedXDR = tx.toXDR();

      await transport.close();
      onSigned(signedXDR);
      toast.success('Transaction signed with Ledger');
    } catch (err) {
      console.error('Ledger signing error:', err);
      toast.error(mapLedgerError(err));
    } finally {
      setSigning(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Sign with Ledger</h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white transition-colors"
              aria-label="Close"
            >
              <X size={20} />
            </button>
          </div>

          <div className="space-y-4">
            {/* Mismatch warning — shown prominently if XDR fields differ from what
                the user saw earlier in the flow (e.g. SendMoney). */}
            {mismatch && (
              <div
                role="alert"
                className="flex items-start gap-3 bg-red-500/10 border border-red-500/50 rounded-lg p-4"
                data-testid="ledger-mismatch-warning"
              >
                <AlertTriangle size={20} className="text-red-400 shrink-0 mt-0.5" />
                <div className="text-sm text-red-300 space-y-1">
                  <p className="font-semibold text-red-200">⚠️ Transaction details mismatch</p>
                  <p>
                    The decoded XDR does not match the values shown earlier in this flow.
                    Do not sign until you have reviewed the transaction carefully.
                  </p>
                  {mismatch.amountMismatch && (
                    <p>
                      Amount — expected{' '}
                      <span className="font-mono text-white">{normaliseAmount(expectedAmount)}</span>
                      , XDR contains{' '}
                      <span className="font-mono text-white">{normaliseAmount(mismatch.decodedAmount)}</span>
                    </p>
                  )}
                  {mismatch.recipientMismatch && (
                    <p>
                      Recipient — expected{' '}
                      <span className="font-mono text-white break-all">{expectedRecipient}</span>
                      , XDR contains{' '}
                      <span className="font-mono text-white break-all">{mismatch.decodedRecipient}</span>
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Step 1: Review the transaction */}
            <div
              className={`flex items-start gap-3 rounded-lg p-4 border ${
                inspectorOpened
                  ? 'bg-green-500/10 border-green-500/30'
                  : 'bg-yellow-500/10 border-yellow-500/30'
              }`}
            >
              <Eye
                size={20}
                className={`shrink-0 mt-0.5 ${inspectorOpened ? 'text-green-400' : 'text-yellow-400'}`}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white mb-1">
                  Step 1 — Review the transaction
                </p>
                <p className="text-xs text-gray-400 mb-3">
                  You must review the decoded operations before signing. This protects
                  you from signing a transaction you did not intend to authorise.
                </p>
                <button
                  onClick={handleOpenInspector}
                  className="text-sm bg-gray-800 hover:bg-gray-700 text-white font-medium px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
                  data-testid="ledger-review-button"
                >
                  <Eye size={14} />
                  {inspectorOpened ? 'Review Again' : 'Review Transaction'}
                </button>
                {inspectorOpened && (
                  <p
                    className="text-xs text-green-400 mt-2"
                    data-testid="ledger-reviewed-indicator"
                  >
                    ✓ Transaction reviewed
                  </p>
                )}
              </div>
            </div>

            {/* Step 2: Connect and sign */}
            <div
              className={`flex items-start gap-3 rounded-lg p-4 border ${
                inspectorOpened
                  ? 'bg-blue-500/10 border-blue-500/30'
                  : 'bg-gray-800/50 border-gray-700 opacity-60'
              }`}
            >
              <Usb
                size={20}
                className={`shrink-0 mt-0.5 ${inspectorOpened ? 'text-blue-400' : 'text-gray-500'}`}
              />
              <p className="text-sm text-gray-300">
                Step 2 — Connect your Ledger device and open the Stellar app, then click
                Sign Transaction below.
              </p>
            </div>

            <ol className="text-sm text-gray-400 space-y-2 list-decimal list-inside">
              <li>Unlock your Ledger device</li>
              <li>Open the Stellar app</li>
              <li>Click &ldquo;Sign Transaction&rdquo; below</li>
              <li>Review and approve the transaction on your Ledger screen</li>
            </ol>

            <div className="flex gap-3 pt-2">
              <button
                onClick={onClose}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-white font-semibold py-3 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSign}
                disabled={signing || !inspectorOpened}
                title={!inspectorOpened ? 'You must review the transaction before signing' : undefined}
                className="flex-1 bg-primary-500 hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition-colors"
                data-testid="ledger-sign-button"
              >
                {signing ? 'Signing…' : 'Sign Transaction'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* XDR inspector — rendered outside the modal stack to avoid z-index issues */}
      <XDRInspectorModal
        isOpen={inspectorOpen}
        onClose={handleCloseInspector}
        xdr={xdr}
      />
    </>
  );
}
