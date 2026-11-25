import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../utils/api';

// Handles both /verify-email (sign-up) and /verify-email-change (email change) links.
export default function VerifyEmail({ change = false }) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [status, setStatus] = useState('loading'); // loading | success | error
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [resent, setResent] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = params.get('token');
    // Strip the token from the address bar so it isn't kept in history.
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setStatus('error');
      setMessage(t('verifyEmail.missing', 'Verification link is invalid.'));
      return;
    }
    const endpoint = change ? '/auth/verify-email-change' : '/auth/verify-email';
    api.get(endpoint, { params: { token } })
      .then(({ data }) => { setStatus('success'); setMessage(data.message); })
      .catch((err) => {
        setStatus('error');
        setMessage(err.response?.data?.error || t('verifyEmail.invalid', 'This verification link is invalid or has expired.'));
      });
  }, [params, change, t]);

  const resend = async (e) => {
    e.preventDefault();
    try {
      await api.post('/auth/resend-verification', { email });
      setResent(true);
    } catch (err) {
      setMessage(err.response?.data?.error || t('verifyEmail.resend_failed', 'Could not resend the email.'));
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col justify-center px-6 py-8">
      <div className="max-w-sm mx-auto w-full text-center" aria-live="polite">
        {status === 'loading' && (
          <p className="text-gray-400" role="status">{t('verifyEmail.verifying', 'Verifying your email…')}</p>
        )}
        {status === 'success' && (
          <>
            <h2 className="text-2xl font-bold text-white mb-2">{t('verifyEmail.success_title', 'Email verified')}</h2>
            <p className="text-gray-400 mb-6">{message}</p>
            <Link to="/login" className="inline-block bg-primary-500 hover:bg-primary-600 rounded-xl px-6 py-3 text-white font-semibold">
              {t('verifyEmail.go_login', 'Go to login')}
            </Link>
          </>
        )}
        {status === 'error' && (
          <>
            <h2 className="text-2xl font-bold text-white mb-2">{t('verifyEmail.error_title', 'Verification failed')}</h2>
            <p role="alert" className="text-red-500 mb-6">{message}</p>
            {!change && (resent ? (
              <p className="text-gray-400">{t('verifyEmail.resent', 'If that account needs verifying, a new email is on its way.')}</p>
            ) : (
              <form onSubmit={resend} className="space-y-3">
                <label htmlFor="resend-email" className="text-sm text-gray-400 block text-left">{t('login.email', 'Email')}</label>
                <input
                  id="resend-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500"
                />
                <button type="submit" className="w-full bg-primary-500 hover:bg-primary-600 rounded-xl py-3 text-white font-semibold">
                  {t('verifyEmail.resend', 'Resend verification email')}
                </button>
              </form>
            ))}
            <Link to="/login" className="block mt-4 text-primary-400">{t('verifyEmail.go_login', 'Go to login')}</Link>
          </>
        )}
      </div>
    </div>
  );
}
