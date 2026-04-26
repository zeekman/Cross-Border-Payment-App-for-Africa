import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import './index.css';
import './i18n';
import App from './App';
import { register as registerSW } from './serviceWorker';

Sentry.init({
  dsn: process.env.REACT_APP_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  enabled: !!process.env.REACT_APP_SENTRY_DSN,
  beforeSend(event) {
    // Scrub sensitive request/form data
    if (event.request?.data) {
      const scrubFields = ['password', 'secret', 'privateKey', 'token', 'pin'];
      scrubFields.forEach((field) => {
        if (event.request.data[field]) event.request.data[field] = '[Filtered]';
      });
    }
    return event;
  },
});

const fallback = (
  <div style={{ padding: '2rem', textAlign: 'center' }}>
    <h2>Something went wrong</h2>
    <p>Please refresh the page. If the problem persists, contact support.</p>
    <button onClick={() => window.location.reload()}>Refresh</button>
  </div>
);

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={fallback}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>
);

registerSW();
