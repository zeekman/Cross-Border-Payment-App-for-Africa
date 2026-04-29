import React, { useState, useMemo } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { Eye, EyeOff, ArrowLeft, ChevronDown, ChevronUp, Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

function getPasswordStrength(password) {
  const checks = {
    length: password.length >= 8,
    uppercase: /[A-Z]/.test(password),
    number: /[0-9]/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
  };
  const score = Object.values(checks).filter(Boolean).length;
  const levels = ['', 'weak', 'fair', 'strong', 'very strong'];
  const colors = ['', 'bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-green-500'];
  const textColors = ['', 'text-red-500', 'text-orange-500', 'text-yellow-500', 'text-green-500'];
  return { checks, score, label: levels[score], barColor: colors[score], textColor: textColors[score] };
}

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const [form, setForm] = useState({ full_name: '', email: '', password: '', phone: '' });
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showPINSetup, setShowPINSetup] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [secretKey, setSecretKey] = useState('');

  const strength = useMemo(() => getPasswordStrength(form.password), [form.password]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const payload = { ...form };
      if (showImport && secretKey) payload.secret_key = secretKey;
      const refCode = searchParams.get('ref');
      if (refCode) payload.referral_code = refCode;
      await register(payload);
      toast.success(t('register.success'));
      setShowPINSetup(true);
      navigate('/login');
    } catch (err) {
      toast.error(err.response?.data?.error || t('register.error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col px-6 py-8 transition-colors duration-200">
      <button onClick={() => navigate('/')} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white mb-6 flex items-center gap-1 transition-colors">
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      <div className="flex-1 flex flex-col justify-center max-w-sm mx-auto w-full">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">{t('register.title')}</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-8">{t('register.subtitle')}</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm text-gray-600 dark:text-gray-400 mb-1 block">{t('register.full_name')}</label>
            <input
              type="text"
              required
              placeholder="[Full Name]"
              value={form.full_name}
              onChange={e => setForm({ ...form, full_name: e.target.value })}
              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600 dark:text-gray-400 mb-1 block">{t('register.email')}</label>
            <input
              type="email"
              required
              placeholder="[email]"
              value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })}
              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600 dark:text-gray-400 mb-1 block">{t('register.phone')}</label>
            <input
              type="tel"
              placeholder="+234..."
              value={form.phone}
              onChange={e => setForm({ ...form, phone: e.target.value })}
              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors shadow-sm"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600 dark:text-gray-400 mb-1 block">{t('register.password')}</label>
            <div className="relative">
              <input
                type={showPass ? 'text' : 'password'}
                required
                minLength={8}
                placeholder={t('register.password_placeholder')}
                value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })}
                className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors pr-12 shadow-sm"
              />
              <button type="button" onClick={() => setShowPass(!showPass)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-white transition-colors">
                {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {form.password && (
              <div className="mt-2 space-y-2">
                <div className="flex gap-1">
                  {[1, 2, 3, 4].map(i => (
                    <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i <= strength.score ? strength.barColor : 'bg-gray-200 dark:bg-gray-700'}`} />
                  ))}
                </div>
                <p className={`text-xs font-medium capitalize ${strength.textColor}`}>{strength.label}</p>
                <ul className="space-y-1">
                  {[
                    { key: 'length', label: 'At least 8 characters' },
                    { key: 'uppercase', label: 'One uppercase letter' },
                    { key: 'number', label: 'One number' },
                    { key: 'special', label: 'One special character' },
                  ].map(({ key, label }) => (
                    <li key={key} className={`flex items-center gap-1.5 text-xs ${strength.checks[key] ? 'text-green-500' : 'text-gray-400 dark:text-gray-500'}`}>
                      {strength.checks[key] ? <Check size={12} /> : <X size={12} />} {label}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || strength.score < 2}
            className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-3.5 rounded-xl transition-colors mt-2"
          >
            {loading ? t('register.submitting') : t('register.submit')}
          </button>

          {/* Import existing wallet */}
          <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => { setShowImport(v => !v); setSecretKey(''); }}
              className="w-full flex items-center justify-between px-4 py-3 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <span>Already have a Stellar wallet? Import it</span>
              {showImport ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {showImport && (
              <div className="px-4 pb-4 space-y-2 bg-gray-50 dark:bg-gray-800/50">
                <p className="text-xs text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-500/10 border border-yellow-200 dark:border-yellow-500/30 rounded-lg p-2">
                  ⚠ Your secret key will be encrypted and stored securely. Never share it with anyone.
                </p>
                <input
                  type="password"
                  placeholder="Stellar secret key (starts with S…)"
                  value={secretKey}
                  onChange={e => setSecretKey(e.target.value)}
                  className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-900 dark:text-white placeholder-gray-400 font-mono text-sm focus:outline-none focus:border-primary-500 transition-colors"
                />
              </div>
            )}
          </div>
        </form>

        <p className="text-center text-gray-500 mt-6 text-sm">
          {t('register.have_account')}{' '}
          <Link to="/login" className="text-primary-500 hover:underline">{t('register.sign_in')}</Link>
        </p>
      </div>
    </div>
  );
}
