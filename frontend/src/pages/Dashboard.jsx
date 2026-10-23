import React from 'react';
import { RefreshCw } from 'lucide-react';
import PINSetupModal from '../components/PINSetupModal';
import { useDashboard } from '../hooks/useDashboard';
import DashboardBanners from '../components/dashboard/DashboardBanners';
import DashboardGreeting from '../components/dashboard/DashboardGreeting';
import WalletSelector from '../components/dashboard/WalletSelector';
import BalanceCard from '../components/dashboard/BalanceCard';
import WalletsSummary from '../components/dashboard/WalletsSummary';
import ActionButtons from '../components/dashboard/ActionButtons';
import FiatRamp from '../components/dashboard/FiatRamp';
import AdminContractViewer from '../components/dashboard/AdminContractViewer';
import ScheduledPayments from '../components/dashboard/ScheduledPayments';
import RecentTransactions from '../components/dashboard/RecentTransactions';

export { safeAnchorUrl } from '../utils/anchorUrl';

export default function Dashboard() {
  const {
    accountExists,
    activeWalletId,
    allBalances,
    anchorAction,
    anchorLoading,
    balanceIncreased,
    copied,
    copyAddress,
    creatingWallet,
    currencies,
    dismissPushBanner,
    displayBalance,
    fromCache,
    fundWallet,
    funding,
    handleAnchorAction,
    handleCreateWallet,
    isConnected,
    isOnline,
    isReconnecting,
    loadDashboard,
    loading,
    navigate,
    newWalletLabel,
    onTouchEnd,
    onTouchMove,
    onTouchStart,
    pullDistance,
    pullRefreshing,
    pushLoading,
    pushSubscribe,
    queueCount,
    refreshing,
    scheduledLoading,
    scheduledPayments,
    selectedCurrency,
    setActiveWalletId,
    setNewWalletLabel,
    setSelectedCurrency,
    setShowCreateForm,
    setShowEmailBanner,
    setShowPINSetup,
    setShowWalletDropdown,
    setShowZeroBalances,
    showCreateForm,
    showEmailBanner,
    showFundWalletButton,
    showPINSetup,
    showPushBanner,
    showWalletDropdown,
    showZeroBalances,
    streamError,
    t,
    transactions,
    transactionsError,
    txError,
    updateUser,
    user,
    usingApproximateRates,
    visibleBalances,
    wallet,
    walletUnavailable,
    wallets,
    xlmAvailable,
  } = useDashboard();

  return (
    <div
      className="px-4 py-6 max-w-lg mx-auto space-y-6"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* Pull-to-refresh indicator */}
      {(pullDistance > 0 || pullRefreshing) && (
        <div
          className="flex justify-center items-center transition-all duration-150"
          style={{ height: pullRefreshing ? 40 : pullDistance, overflow: 'hidden' }}
        >
          <RefreshCw
            size={20}
            className={`text-primary-400 transition-transform ${pullRefreshing ? 'animate-spin' : ''}`}
            style={{
              transform: pullRefreshing ? undefined : `rotate(${(pullDistance / 80) * 360}deg)`,
            }}
          />
        </div>
      )}
      <DashboardBanners user={user} t={t} pushLoading={pushLoading} pushSubscribe={pushSubscribe} showPushBanner={showPushBanner} dismissPushBanner={dismissPushBanner} wallet={wallet} funding={funding} queueCount={queueCount} isOnline={isOnline} showEmailBanner={showEmailBanner} setShowEmailBanner={setShowEmailBanner} isConnected={isConnected} isReconnecting={isReconnecting} streamError={streamError} loadDashboard={loadDashboard} fundWallet={fundWallet} accountExists={accountExists} showFundWalletButton={showFundWalletButton} />

      <DashboardGreeting user={user} t={t} wallet={wallet} refreshing={refreshing} isConnected={isConnected} isReconnecting={isReconnecting} loadDashboard={loadDashboard} walletUnavailable={walletUnavailable} />

      <WalletSelector t={t} wallets={wallets} activeWalletId={activeWalletId} setActiveWalletId={setActiveWalletId} showWalletDropdown={showWalletDropdown} setShowWalletDropdown={setShowWalletDropdown} creatingWallet={creatingWallet} newWalletLabel={newWalletLabel} setNewWalletLabel={setNewWalletLabel} showCreateForm={showCreateForm} setShowCreateForm={setShowCreateForm} wallet={wallet} handleCreateWallet={handleCreateWallet} walletUnavailable={walletUnavailable} />

      <BalanceCard t={t} wallet={wallet} loading={loading} copied={copied} selectedCurrency={selectedCurrency} setSelectedCurrency={setSelectedCurrency} balanceIncreased={balanceIncreased} fromCache={fromCache} showZeroBalances={showZeroBalances} setShowZeroBalances={setShowZeroBalances} currencies={currencies} usingApproximateRates={usingApproximateRates} copyAddress={copyAddress} xlmAvailable={xlmAvailable} allBalances={allBalances} visibleBalances={visibleBalances} displayBalance={displayBalance} walletUnavailable={walletUnavailable} />

      <WalletsSummary user={user} wallets={wallets} activeWalletId={activeWalletId} setActiveWalletId={setActiveWalletId} />

      <ActionButtons navigate={navigate} t={t} activeWalletId={activeWalletId} />

      <FiatRamp t={t} anchorLoading={anchorLoading} anchorAction={anchorAction} handleAnchorAction={handleAnchorAction} />

      <AdminContractViewer />

      <ScheduledPayments navigate={navigate} scheduledPayments={scheduledPayments} scheduledLoading={scheduledLoading} />

      {/* Issue #454: PIN setup modal on first login */}
      <PINSetupModal
        isOpen={showPINSetup}
        onClose={() => setShowPINSetup(false)}
        onSuccess={() => updateUser({ pin_setup_completed: true })}
      />

      <RecentTransactions navigate={navigate} t={t} activeWalletId={activeWalletId} transactions={transactions} txError={txError} loading={loading} refreshing={refreshing} anchorLoading={anchorLoading} transactionsError={transactionsError} loadDashboard={loadDashboard} handleAnchorAction={handleAnchorAction} />
    </div>
  );
}
