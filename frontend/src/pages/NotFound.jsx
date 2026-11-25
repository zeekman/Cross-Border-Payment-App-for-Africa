import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as Sentry from '@sentry/react';

/**
 * NotFound (404) page rendered by the catch-all route in App.jsx.
 * Reports the unknown path to Sentry as a breadcrumb so missing routes
 * (e.g. backend-emitted links the frontend doesn't implement) are noticed.
 */
export default function NotFound() {
  const { t } = useTranslation();
  const location = useLocation();

  useEffect(() => {
    Sentry.addBreadcrumb({
      category: 'navigation',
      level: 'warning',
      message: `404: ${location.pathname}`,
      data: { path: location.pathname, search: location.search },
    });
  }, [location.pathname, location.search]);

  return (
    <div className="not-found" role="alert">
      <h1>{t('shared.notFoundTitle', '404 — Page not found')}</h1>
      <p>
        {t('shared.notFoundBody', 'We couldn\'t find')} <code>{location.pathname}</code>. {t('shared.notFoundHint', 'It may have been moved or the link may be out of date.')}
      </p>
      <nav>
        <Link to="/">{t('shared.goDashboard', 'Go to Dashboard')}</Link>
        {' · '}
        <Link to="/login">{t('shared.goLogin', 'Go to Login')}</Link>
      </nav>
    </div>
  );
}
