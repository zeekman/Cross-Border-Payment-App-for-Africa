import React from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Send, Download, Clock, User, LogOut, Webhook } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

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

  const handleLogout = () => { logout(); navigate('/'); };

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      {isTestnet && (
        <div className="bg-yellow-400 text-yellow-900 text-center text-xs font-semibold py-1">
          ⚠️ TESTNET — Do not use real funds
        </div>
      )}
      {/* Top bar */}
      <header className="bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-primary-500 rounded-lg flex items-center justify-center text-sm font-bold">A</div>
          <span className="font-semibold text-white">AfriPay</span>
        </div>
        <button onClick={handleLogout} className="text-gray-400 hover:text-white transition-colors">
          <LogOut size={18} />
        </button>
      </header>

      {/* Page content */}
      <main className="flex-1 overflow-y-auto pb-20">
        <Outlet />
      </main>

      {/* Bottom nav (mobile-first) */}
      <nav className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 flex justify-around py-2 z-50">
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
