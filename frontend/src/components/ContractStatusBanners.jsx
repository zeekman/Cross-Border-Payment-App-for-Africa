import React, { useState } from 'react';
import { AlertTriangle, Info, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RELEASE_NOTES_URL } from '../config/network';

const EXIT_PATHS = {
  escrow: '/escrow',
  agentEscrow: '/escrow',
  savingsVault: '/save',
  recurringPayments: '/scheduled',
};

const dismissKey = (name, hash) => `afripay_upgrade_dismissed_${name}_${hash}`;

function isDismissed(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

// The ETA may be unix seconds (number or numeric string) or an ISO date.
function formatEta(eta, language) {
  const date = new Date(/^\d+$/.test(String(eta)) ? Number(eta) * 1000 : eta);
  return eta == null || Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function ContractStatusBanners({ states, showPaused = true }) {
  const { t, i18n } = useTranslation();
  const [dismissed, setDismissed] = useState({});

  const dismiss = (key) => {
    try {
      localStorage.setItem(key, '1');
    } catch {
      // Storage unavailable: dismiss for this view only.
    }
    setDismissed((prev) => ({ ...prev, [key]: true }));
  };

  return (
    <>
      {Object.entries(states).map(([name, state]) => {
        const upgrade = state?.pending_upgrade;
        const key = upgrade && dismissKey(name, upgrade.hash);
        const eta = upgrade && formatEta(upgrade.eta, i18n.language);
        return (
          <React.Fragment key={name}>
            {showPaused && state?.paused === true && (
              <div role="alert" className="flex gap-2 mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-sm text-red-400">
                <AlertTriangle size={18} className="shrink-0" aria-hidden="true" />
                {t(`contractStatus.paused.${name}`)}
              </div>
            )}
            {upgrade && !dismissed[key] && !isDismissed(key) && (
              <div role="status" className="flex gap-2 mb-4 p-3 rounded-xl bg-blue-500/10 border border-blue-500/30 text-sm text-blue-400">
                <Info size={18} className="shrink-0" aria-hidden="true" />
                <div className="flex-1">
                  <p>
                    {t(eta ? 'contractStatus.upgrade' : 'contractStatus.upgradeNoEta', {
                      contract: t(`contractStatus.names.${name}`),
                      eta,
                    })}
                  </p>
                  <div className="flex flex-wrap gap-4 mt-1">
                    <a href={RELEASE_NOTES_URL} target="_blank" rel="noopener noreferrer" className="underline">
                      {t('contractStatus.releaseNotes')}
                    </a>
                    <Link to={EXIT_PATHS[name]} className="underline">{t('contractStatus.exit')}</Link>
                  </div>
                </div>
                <button type="button" onClick={() => dismiss(key)} aria-label={t('contractStatus.dismiss')} className="self-start">
                  <X size={16} />
                </button>
              </div>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}
