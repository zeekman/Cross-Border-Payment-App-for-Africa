import React, { useState, useEffect } from 'react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, NavLink, useNavigate, useLocation, useMatch } from 'react-router-dom';
import { LayoutDashboard, Send, Download, Clock, Upload, User, LogOut, Sun, Moon, Bell, BellOff, AlertTriangle, ArrowUpDown, PiggyBank, Lock, Shield, MoreHorizontal, Layers, BarChart2, CalendarClock, Gift, Webhook, Briefcase } from 'lucide-react';
import { useAuth, logoutState } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { useStellarStatus } from '../hooks/useStellarStatus';
import NotificationBell from './NotificationBell';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Home' },
  { to: '/send', icon: Send, label: 'Send' },
  { to: '/receive', icon: Download, label: 'Receive' },
  { to: '/history', icon: Clock, label: 'History' },
];

const moreItems = [
  { to: '/swap', icon: ArrowUpDown, label: 'Swap' },
  { to: '/save', icon: PiggyBank, label: 'Save' },
  { to: '/escrow', icon: Lock, label: 'Escrow' },
  { to: '/batch-payments', icon: Layers, label: 'Batch' },
  { to: '/scheduled', icon: CalendarClock, label: 'Scheduled' },
  { to: '/analytics', icon: BarChart2, label: 'Analytics' },
  { to: '/referrals', icon: Gift, label: 'Referrals' },
  { to: '/webhooks', icon: Webhook, label: 'Webhooks' },
  { to: '/business', icon: Briefcase, label: 'Business' },
  { to: '/profile', icon: User, label: 'Profile' },
  { to: '/dashboard', icon: LayoutDashboard, labelKey: 'nav.dashboard' },
  { to: '/send', icon: Send, labelKey: 'nav.send' },
  { to: '/swap', icon: ArrowUpDown, labelKey: 'nav.swap' },
  { to: '/save', icon: PiggyBank, labelKey: 'nav.save' },
  { to: '/receive', icon: Download, labelKey: 'nav.receive' },
  { to: '/escrow', icon: Lock, labelKey: 'nav.escrow' },
  { to: '/history', icon: Clock, labelKey: 'nav.history' },
  { to: '/profile', icon: User, labelKey: 'nav.profile' },
];

const isTestnet = process.env.REACT_APP_STELLAR_NETWORK !== 'mainnet';

function NavItem({ to, icon: Icon, labelKey, user }) {
  const { t } = useTranslation();
  const match = useMatch(to);
  const isActive = !!match;

  return (
    <NavLink
      to={to}
      aria-current={isActive ? 'page' : undefined}
      className={({ isActive: innerActive }) =>
        `flex flex-col items-center gap-0.5 min-w-[44px] min-h-[44px] justify-center px-2 py-1 rounded-lg transition-colors text-xs ${
          innerActive
            ? 'text-primary-500 font-semibold'
            : 'text-gray-500 hover:text-gray-300'
        }`
      }
    >
      {({ isActive: innerActive }) => (
        <>
          {to === '/profile' && user ? (
            <div className={`w-5 h-5 rounded-full overflow-hidden flex items-center justify-center text-[10px] font-bold ${innerActive ? 'ring-2 ring-primary-500' : ''} ${user.avatar_url ? '' : 'bg-primary-500 text-white'}`}>
              {user.avatar_url
                ? <img src={user.avatar_url} alt="avatar" className="w-full h-full object-cover" />
                : user.full_name?.[0]?.toUpperCase()
              }
            </div>
          ) : (
            <Icon size={20} strokeWidth={innerActive ? 2.5 : 1.75} />
          )}
          <span>{t(labelKey)}</span>
        </>
      )}
    </NavLink>
  );
}

