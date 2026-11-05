import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { MotionConfig, motion } from 'framer-motion';
import { Page, spring } from './components/motion';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import './styles.css';
import './theme.css';
import { api } from './api';
import { AuthProvider, useAuth } from './auth';
import { ToastProvider } from './components/ui';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { ClientsPage, ClientDetailPage } from './pages/Clients';
import { ContractsPage, ContractDetailPage } from './pages/Contracts';
import { DocumentReviewPage } from './pages/Documents';
import { RateSchemesPage, RateVersionPage } from './pages/Rates';
import { DutyEntryPage } from './pages/DutyEntry';
import { DutyRegisterPage } from './pages/DutyRegister';
import { TemplatesPage, TemplateVersionPage } from './pages/Templates';
import { BillingWorkspacePage } from './pages/Bills';
import { BillsPage } from './pages/BillingExport';
import { ReportsPage } from './pages/Reports';
import { UsersPage, AuditPage, SettingsPage } from './pages/Admin';
import { OnboardingPage } from './pages/Onboarding';
import { ScanSlipsPage } from './pages/ScanSlips';

/** The chosen theme (light, dark or ocean) is remembered in the browser and applied before the first screen is drawn. */
const THEMES: [string, string][] = [['light', '☀ Light'], ['dark', '🌙 Dark'], ['ocean', '🌊 Ocean']];
const readTheme = () => { try { return localStorage.getItem('lr-theme') || 'light'; } catch { return 'light'; } };
document.documentElement.dataset.theme = readTheme();

/** Small line icons for the sidebar (16px, stroke only). */
const ICONS: Record<string, string> = {
  '/': 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  '/onboarding': 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  '/clients': 'M4 21V8l8-5 8 5v13M9 21v-6h6v6M8 11h.01M12 11h.01M16 11h.01',
  '/contracts': 'M7 3h8l4 4v14H7zM15 3v5h5M10 13h6M10 17h6',
  '/rates': 'M4 7h16M4 12h16M4 17h10M18 15l3 3-3 3',
  '/duties/entry': 'M12 5v14M5 12h14',
  '/duties': 'M4 5h16v14H4zM4 10h16M10 5v14',
  '/scan': 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16',
  '/billing': 'M5 4h14v16l-3-2-2 2-2-2-2 2-2-2-3 2zM9 9h6M9 13h6',
  '/bills': 'M6 3h9l4 4v14H6zM14 3v5h5M9 14l2 2 4-4',
  '/templates': 'M4 4h16v6H4zM4 14h7v6H4zM15 14h5v6h-5z',
  '/reports': 'M5 20V10M12 20V4M19 20v-7',
  '/users': 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21a8 8 0 0 1 16 0',
  '/audit': 'M12 8v5l3 2M21 12a9 9 0 1 1-3-6.7M21 4v5h-5',
  '/settings': 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
};
const NavIcon = ({ to }: { to: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[to] ?? ICONS['/']} /></svg>;

function ThemeSwitch() {
  const [t, setT] = useState(readTheme());
  const pick = (v: string) => { setT(v); document.documentElement.dataset.theme = v; try { localStorage.setItem('lr-theme', v); } catch { /* not saved */ } };
  return <div className="themes" role="group" aria-label="Theme">{THEMES.map(([k, label]) => <button key={k} className={t === k ? 'on' : ''} onClick={() => pick(k)} aria-pressed={t === k}>{label}</button>)}</div>;
}

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

const NAV: { to: string; label: string; perm?: string; group?: string }[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/onboarding', label: 'Set up from documents', group: 'Setup', perm: 'client.write' },
  { to: '/clients', label: 'Departments & Institutions' },
  { to: '/contracts', label: 'Contracts' },
  { to: '/rates', label: 'Rate Schemes' },
  { to: '/duties/entry', label: 'Daily Duty Entry', group: 'Daily work' },
  { to: '/duties', label: 'Duty Register' },
  { to: '/scan', label: 'Duty Slip Scanning & Billing', perm: 'duty.write' },
  { to: '/billing', label: 'Billing Workspace', group: 'Billing' },
  { to: '/bills', label: 'Billing Export / Invoices' },
  { to: '/templates', label: 'Billing Templates' },
  { to: '/reports', label: 'Reports & Reconciliation' },
  { to: '/users', label: 'User Management', perm: 'user.admin', group: 'Administration' },
  { to: '/audit', label: 'Audit Logs', perm: 'audit.view' },
  { to: '/settings', label: 'System Settings' },
];

function Shell() {
  const { user, can, needsSetup, version } = useAuth();
  const client = useQueryClient();
  const loc = useLocation();
  if (!user) return <LoginPage setup={needsSetup} />;
  const logout = async () => {
    await api.post('/auth/logout');
    client.clear();
    location.href = '/';
  };
  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><span className="logo">LR</span><span>LR Taxi Services<span className="ver">v{version}</span><small>Billing &amp; Duty Management</small></span></div>
        <nav>
          {NAV.filter((n) => !n.perm || can(n.perm)).map((n) => (
            <div key={n.to}>
              {n.group && <div className="group">{n.group}</div>}
              <NavLink to={n.to} end={n.to === '/' || n.to === '/duties'}>{({ isActive }) => <>{isActive && <motion.span layoutId="nav-pill" className="nav-pill" transition={spring} />}<span className="nav-in"><NavIcon to={n.to} />{n.label}</span></>}</NavLink>
            </div>
          ))}
        </nav>
        <div className="me">
          <ThemeSwitch />
          <div className="who"><span className="avatar">{user.name.split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase()}</span><div><div style={{ color: '#fff' }}>{user.name}</div><div className="small">{user.role}</div></div></div>
          <button className="btn sm" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        <Page key={loc.pathname}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="/clients/:id" element={<ClientDetailPage />} />
          <Route path="/contracts" element={<ContractsPage />} />
          <Route path="/contracts/:id" element={<ContractDetailPage />} />
          <Route path="/documents" element={<Navigate to="/clients" />} />
          <Route path="/documents/:id" element={<DocumentReviewPage />} />
          <Route path="/rates" element={<RateSchemesPage />} />
          <Route path="/rates/versions/:id" element={<RateVersionPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/templates/versions/:id" element={<TemplateVersionPage />} />
          <Route path="/duties/entry" element={<DutyEntryPage />} />
          <Route path="/duties" element={<DutyRegisterPage />} />
          <Route path="/scan" element={<ScanSlipsPage />} />
          <Route path="/billing" element={<BillingWorkspacePage />} />
          <Route path="/billing/:id" element={<BillingWorkspacePage />} />
          <Route path="/bills" element={<BillsPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
        </Page>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user"><QueryClientProvider client={qc}>
      <ToastProvider>
        <BrowserRouter>
          <AuthProvider>
            <Shell />
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider></MotionConfig>
  </StrictMode>,
);
