import React from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Send, Download, Clock, User, LogOut, Webhook, Sun, Moon, Bell, BellOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { usePushNotifications } from '../hooks/usePushNotifications';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/send', icon: Send, label: 'Send' },
  { to: '/receive', icon: Download, label: 'Receive' },
  { to: '/history', icon: Clock, label: 'History' },
  { to: '/webhooks', icon: Webhook, label: 'Webhooks' },
  { to: '/profile', icon: User, label: 'Profile' },
];

const isTestnet = process.env.REACT_APP_STELLAR_NETWORK !== 'mainnet';

export default function Layout() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { supported, subscribed, loading, subscribe, unsubscribe } = usePushNotifications();

  const handleLogout = () => { logout(); navigate('/'); };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col transition-colors duration-200">
      {isTestnet && (
        <div className="bg-yellow-400 text-yellow-900 text-center text-xs font-semibold py-1">
          ⚠️ TESTNET — Do not use real funds
        </div>
      )}
      {/* Top bar */}
      <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 py-3 flex items-center justify-between transition-colors duration-200">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-primary-500 rounded-lg flex items-center justify-center text-sm font-bold text-white">A</div>
          <span className="font-semibold text-gray-900 dark:text-white">AfriPay</span>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={toggleTheme} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white transition-colors" title="Toggle theme">
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          {supported && (
            <button
              onClick={subscribed ? unsubscribe : subscribe}
              disabled={loading}
              className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white transition-colors disabled:opacity-50"
              title={subscribed ? 'Disable payment notifications' : 'Enable payment notifications'}
            >
              {subscribed ? <Bell size={18} className="text-primary-500" /> : <BellOff size={18} />}
            </button>
          )}
          <button onClick={handleLogout} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white transition-colors" title="Logout">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {/* Page content */}
      <main className="flex-1 overflow-y-auto pb-20">
        <Outlet />
      </main>

      {/* Bottom nav (mobile-first) */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 flex justify-around py-2 z-50 transition-colors duration-200">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg transition-colors text-xs ${
                isActive ? 'text-primary-500' : 'text-gray-500 hover:text-gray-300'
              }`
            }
          >
            <Icon size={20} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
