import React from 'react';
import { Outlet, NavLink, useNavigate, useLocation, useMatch } from 'react-router-dom';
import { LayoutDashboard, Send, Download, Clock, Upload, User, LogOut, Sun, Moon, Bell, BellOff, AlertTriangle, ArrowUpDown, PiggyBank, Lock, Shield } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { useStellarStatus } from '../hooks/useStellarStatus';
import OfflineBanner from './OfflineBanner';
import NotificationBell from './NotificationBell';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/send', icon: Send, label: 'Send' },
  { to: '/swap', icon: ArrowUpDown, label: 'Swap' },
  { to: '/save', icon: PiggyBank, label: 'Save' },
  { to: '/receive', icon: Download, label: 'Receive' },
  { to: '/escrow', icon: Lock, label: 'Escrow' },
  { to: '/history', icon: Clock, label: 'History' },
  { to: '/profile', icon: User, label: 'Profile' },
];

const isTestnet = process.env.REACT_APP_STELLAR_NETWORK !== 'mainnet';

function NavItem({ to, icon: Icon, label, user }) {
  const match = useMatch(to);
  const isActive = !!match;

  return (
    <NavLink
      to={to}
      aria-current={isActive ? 'page' : undefined}
      className={({ isActive: innerActive }) =>
        `flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg transition-colors text-xs ${
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
          <span>{label}</span>
        </>
      )}
    </NavLink>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const { supported, subscribed, loading, subscribe, unsubscribe } = usePushNotifications();
  const { isDegraded, status } = useStellarStatus();

  const handleLogout = () => { logout(); navigate('/'); };

  const items = user?.role === 'admin'
    ? [...navItems, { to: '/admin', icon: Shield, label: 'Admin' }]
    : navItems;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col transition-colors duration-200">
      {isTestnet && (
        <div className="bg-yellow-400 text-yellow-900 text-center text-xs font-semibold py-1">
          ⚠️ TESTNET — Do not use real funds
        </div>
      )}
      {/* Offline / back-online banner */}
      <OfflineBanner />
      {/* Stellar Network Status Banner */}
      {isDegraded && (
        <div className="bg-yellow-500 text-yellow-900 text-center text-xs font-semibold py-2 px-4 flex items-center justify-center gap-2">
          <AlertTriangle size={14} />
          <span>Stellar network is experiencing issues. Payments may be delayed.</span>
          <a
            href="https://status.stellar.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-yellow-800"
          >
            Status Page
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
              {isDegraded ? 'Degraded' : 'Network Active'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={toggleTheme} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white transition-colors" title="Toggle theme">
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <NotificationBell />
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
        <div key={location.pathname} className="page-transition">
          <Outlet />
        </div>
      </main>

      {/* Bottom nav (mobile-first) */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 flex justify-around py-2 z-50 transition-colors duration-200">
        {items.map((item) => (
          <NavItem key={item.to} {...item} user={user} />
        ))}
      </nav>
    </div>
  );
}
