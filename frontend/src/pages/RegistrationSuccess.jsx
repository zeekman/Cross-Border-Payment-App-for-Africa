import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { Mail, ArrowLeft, CheckCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function RegistrationSuccess() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { resendVerificationEmail } = useAuth();
  const [loading, setLoading] = useState(false);
  const [resent, setResent] = useState(false);

  // Get email from navigation state or URL
  const email = location.state?.email || new URLSearchParams(location.search).get('email');

  if (!email) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <p className="text-gray-600 dark:text-gray-400 mb-6">{t('common.error')}</p>
          <button
            onClick={() => navigate('/register')}
            className="text-primary-500 hover:underline"
          >
            {t('common.back')}
          </button>
        </div>
      </div>
    );
  }

  const handleResendEmail = async () => {
    setLoading(true);
    try {
      await resendVerificationEmail(email);
      setResent(true);
      toast.success(t('verifyEmail.resent_success'));
      setTimeout(() => setResent(false), 5000);
    } catch (err) {
      toast.error(err.response?.data?.error || t('verifyEmail.resent_error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col px-6 py-8 transition-colors duration-200">
      {/* Back button */}
      <button
        onClick={() => navigate('/')}
        className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white mb-6 flex items-center gap-1 transition-colors"
      >
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      {/* Main content */}
      <div className="flex-1 flex flex-col justify-center max-w-sm mx-auto w-full">
        {/* Icon */}
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 bg-primary-100 dark:bg-primary-900/30 rounded-full flex items-center justify-center">
            <CheckCircle size={32} className="text-primary-500" />
          </div>
        </div>

        {/* Heading */}
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white text-center mb-3">
          {t('verifyEmail.success_title')}
        </h1>

        {/* Email verification message */}
        <div className="bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-800 rounded-xl p-4 mb-6">
          <div className="flex items-start gap-3">
            <Mail size={20} className="text-primary-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm text-gray-700 dark:text-gray-300 mb-1">
                {t('verifyEmail.check_email')}
              </p>
              <p className="text-sm font-medium text-primary-600 dark:text-primary-400 break-all">
                {email}
              </p>
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
                {t('verifyEmail.check_spam')}
              </p>
            </div>
          </div>
        </div>

        {/* Description */}
        <p className="text-center text-gray-600 dark:text-gray-400 text-sm mb-8">
          {t('verifyEmail.description')}
        </p>

        {/* Resend button */}
        <button
          onClick={handleResendEmail}
          disabled={loading || resent}
          className={`w-full py-3.5 rounded-xl font-semibold transition-colors mb-3 ${
            resent
              ? 'bg-green-500 text-white'
              : 'bg-primary-500 hover:bg-primary-600 text-white disabled:opacity-50'
          }`}
        >
          {loading ? t('verifyEmail.sending') : resent ? t('verifyEmail.resent_sent') : t('verifyEmail.resend_button')}
        </button>

        {/* Divider */}
        <div className="flex items-center gap-3 mb-6">
          <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
          <span className="text-xs text-gray-500 dark:text-gray-400">{t('common.or')}</span>
          <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
        </div>

        {/* Go to login button */}
        <button
          onClick={() => navigate('/login')}
          className="w-full py-3.5 rounded-xl font-semibold text-primary-600 dark:text-primary-400 border border-primary-200 dark:border-primary-800 hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-colors"
        >
          {t('verifyEmail.go_to_login')}
        </button>

        {/* Help text */}
        <p className="text-center text-xs text-gray-500 dark:text-gray-500 mt-6">
          {t('verifyEmail.didnt_receive')}{' '}
          <a href="mailto:support@afripay.com" className="text-primary-500 hover:underline">
            {t('verifyEmail.contact_support')}
          </a>
        </p>
      </div>
    </div>
  );
}
