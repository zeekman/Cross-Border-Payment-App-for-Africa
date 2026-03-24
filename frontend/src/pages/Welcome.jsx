import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Zap, Shield, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function Welcome() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const features = [
    { icon: Zap, title: t('welcome.feature_instant_title'), desc: t('welcome.feature_instant_desc') },
    { icon: Shield, title: t('welcome.feature_secure_title'), desc: t('welcome.feature_secure_desc') },
    { icon: Globe, title: t('welcome.feature_multi_title'), desc: t('welcome.feature_multi_desc') },
  ];

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-between px-6 py-12">
      {/* Hero */}
      <div className="flex-1 flex flex-col items-center justify-center text-center gap-6 max-w-sm">
        <div className="w-20 h-20 bg-primary-500 rounded-3xl flex items-center justify-center text-4xl shadow-lg shadow-primary-500/30">
          💸
        </div>
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">AfriPay</h1>
          <p className="text-gray-400 text-lg">{t('welcome.tagline')}</p>
        </div>

        <div className="w-full space-y-3 mt-4">
          {features.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="flex items-center gap-3 bg-gray-900 rounded-xl p-3 text-left">
              <div className="w-9 h-9 bg-primary-500/10 rounded-lg flex items-center justify-center text-primary-500 shrink-0">
                <Icon size={18} />
              </div>
              <div>
                <p className="text-sm font-medium text-white">{title}</p>
                <p className="text-xs text-gray-500">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* CTA */}
      <div className="w-full max-w-sm space-y-3">
        <button
          onClick={() => navigate('/register')}
          className="w-full bg-primary-500 hover:bg-primary-600 text-white font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-colors"
        >
          {t('welcome.get_started')} <ArrowRight size={18} />
        </button>
        <button
          onClick={() => navigate('/login')}
          className="w-full bg-gray-800 hover:bg-gray-700 text-white font-semibold py-3.5 rounded-xl transition-colors"
        >
          {t('welcome.have_account')}
        </button>
      </div>
    </div>
  );
}
