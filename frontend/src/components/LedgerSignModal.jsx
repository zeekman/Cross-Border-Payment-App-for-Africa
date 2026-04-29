import React, { useState } from 'react';
import TransportWebUSB from '@ledgerhq/hw-transport-webusb';
import Str from '@ledgerhq/hw-app-str';
import { X, Usb } from 'lucide-react';
import toast from 'react-hot-toast';

/**
 * LedgerSignModal
 * Prompts the user to connect their Ledger device and sign a transaction.
 * 
 * @param {boolean} show - Whether the modal is visible
 * @param {function} onClose - Callback to close the modal
 * @param {string} xdr - Unsigned transaction XDR
 * @param {string} networkPassphrase - Stellar network passphrase
 * @param {function} onSigned - Callback with signed XDR
 */
export default function LedgerSignModal({ show, onClose, xdr, networkPassphrase, onSigned }) {
  const [signing, setSigning] = useState(false);

  if (!show) return null;

  const handleSign = async () => {
    setSigning(true);
    try {
      // Connect to Ledger via WebUSB
      const transport = await TransportWebUSB.create();
      const str = new Str(transport);

      // Sign the transaction
      const { signature } = await str.signTransaction(
        "44'/148'/0'", // Default Stellar derivation path
        Buffer.from(xdr, 'base64')
      );

      // Attach signature to the transaction
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
      if (err.message.includes('denied')) {
        toast.error('Transaction rejected on Ledger');
      } else if (err.message.includes('locked')) {
        toast.error('Ledger is locked. Please unlock it and try again.');
      } else {
        toast.error('Failed to sign with Ledger. Ensure the Stellar app is open.');
      }
    } finally {
      setSigning(false);
    }
  };

  return (
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
          <div className="flex items-center gap-3 bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
            <Usb size={24} className="text-blue-400 shrink-0" />
            <p className="text-sm text-gray-300">
              Connect your Ledger device and open the Stellar app.
            </p>
          </div>

          <ol className="text-sm text-gray-400 space-y-2 list-decimal list-inside">
            <li>Unlock your Ledger device</li>
            <li>Open the Stellar app</li>
            <li>Click "Sign Transaction" below</li>
            <li>Review and approve the transaction on your Ledger</li>
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
              disabled={signing}
              className="flex-1 bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors"
            >
              {signing ? 'Signing...' : 'Sign Transaction'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
