import React, { useEffect, useState } from 'react';
import { AlertTriangle, BadgeCheck, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useVisibleInterval } from '../hooks/useVisibleInterval';

const remainingMs = (expiresAt) => new Date(expiresAt).getTime() - Date.now();

function formatRemaining(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const clock = [Math.floor((total % 86400) / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  return d > 0 ? `${d}d ${clock}` : clock;
}

/** Shows who is asking for money on /send?request=<id>. */
export default function RequesterCard({ requester, expiresAt, isContact, onExpire }) {
  const { t, i18n } = useTranslation();
  const [remaining, setRemaining] = useState(() => remainingMs(expiresAt));
  useVisibleInterval(() => setRemaining(remainingMs(expiresAt)), expiresAt ? 1000 : null);

  const expired = !!expiresAt && remaining <= 0;
  useEffect(() => {
    if (expired) onExpire?.();
  }, [expired]); // eslint-disable-line react-hooks/exhaustive-deps -- fire once on expiry

  const since = requester?.member_since ? new Date(requester.member_since) : null;
  return (
    <div className="mb-4 space-y-3">
      <section aria-label={t('paymentRequest.requestedBy')} className="bg-gray-900 rounded-xl p-4">
        <div className="flex items-center gap-3">
          {requester?.avatar_url ? (
            <img src={requester.avatar_url} alt="" className="w-12 h-12 rounded-full object-cover" />
          ) : (
            <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center text-gray-400">
              <User size={22} aria-hidden="true" />
            </div>
          )}
          <div className="min-w-0">
            <p className="text-xs text-gray-400">{t('paymentRequest.requestedBy')}</p>
            <p className="text-white font-semibold break-words">
              {requester?.display_name || t('paymentRequest.unknown')}
              {requester?.kyc_verified === true && (
                <span className="ml-2 inline-flex items-center gap-1 text-xs text-green-400">
                  <BadgeCheck size={14} aria-hidden="true" /> {t('paymentRequest.verified')}
                </span>
              )}
            </p>
            {since && !Number.isNaN(since.getTime()) && (
              <p className="text-xs text-gray-400">
                {t('paymentRequest.memberSince', {
                  date: since.toLocaleDateString(i18n.language, { year: 'numeric', month: 'long' }),
                })}
              </p>
            )}
          </div>
        </div>
        {expiresAt && (
          <p className="mt-3 text-xs text-gray-400" role="timer">
            {t('paymentRequest.expiresIn', { time: formatRemaining(remaining) })}
          </p>
        )}
      </section>
      {!isContact && (
        <div role="note" className="flex gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm text-amber-400">
          <AlertTriangle size={18} className="shrink-0" aria-hidden="true" />
          {t('paymentRequest.notContact')}
        </div>
      )}
    </div>
  );
}
