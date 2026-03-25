import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '../utils/api';

export default function ForgotPassword() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      toast.success(t('passwordReset.forgot_success_toast'));
    } catch (err) {
      const msg = err.response?.data?.errors?.[0]?.msg || err.response?.data?.error || t('passwordReset.error_generic');
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col px-6 py-8">
      <button type="button" onClick={() => navigate('/login')} className="text-gray-400 hover:text-white mb-6 flex items-center gap-1">
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      <div className="flex-1 flex flex-col justify-center max-w-sm mx-auto w-full">
        <div className="w-12 h-12 bg-primary-500 rounded-2xl flex items-center justify-center text-2xl mb-6">🔑</div>
        <h2 className="text-2xl font-bold text-white mb-1">{t('passwordReset.forgot_title')}</h2>
        <p className="text-gray-400 mb-8">{t('passwordReset.forgot_subtitle')}</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm text-gray-400 mb-1 block">{t('login.email')}</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
              placeholder="[email]"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-3.5 rounded-xl transition-colors"
          >
            {loading ? t('passwordReset.forgot_submitting') : t('passwordReset.forgot_submit')}
          </button>
        </form>

        <p className="text-center text-gray-500 mt-6 text-sm">
          <Link to="/login" className="text-primary-500 hover:underline">{t('passwordReset.back_to_login')}</Link>
        </p>
      </div>
    </div>
  );
}
