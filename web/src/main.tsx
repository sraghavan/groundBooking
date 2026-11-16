import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, NavLink, Outlet, RouterProvider, useParams } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { auth } from './api';
import { cx } from './lib';
import { LoginPage } from './pages/Login';
import { HomePage } from './pages/Home';
import { GroundWeekPage } from './pages/GroundWeek';
import { BookingPage } from './pages/Booking';
import { GroupBookingPage } from './pages/GroupBooking';
import { DuesPage } from './pages/Dues';
import { ReportsPage } from './pages/Reports';
import { MorePage } from './pages/More';
import { GroundsAdminPage, GroundEditPage } from './pages/admin/Grounds';
import { TeamsAdminPage, TeamDetailPage } from './pages/admin/Teams';
import { PricingPage } from './pages/admin/Pricing';
import { PromotersPage } from './pages/admin/Promoters';
import { AccountsPage } from './pages/admin/Accounts';
import { PartnersPage } from './pages/admin/Partners';
import { SettingsPage } from './pages/admin/Settings';
import { ImportPage } from './pages/admin/Import';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true } },
});

const icons: Record<string, ReactNode> = {
  slots: <path d="M3 5h18M3 12h18M3 19h18M8 2v6M16 2v6" />,
  dues: <><circle cx="12" cy="12" r="9" /><path d="M9 8h6M9 11h6M12 11c2 0 3 1 3 2.5S13 16 12 16l-3 0 4 3" /></>,
  reports: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  more: <><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>,
};

function Tab({ to, label, icon, end }: { to: string; label: string; icon: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => cx('flex flex-1 flex-col items-center gap-0.5 pb-1 pt-2 text-[11px] font-semibold', isActive ? 'text-pitch' : 'text-muted')}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{icons[icon]}</svg>
      {label}
    </NavLink>
  );
}

function AppShell() {
  if (!auth.token) return <Navigate to="/login" replace />;
  return (
    <>
      <Outlet />
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl">
          <Tab to="/" end label="Slots" icon="slots" />
          <Tab to="/dues" label="Dues" icon="dues" />
          <Tab to="/reports" label="Reports" icon="reports" />
          <Tab to="/more" label="More" icon="more" />
        </div>
      </nav>
    </>
  );
}

/** Remount the booking form when moving between bookings (e.g. new → saved). */
function BookingRoute() {
  const { id } = useParams();
  return <BookingPage key={id ?? 'new'} />;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/grounds/:id/week', element: <GroundWeekPage /> },
      { path: '/bookings/new', element: <BookingRoute /> },
      { path: '/bookings/group', element: <GroupBookingPage /> },
      { path: '/bookings/:id', element: <BookingRoute /> },
      { path: '/dues', element: <DuesPage /> },
      { path: '/reports', element: <ReportsPage /> },
      { path: '/more', element: <MorePage /> },
      { path: '/admin/grounds', element: <GroundsAdminPage /> },
      { path: '/admin/grounds/:id', element: <GroundEditPage /> },
      { path: '/admin/teams', element: <TeamsAdminPage /> },
      { path: '/admin/teams/:id', element: <TeamDetailPage /> },
      { path: '/admin/pricing', element: <PricingPage /> },
      { path: '/admin/promoters', element: <PromotersPage /> },
      { path: '/admin/accounts', element: <AccountsPage /> },
      { path: '/admin/partners', element: <PartnersPage /> },
      { path: '/admin/settings', element: <SettingsPage /> },
      { path: '/admin/import', element: <ImportPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
