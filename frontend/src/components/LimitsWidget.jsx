import { useTranslation } from 'react-i18next';
import { useLimits } from '../hooks/useLimits';
import { formatAmount } from '../utils/currency';

export default function LimitsWidget() {
  const { i18n } = useTranslation();
  const limits = useLimits();
  if (!limits) return null;
  const fmt = (n) => formatAmount(n, limits.currency, i18n?.language);
  return (
    <p className="text-primary-200 text-xs mb-3" data-testid="limits-widget">
      {[
        limits.dailyRemaining != null && `${fmt(limits.dailyRemaining)} left today`,
        limits.monthlyRemaining != null && `${fmt(limits.monthlyRemaining)} left this month`,
      ]
        .filter(Boolean)
        .join(' · ')}
    </p>
  );
}