export default function Layout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const { supported, subscribed, loading, subscribe, unsubscribe } = usePushNotifications();
  const { isDegraded, status } = useStellarStatus();

  const [loggingOut, setLoggingOut] = useState(false);
  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
      navigate('/', { replace: true });
    } finally {
      logoutState.active = false;
      setLoggingOut(false);
    }
  };

  const [moreOpen, setMoreOpen] = useState(false);
  const sheetItems = user?.role === 'admin'
    ? [...moreItems, { to: '/admin', icon: Shield, label: 'Admin' }]
    : moreItems;
  const moreActive = sheetItems.some(({ to }) => location.pathname === to || location.pathname.startsWith(`${to}/`));

  useEffect(() => { setMoreOpen(false); }, [location.pathname]);
  const items = user?.role === 'admin'
    ? [...navItems, { to: '/admin', icon: Shield, labelKey: 'nav.admin' }]
    : navItems;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col transition-colors duration-200">
      {isTestnet && (
        <div className="bg-yellow-400 text-yellow-900 text-center text-xs font-semibold py-1">
          {t('layout.testnet')}
        </div>
      )}
      {/* Stellar Network Status Banner */}
      {isDegraded && (
        <div className="bg-yellow-500 text-yellow-900 text-center text-xs font-semibold py-2 px-4 flex items-center justify-center gap-2">
          <AlertTriangle size={14} />
          <span>{t('layout.networkIssues')}</span>
          <a
            href="https://status.stellar.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-yellow-800"
          >
            {t('layout.statusPage')}
          </a>
        </div>
      )}
      {/* Top bar */}
      <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 py-3 flex items-center justify-between transition-colors duration-200">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-primary-500 rounded-lg flex items-center justify-center text-sm font-bold text-white">A</div>
          <span className="font-semibold text-gray-900 dark:text-white">AfriPay</span>
          <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-[10px] font-medium border border-gray-200 dark:border-gray-700">
            <div className={`w-1.5 h-1.5 rounded-full ${isDegraded ? 'bg-yellow-500 animate-pulse' : 'bg-green-500'}`} />
            <span className="text-gray-600 dark:text-gray-400">
              {isDegraded ? t('layout.degraded') : t('layout.networkActive')}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={toggleTheme} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white transition-colors" title={t('layout.toggleTheme')} aria-label={t('layout.toggleTheme')}>
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <NotificationBell />
          {supported && (
            <button
              onClick={subscribed ? unsubscribe : subscribe}
              disabled={loading}
              className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white transition-colors disabled:opacity-50"
              title={subscribed ? t('layout.disableNotifications') : t('layout.enableNotifications')}
              aria-label={subscribed ? t('layout.disableNotifications') : t('layout.enableNotifications')}
            >
              {subscribed ? <Bell size={18} className="text-primary-500" /> : <BellOff size={18} />}
            </button>
          )}
          <button onClick={handleLogout} disabled={loggingOut} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white transition-colors" title={t('layout.logout')} aria-label={t('layout.logout')}>
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {/* Page content */}
      <main className="flex-1 overflow-y-auto pb-20">
        <div key={location.pathname} className="page-transition">
          <Outlet />
        </div>
      </main>

      {moreOpen && (
        <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)}>
          <div
            role="menu"
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-16 left-0 right-0 mx-2 grid grid-cols-3 gap-1 p-3 rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-xl"
          >
            {sheetItems.map((item) => (
              <NavItem key={item.to} {...item} user={user} />
            ))}
          </div>
        </div>
      )}

      {/* Bottom nav (mobile-first) */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 flex justify-around py-2 z-50 transition-colors duration-200">
        {navItems.map((item) => (
          <NavItem key={item.to} {...item} user={user} />
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          aria-current={moreActive ? 'page' : undefined}
          className={`flex flex-col items-center gap-0.5 min-w-[44px] min-h-[44px] justify-center px-2 py-1 rounded-lg transition-colors text-xs ${
            moreActive || moreOpen ? 'text-primary-500 font-semibold' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <MoreHorizontal size={20} strokeWidth={moreActive ? 2.5 : 1.75} />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}
