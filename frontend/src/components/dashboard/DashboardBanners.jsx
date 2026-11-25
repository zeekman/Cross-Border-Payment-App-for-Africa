import { IS_TESTNET } from '../../config/network';
import { Download, FlaskConical, Clock, Mail, Bell, X } from 'lucide-react';

export default function DashboardBanners({ user, pushLoading, pushSubscribe, showPushBanner, dismissPushBanner, funding, queueCount, isOnline, showEmailBanner, setShowEmailBanner, isConnected, isReconnecting, streamError, loadDashboard, fundWallet, accountExists, showFundWalletButton }) {
  return (
    <>
      {/* Testnet banner */}
      {IS_TESTNET && (
        <div className="flex items-center justify-between bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2 text-yellow-400 text-sm">
            <FlaskConical size={15} />
            <span>Testnet mode — funds have no real value</span>
          </div>
          {showFundWalletButton && (
            <button
              onClick={fundWallet}
              disabled={funding}
              className="text-xs bg-yellow-500 hover:bg-yellow-600 disabled:opacity-50 text-black font-semibold px-3 py-1.5 rounded-lg transition-colors"
            >
              {funding ? 'Funding…' : 'Fund wallet'}
            </button>
          )}
        </div>
      )}

      {/* Email verification banner (issue #479) */}
      {showEmailBanner && user?.email_verified === false && (
        <div className="flex items-center justify-between bg-blue-500/10 border border-blue-500/30 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2 text-blue-400 text-sm">
            <Mail size={15} />
            <span>Please verify your email address to unlock full account features</span>
          </div>
          <button
            onClick={() => setShowEmailBanner(false)}
            className="text-blue-400 hover:text-blue-300 text-xs font-semibold px-2 py-1 rounded-lg transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Unfunded account prompt */}
      {!accountExists && (
        <div className="flex items-center gap-3 bg-blue-500/10 border border-blue-500/30 rounded-xl px-4 py-3">
          <Download size={18} className="text-blue-400 shrink-0" />
          <div className="flex-1">
            <p className="text-blue-300 text-sm font-medium">Fund your wallet to get started</p>
            <p className="text-blue-400/70 text-xs mt-0.5">
              This account doesn't exist on-chain yet. Send XLM to activate it.
            </p>
          </div>
        </div>
      )}

      {/* Stream reconnecting indicator */}
      {isReconnecting && (
        <div className="flex items-center gap-2 bg-orange-500/10 border border-orange-500/30 rounded-xl px-4 py-2 text-orange-400 text-sm">
          <div className="w-3 h-3 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
          <span>Reconnecting to live updates…</span>
        </div>
      )}

      {/* Stream disconnected banner — shows when not connected and not actively reconnecting */}
      {!isConnected && !isReconnecting && streamError && (
        <div
          role="alert"
          aria-live="polite"
          className="flex items-center justify-between bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-400 text-sm"
        >
          <span>Live updates paused — pull to refresh</span>
          <button
            onClick={() => loadDashboard()}
            className="text-xs bg-red-500/20 hover:bg-red-500/30 px-3 py-1 rounded-lg transition-colors"
          >
            Refresh
          </button>
        </div>
      )}

      {/* Issue #455: Push notification opt-in banner */}
      {showPushBanner && (
        <div className="flex items-center gap-3 bg-primary-500/10 border border-primary-500/30 rounded-xl px-4 py-3">
          <Bell size={18} className="text-primary-400 shrink-0" />
          <div className="flex-1">
            <p className="text-primary-300 text-sm font-medium">Enable push notifications</p>
            <p className="text-primary-400/70 text-xs mt-0.5">
              Get alerted instantly when you receive a payment.
            </p>
          </div>
          <button
            onClick={pushSubscribe}
            disabled={pushLoading}
            className="text-xs bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors shrink-0"
          >
            {pushLoading ? 'Enabling…' : 'Enable'}
          </button>
          <button
            onClick={dismissPushBanner}
            className="text-gray-500 hover:text-white shrink-0"
            aria-label="Dismiss notification prompt"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Offline Queue Indicator */}
      {!isOnline && queueCount > 0 && (
        <div className="flex items-center justify-between bg-primary-500/10 border border-primary-500/30 rounded-xl px-4 py-3">
          <div className="flex items-center gap-3 text-primary-400 text-sm">
            <Clock size={16} />
            <span>
              {queueCount} payment{queueCount !== 1 ? 's' : ''} queued offline
            </span>
          </div>
          <p className="text-[10px] text-primary-500/70 font-medium uppercase tracking-wider">
            Pending Sync
          </p>
        </div>
      )}
    </>
  );
}
