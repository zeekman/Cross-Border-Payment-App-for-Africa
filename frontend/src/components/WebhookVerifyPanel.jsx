import React, { useState } from 'react';
import { Copy, CheckCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

// Snippets are static on purpose: the secret is always read from the environment.
export const SNIPPETS = {
  'Node.js': `const crypto = require('crypto');

// rawBody must be the unparsed request body
function verify(rawBody, headers) {
  const parts = (headers['x-afripay-signature-v2'] || '').split(',').map((p) => p.trim());
  const ts = parts.find((p) => p.startsWith('t='))?.slice(2);
  if (!ts || ts !== headers['x-afripay-timestamp']) return false;
  if (!(Math.abs(Date.now() / 1000 - Number(ts)) <= 300)) return false;
  const expected = crypto
    .createHmac('sha256', process.env.AFRIPAY_WEBHOOK_SECRET)
    .update(\`\${ts}.\`).update(rawBody).digest();
  return parts.filter((p) => p.startsWith('v1=')).some((p) => {
    const sig = Buffer.from(p.slice(3), 'hex');
    return sig.length === expected.length && crypto.timingSafeEqual(sig, expected);
  });
}`,
  Python: `import hashlib, hmac, os, time

# raw_body must be the unparsed request bytes; headers is case-insensitive
def verify(raw_body, headers):
    parts = [p.strip() for p in headers.get("X-AfriPay-Signature-v2", "").split(",")]
    ts = next((p[2:] for p in parts if p.startswith("t=")), "")
    if not ts.isdecimal() or ts != headers.get("X-AfriPay-Timestamp"):
        return False
    if abs(time.time() - int(ts)) > 300:
        return False
    secret = os.environ["AFRIPAY_WEBHOOK_SECRET"].encode()
    expected = hmac.new(secret, ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(p[3:].encode(), expected.encode())
               for p in parts if p.startswith("v1="))`,
  PHP: `<?php
// $rawBody = file_get_contents('php://input')
function verify(string $rawBody, array $server): bool {
    $parts = array_map('trim', explode(',', $server['HTTP_X_AFRIPAY_SIGNATURE_V2'] ?? ''));
    $ts = '';
    foreach ($parts as $p) {
        if (strpos($p, 't=') === 0) $ts = substr($p, 2);
    }
    if (!ctype_digit($ts) || $ts !== ($server['HTTP_X_AFRIPAY_TIMESTAMP'] ?? '')) return false;
    if (abs(time() - (int) $ts) > 300) return false;
    $expected = hash_hmac('sha256', $ts . '.' . $rawBody, getenv('AFRIPAY_WEBHOOK_SECRET'));
    foreach ($parts as $p) {
        if (strpos($p, 'v1=') === 0 && hash_equals($expected, substr($p, 3))) return true;
    }
    return false;
}`,
};

const HEADERS = {
  'X-AfriPay-Event-Id': 'eventId',
  'X-AfriPay-Delivery-Id': 'deliveryId',
  'X-AfriPay-Timestamp': 'timestamp',
  'X-AfriPay-Signature-v2': 'signature',
};

export default function WebhookVerifyPanel() {
  const { t } = useTranslation();
  const [tab, setTab] = useState('Node.js');
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(SNIPPETS[tab]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('webhooks.copyFailed'));
    }
  };

  return (
    <section className="bg-gray-900 rounded-2xl p-5 space-y-4" aria-labelledby="verify-title">
      <h3 id="verify-title" className="text-white font-semibold">{t('webhookVerify.title')}</h3>
      <dl className="space-y-2 text-xs">
        {Object.entries(HEADERS).map(([header, key]) => (
          <div key={header}>
            <dt className="font-mono text-gray-300">{header}</dt>
            <dd className="text-gray-500">{t(`webhookVerify.${key}`)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-gray-400">{t('webhookVerify.tolerance')}</p>
      <p className="text-xs text-gray-400">{t('webhookVerify.dedupe')}</p>
      <div className="flex items-center gap-2">
        <div role="tablist" aria-label={t('webhookVerify.title')} className="flex gap-2 flex-1">
          {Object.keys(SNIPPETS).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              onClick={() => { setTab(name); setCopied(false); }}
              className={`text-xs px-2 py-1 rounded-lg ${tab === name ? 'bg-primary-500 text-white' : 'bg-gray-800 text-gray-400'}`}
            >
              {name}
            </button>
          ))}
        </div>
        <button type="button" onClick={copy} aria-label={t('webhookVerify.copy')} className="text-gray-400 hover:text-white">
          {copied ? <CheckCheck size={16} /> : <Copy size={16} />}
        </button>
      </div>
      <pre role="tabpanel" className="bg-gray-800 rounded-xl p-3 text-xs text-gray-300 overflow-x-auto"><code>{SNIPPETS[tab]}</code></pre>
    </section>
  );
}
