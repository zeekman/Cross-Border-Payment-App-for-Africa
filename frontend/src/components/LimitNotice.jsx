import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatAmount } from '../utils/currency';

export default function LimitNotice({ limits, overLimit }) {
  const { i18n } = useTranslation();
  if (!limits || limits.max == null) return null;
  const locale = i18n?.language;
  const fmt = (n) => formatAmount(n, limits.currency, locale);
  const capPeriod =
    limits.max === limits.dailyRemaining ? limits.daily : limits.max === limits.monthlyRemaining ? limits.monthly : null;
  const nextDaily = limits.next_tier_daily_limit;
  return (
    <div className="mt-2 space-y-2 text-xs">
      <p className="text-gray-400">
        You can send up to {fmt(limits.max)}
        {capPeriod === limits.monthly && capPeriod ? ' more this month' : capPeriod ? ' more today' : ' per payment'}
        {capPeriod?.resets_at && `. Resets ${new Date(capPeriod.resets_at).toLocaleString(locale)}`}
      </p>
      {overLimit && (
        <p role="alert" className="text-red-400">
          This amount is above your remaining limit of {fmt(limits.max)}.
        </p>
      )}
      {overLimit && limits.required_kyc_tier_for_more != null && (
        <div className="rounded-xl border border-primary-500/40 bg-primary-500/10 p-3">
          <Link to="/kyc" className="text-primary-400 underline">
            {nextDaily != null ? `Verify your ID to send up to ${fmt(nextDaily)}/day` : 'Verify your ID to raise your limit'}
          </Link>
        </div>
      )}
    </div>
  );
}
