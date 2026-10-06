import React, { useEffect, useState, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { CurrencyProvider } from "./context/CurrencyContext";

import Welcome from "./pages/Welcome";
import Login from "./pages/Login";
import Register from "./pages/Register";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import VerifyEmail from "./pages/VerifyEmail";
import { ConfirmProvider } from "./context/ConfirmContext";
import Dashboard from "./pages/Dashboard";
import SendMoney from "./pages/SendMoney";
import ReceiveMoney from "./pages/ReceiveMoney";
import SaveMoney from "./pages/SaveMoney";
import RequestMoney from "./pages/RequestMoney";
import ScheduledPayments from "./pages/ScheduledPayments";
import TransactionHistory from "./pages/TransactionHistory";
import Profile from "./pages/Profile";
import KYCVerification from "./pages/KYCVerification";
import BusinessSettings from "./pages/BusinessSettings";
import Webhooks from "./pages/Webhooks";
import Referrals from "./pages/Referrals";
import Sessions from "./pages/Sessions";
import Escrow from "./pages/Escrow";
import NotFound from "./pages/NotFound";
import Layout from "./components/Layout";
import ErrorBoundary from "./components/ErrorBoundary";
import UpdateBanner from "./components/UpdateBanner";

// Code-split large pages
const Analytics = React.lazy(() => import("./pages/Analytics"));
const Swap = React.lazy(() => import("./pages/Swap"));
const BatchPayment = React.lazy(() => import("./pages/BatchPayment"));
const AdminDashboard = React.lazy(() => import("./pages/AdminDashboard"));

const LoadingFallback = () => (
  <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
    <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
  </div>
);

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading)
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 transition-colors duration-200" role="status" aria-label="Loading">
        <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  if (!user) {
    sessionStorage.setItem('afripay_redirect', location.pathname + location.search);
    return <Navigate to="/login" replace />;
  }
  // Onboarding is a per-account prerequisite — incomplete users must finish it first.
  if (user.onboarding_completed === false) {
    return <Navigate to="/" replace />;
  }
  return children;
}

function AdminRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingFallback />;
  if (!user || user.role !== "admin") {
    return <Navigate to="/dashboard" replace />;
  }
  return children;
}

function PublicRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  return user ? <Navigate to="/dashboard" replace /> : children;
}

// Route for the Welcome/onboarding screen: shown to logged-out visitors and to
// logged-in users whose account hasn't completed onboarding yet. Users who have
// completed onboarding are sent straight to the dashboard.
function OnboardingRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user && user.onboarding_completed !== false) {
    return <Navigate to="/dashboard" replace />;
  }
  return children;
}

function AppRoutes() {
  const location = useLocation();

  return (
    <ErrorBoundary key={location.pathname}>
      <Routes>
        <Route
          path="/"
          element={
            <OnboardingRoute>
              <Welcome />
            </OnboardingRoute>
          }
        />
        <Route
          path="/login"
          element={
            <PublicRoute>
              <Login />
            </PublicRoute>
          }
        />
        <Route
          path="/register"
          element={
            <PublicRoute>
              <Register />
            </PublicRoute>
          }
        />
        <Route
          path="/forgot-password"
          element={
            <PublicRoute>
              <ForgotPassword />
            </PublicRoute>
          }
        />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/verify-email-change" element={<VerifyEmail change />} />
        <Route
          path="/reset-password"
          element={
            <PublicRoute>
              <ResetPassword />
            </PublicRoute>
          }
        />
        <Route
          path="/"
          element={
            <PrivateRoute>
              <Layout />
            </PrivateRoute>
          }
        >
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="send" element={<SendMoney />} />
          <Route path="batch-payments" element={<Suspense fallback={<LoadingFallback />}><BatchPayment /></Suspense>} />
          <Route path="receive" element={<ReceiveMoney />} />
          <Route path="save" element={<SaveMoney />} />
          <Route path="request" element={<RequestMoney />} />
          <Route path="scheduled" element={<ScheduledPayments />} />
          <Route path="history" element={<TransactionHistory />} />
          <Route path="analytics" element={<Suspense fallback={<LoadingFallback />}><Analytics /></Suspense>} />
          <Route path="profile" element={<Profile />} />
          <Route path="sessions" element={<Sessions />} />
          <Route path="kyc" element={<KYCVerification />} />
          <Route path="webhooks" element={<Webhooks />} />
          <Route path="business" element={<BusinessSettings />} />
          <Route path="swap" element={<Suspense fallback={<LoadingFallback />}><Swap /></Suspense>} />
          <Route path="referrals" element={<Referrals />} />
          <Route path="escrow" element={<Escrow />} />
          <Route
            path="admin"
            element={
              <AdminRoute>
                <Suspense fallback={<LoadingFallback />}>
                  <AdminDashboard />
                </Suspense>
              </AdminRoute>
            }
          />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </ErrorBoundary>
  );
}

export default function App() {
  const [isOffline, setIsOffline] = useState(
    typeof navigator !== "undefined" ? !navigator.onLine : false
  );

  useEffect(() => {
    const handleOffline = () => setIsOffline(true);
    const handleOnline = () => setIsOffline(false);

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  return (
    <>
      {isOffline && (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 9999,
            backgroundColor: "#b91c1c",
            color: "#fff",
            textAlign: "center",
            padding: "10px 16px",
            fontSize: "14px",
            fontWeight: "500",
          }}
        >
          You're offline. Some features may be unavailable.
        </div>
      )}
      <AuthProvider>
        <ThemeProvider>
          <CurrencyProvider>
          <BrowserRouter>
            <Toaster
              position="top-center"
              toastOptions={{
                style: { background: "#1e293b", color: "#fff", border: "1px solid #334155" },
              }}
              containerProps={{
                "aria-live": "polite",
                "aria-atomic": "true",
              }}
            />
            <ConfirmProvider>
              <AppRoutes />
            </ConfirmProvider>
            <UpdateBanner />
          </BrowserRouter>
          </CurrencyProvider>
        </ThemeProvider>
      </AuthProvider>
    </>
  );
}
