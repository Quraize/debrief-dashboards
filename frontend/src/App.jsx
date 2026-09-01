import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ScrollToTop from './components/ScrollToTop';
import ProtectedRoute from '@/components/ProtectedRoute';
import Login from '@/pages/Login';
import AppLayout from '@/components/AppLayout';
import Home from '@/pages/Home';
import SubmitDebrief from '@/pages/SubmitDebrief';
import OpenDebriefQueue from '@/pages/OpenDebriefQueue';
import AppointmentRecords from '@/pages/AppointmentRecords';
import KpiDashboard from '@/pages/KpiDashboard';
import SalesRepDashboard from '@/pages/SalesRepDashboard';
import AppointmentSetterDashboard from '@/pages/AppointmentSetterDashboard';
import Exceptions from '@/pages/Exceptions';
import ExportCenter from '@/pages/ExportCenter';
import AdminSettings from '@/pages/AdminSettings';
import ImportAppointments from '@/pages/ImportAppointments';
import ResultsReview from '@/pages/ResultsReview';
import ManagerReport from '@/pages/ManagerReport';
import JobProgressSync from '@/pages/JobProgressSync';
import PriceReview from '@/pages/PriceReview';
import MarketingDashboard from '@/pages/MarketingDashboard';
import InsuranceDashboard from '@/pages/InsuranceDashboard';
// Add page imports here

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError } = useAuth();

  // Show loading spinner while checking app public settings or auth
  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  // Only errors that no route can handle are dealt with here.
  //
  // 'auth_required' is deliberately NOT handled at this level. This gate runs
  // before <Routes>, so redirecting here means /login itself never renders -
  // and because the redirect appends the current URL as returnTo, each pass
  // nests the previous one and the app spins on an ever-growing URL until it
  // renders nothing at all.
  //
  // Being signed out is a routing outcome, not a fatal error: ProtectedRoute
  // below already renders <Navigate to="/login" replace /> for it, and /login
  // sits outside that guard so it can actually be reached.
  if (authError && authError.type === 'user_not_registered') {
    return <UserNotRegisteredError />;
  }

  // Render the main app
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/*
        D11 (single shared account): self-service registration and password
        reset are UNROUTED, not deleted. The components stay in the tree so
        in-platform onboarding can restore them without being rewritten, but
        there is no URL that reaches them - and no backend endpoint behind them
        either (see backend/src/auth/routes.ts).
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
      */}
      <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login?returnTo=/submit" replace />} />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/marketing" element={<MarketingDashboard />} />
          <Route path="/insurance" element={<InsuranceDashboard />} />
          <Route path="/submit" element={<SubmitDebrief />} />
          <Route path="/queue" element={<OpenDebriefQueue />} />
          <Route path="/appointments" element={<AppointmentRecords />} />
          <Route path="/kpi" element={<KpiDashboard />} />
          <Route path="/sales-reps" element={<SalesRepDashboard />} />
          <Route path="/setters" element={<AppointmentSetterDashboard />} />
          <Route path="/exceptions" element={<Exceptions />} />
          <Route path="/export" element={<ExportCenter />} />
          <Route path="/admin" element={<AdminSettings />} />
          <Route path="/import" element={<ImportAppointments />} />
          <Route path="/results" element={<ResultsReview />} />
          <Route path="/manager-report" element={<ManagerReport />} />
          <Route path="/jobprogress-sync" element={<JobProgressSync />} />
          <Route path="/price-review" element={<PriceReview />} />
        </Route>
      </Route>
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};


function App() {

  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <ScrollToTop />
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App