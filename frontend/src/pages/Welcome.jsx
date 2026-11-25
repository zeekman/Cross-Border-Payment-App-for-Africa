import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';

const SLIDES = [
  {
    emoji: '🌍',
    title: 'Send money across Africa in seconds',
    desc: 'Instant cross-border transfers to 50+ African countries with real-time confirmation.',
  },
  {
    emoji: '💸',
    title: 'Low fees powered by Stellar blockchain',
    desc: 'Pay up to 10x less in fees compared to traditional remittance services.',
  },
  {
    emoji: '🔒',
    title: 'Secure escrow payments',
    desc: 'Funds are held safely in smart-contract escrow until both parties confirm delivery.',
  },
  {
    emoji: '🎁',
    title: 'Earn loyalty points with every transfer',
    desc: 'Collect AfriPay points on every transaction and redeem them for fee discounts.',
  },
];

const AUTO_ADVANCE_MS = 4000;

export default function Welcome() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { user, updateUser } = useAuth();

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const [slide, setSlide] = useState(0);
  const [showCTA, setShowCTA] = useState(false);
  const timerRef = useRef(null);
  const touchStartX = useRef(null);

  const goTo = useCallback((index) => {
    if (index >= SLIDES.length) {
      setShowCTA(true);
      return;
    }
    setSlide(Math.max(0, Math.min(index, SLIDES.length - 1)));
  }, []);

  useEffect(() => {
    if (showCTA) return;
    timerRef.current = setTimeout(() => goTo(slide + 1), AUTO_ADVANCE_MS);
    return () => clearTimeout(timerRef.current);
  }, [slide, showCTA, goTo]);

  useEffect(() => {
    if (showCTA) return;
    function onKey(e) {
      if (e.key === 'ArrowRight') { clearTimeout(timerRef.current); goTo(slide + 1); }
      if (e.key === 'ArrowLeft')  { clearTimeout(timerRef.current); goTo(slide - 1); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slide, showCTA, goTo]);

  function onTouchStart(e) { touchStartX.current = e.touches[0].clientX; }
  function onTouchEnd(e) {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 30) return;
    clearTimeout(timerRef.current);
    goTo(dx < 0 ? slide + 1 : slide - 1);
  }

  function handleGetStarted() {
    if (user) {
      // Onboarding completion is a per-account fact stored on the server.
      // Update local state optimistically so a transient network failure
      // doesn't trap the user on this screen.
      api.post('/auth/onboarding-completed').catch(() => {});
      updateUser({ onboarding_completed: true });
      navigate('/dashboard');
      return;
    }
    navigate('/register');
  }

  function handleSkip() {
    clearTimeout(timerRef.current);
    setShowCTA(true);
  }

  const transitionClass = prefersReduced ? '' : 'transition-all duration-500';

  if (showCTA) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col items-center justify-center px-6 py-12 transition-colors duration-200">
        <div className="flex flex-col items-center text-center gap-6 mb-12">
          <div className="w-20 h-20 bg-primary-500 rounded-3xl flex items-center justify-center text-4xl shadow-lg shadow-primary-500/30">
            💸
          </div>
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">AfriPay</h1>
            <p className="text-gray-600 dark:text-gray-400 text-lg">{t('welcome.tagline')}</p>
          </div>
        </div>
        <div className="w-full max-w-sm space-y-3">
          <button
            onClick={handleGetStarted}
            className="w-full bg-primary-500 hover:bg-primary-600 text-white font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-colors"
          >
            {t('welcome.get_started')} <ArrowRight size={18} />
          </button>
          {!user && (
            <button
              onClick={() => navigate('/login')}
              className="w-full bg-white hover:bg-gray-50 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-900 dark:text-white border border-gray-200 dark:border-gray-700 font-semibold py-3.5 rounded-xl transition-colors shadow-sm"
            >
              {t('welcome.have_account')}
            </button>
          )}
        </div>
      </div>
    );
  }

  const current = SLIDES[slide];

  return (
    <div
      className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col px-6 py-12 select-none transition-colors duration-200"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="flex justify-end">
        <button
          onClick={handleSkip}
          className="text-sm font-medium text-primary-500 hover:text-primary-600 py-1 px-3 rounded-lg transition-colors"
        >
          Skip
        </button>
      </div>

      <div className={`flex-1 flex flex-col items-center justify-center text-center gap-6 max-w-sm mx-auto w-full ${transitionClass}`}>
        <div className="w-24 h-24 bg-primary-500/10 rounded-3xl flex items-center justify-center text-5xl">
          {current.emoji}
        </div>
        <div className="space-y-3">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">{current.title}</h2>
          <p className="text-gray-500 dark:text-gray-400 text-base leading-relaxed">{current.desc}</p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-6 mt-8">
        <div className="flex gap-2 items-center">
          {SLIDES.map((_, i) => (
            <button
              key={i}
              onClick={() => { clearTimeout(timerRef.current); goTo(i); }}
              aria-label={`Go to slide ${i + 1}`}
              className={`rounded-full ${transitionClass} ${
                i === slide
                  ? 'w-6 h-2.5 bg-primary-500'
                  : 'w-2.5 h-2.5 bg-gray-300 dark:bg-gray-600'
              }`}
            />
          ))}
        </div>

        <div className="flex w-full max-w-sm gap-3">
          <button
            onClick={() => { clearTimeout(timerRef.current); goTo(slide - 1); }}
            disabled={slide === 0}
            className="p-3 rounded-xl border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 disabled:opacity-30 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label="Previous slide"
          >
            <ChevronLeft size={20} />
          </button>
          <button
            onClick={() => { clearTimeout(timerRef.current); goTo(slide + 1); }}
            className="flex-1 bg-primary-500 hover:bg-primary-600 text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2 transition-colors"
          >
            {slide === SLIDES.length - 1 ? 'Get Started' : 'Next'} <ArrowRight size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
