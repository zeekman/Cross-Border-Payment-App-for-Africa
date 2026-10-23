import { RefreshCw } from 'lucide-react';

export default function DashboardGreeting({ user, t, refreshing, isConnected, isReconnecting, loadDashboard, walletUnavailable }) {
  return (
    <>
      {/* Greeting */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-gray-600 dark:text-gray-400 text-sm">{t('dashboard.greeting')}</p>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">
            {user?.full_name?.split(' ')[0]} 👋
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {/* Stream connection status indicator */}
          <span
            aria-label={
              isReconnecting
                ? 'Live updates: reconnecting'
                : isConnected
                  ? 'Live updates: connected'
                  : 'Live updates: disconnected'
            }
            title={
              isReconnecting
                ? 'Reconnecting to live updates…'
                : isConnected
                  ? 'Live updates active'
                  : 'Live updates paused'
            }
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
              isReconnecting
                ? 'bg-orange-400 animate-pulse'
                : isConnected
                  ? 'bg-green-400'
                  : 'bg-red-400'
            }`}
          />
          <button
            onClick={() => loadDashboard()}
            className="text-gray-400 hover:text-white"
            aria-label="Refresh dashboard"
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </div>

      {walletUnavailable && (
        <div
          role="alert"
          className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-4 text-red-300"
        >
          <p className="text-sm font-medium">
            Could not load wallet data. Check your connection and try again.
          </p>
          <button
            type="button"
            onClick={() => loadDashboard(true)}
            disabled={refreshing}
            className="mt-3 inline-flex items-center gap-2 rounded-lg bg-red-500/20 px-3 py-2 text-sm font-semibold text-red-100 hover:bg-red-500/30 disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Retry
          </button>
        </div>
      )}
    </>
  );
}
