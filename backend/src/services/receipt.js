'use strict';

/**
 * BE-226: single-transaction payment receipt (PDF / PNG QR / JSON).
 * FX values come from the transaction's send-time fx_snapshot (BE-227),
 * never from the current oracle rate.
 */

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { fiatValueAtSend } = require('../utils/txSnapshots');

const STRINGS = {
  en: {
    title: 'Payment Receipt', reference: 'Reference', status: 'Status', date: 'Ledger close time',
    from: 'From', to: 'To', amount: 'Amount', fiat: 'Value at send time', rate: 'FX rate',
    rateUnavailable: 'rate unavailable', fees: 'Fees', platformFee: 'Platform fee',
    networkFee: 'Network fee', memo: 'Memo', hash: 'Transaction hash', verify: 'Scan to verify on Stellar Expert',
  },
  fr: {
    title: 'Reçu de paiement', reference: 'Référence', status: 'Statut', date: 'Clôture du ledger',
    from: 'De', to: 'À', amount: 'Montant', fiat: "Valeur à l'envoi", rate: 'Taux de change',
    rateUnavailable: 'taux indisponible', fees: 'Frais', platformFee: 'Frais de plateforme',
    networkFee: 'Frais réseau', memo: 'Mémo', hash: 'Hash de transaction', verify: 'Scannez pour vérifier sur Stellar Expert',
  },
};

function pickLocale(acceptLanguage) {
  const lang = String(acceptLanguage || 'en').slice(0, 2).toLowerCase();
  return STRINGS[lang] ? lang : 'en';
}

function truncate(addr) {
  return addr && addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr || '';
}

function explorerUrl(hash) {
  const network = (process.env.STELLAR_NETWORK || 'testnet').toLowerCase() === 'mainnet' ? 'public' : 'testnet';
  return hash ? `https://stellar.expert/explorer/${network}/tx/${hash}` : null;
}

/** Build the receipt data model shared by all formats. */
function buildReceipt(tx, { fiat = 'USD', senderName, recipientName } = {}) {
  const fee = tx.fee_snapshot || tx.fee_breakdown || null;
  const currency = String(fiat).toUpperCase();
  return {
    reference: String(tx.id).split('-')[0].toUpperCase(),
    transaction_id: tx.id,
    status: tx.status,
    ledger_close_time: tx.ledger_close_time || tx.created_at,
    sender: { display_name: senderName || null, address: tx.sender_wallet, short: truncate(tx.sender_wallet) },
    recipient: { display_name: recipientName || null, address: tx.recipient_wallet, short: truncate(tx.recipient_wallet) },
    amount: tx.amount,
    asset: tx.asset,
    fiat: {
      currency,
      value: fiatValueAtSend(tx, currency),
      rate: tx.fx_snapshot?.rates?.[currency] ?? null,
      rate_captured_at: tx.fx_snapshot?.captured_at ?? null,
      rate_source: tx.fx_snapshot?.source ?? null,
    },
    fees: fee ? {
      platform_fee: fee.platform_fee_usdc ?? null,
      platform_fee_bps: fee.platform_fee_bps ?? null,
      network_fee_xlm: fee.stellar_base_fee_xlm ?? null,
    } : null,
    memo: tx.memo || null,
    tx_hash: tx.tx_hash || null,
    verify_url: explorerUrl(tx.tx_hash),
  };
}

async function renderPng(receipt) {
  return QRCode.toBuffer(receipt.verify_url || receipt.transaction_id, { type: 'png', width: 320, margin: 2 });
}

async function renderPdf(receipt, locale = 'en') {
  const t = STRINGS[locale] || STRINGS.en;
  const qr = await renderPng(receipt);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 36, info: { Title: `AfriPay ${t.title} ${receipt.reference}` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).fillColor('#0a7d4f').text('AfriPay', { continued: false });
    doc.fontSize(14).fillColor('#111').text(t.title).moveDown(0.5);

    const row = (label, value) => {
      doc.fontSize(9).fillColor('#666').text(label);
      doc.fontSize(11).fillColor('#111').text(value == null || value === '' ? '—' : String(value)).moveDown(0.3);
    };
    const party = (p) => (p.display_name ? `${p.display_name} (${p.short})` : p.short);

    row(t.reference, receipt.reference);
    row(t.status, receipt.status);
    row(t.date, receipt.ledger_close_time ? new Date(receipt.ledger_close_time).toISOString() : null);
    row(t.from, party(receipt.sender));
    row(t.to, party(receipt.recipient));
    row(t.amount, `${receipt.amount} ${receipt.asset}`);
    row(t.fiat, receipt.fiat.value == null ? t.rateUnavailable : `${receipt.fiat.value} ${receipt.fiat.currency}`);
    if (receipt.fiat.rate != null) {
      row(t.rate, `1 ${receipt.asset} = ${receipt.fiat.rate} ${receipt.fiat.currency} (${receipt.fiat.rate_captured_at || ''})`);
    }
    if (receipt.fees) {
      row(t.platformFee, receipt.fees.platform_fee != null ? `${receipt.fees.platform_fee} (${receipt.fees.platform_fee_bps} bps)` : null);
      row(t.networkFee, receipt.fees.network_fee_xlm != null ? `${receipt.fees.network_fee_xlm} XLM` : null);
    }
    if (receipt.memo) row(t.memo, receipt.memo);
    row(t.hash, receipt.tx_hash);

    doc.image(qr, { width: 110 });
    doc.fontSize(8).fillColor('#666').text(t.verify);
    doc.end();
  });
}

module.exports = { buildReceipt, renderPdf, renderPng, pickLocale, explorerUrl, STRINGS };
