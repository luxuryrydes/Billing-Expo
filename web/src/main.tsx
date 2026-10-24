import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import './styles.css';
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

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

const NAV: { to: string; label: string; perm?: string; group?: string }[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/onboarding', label: 'Set up from documents', group: 'Setup', perm: 'client.write' },
  { to: '/clients', label: 'Departments & Institutions' },
  { to: '/contracts', label: 'Contracts' },
  { to: '/rates', label: 'Rate Schemes' },
  { to: '/duties/entry', label: 'Daily Duty Entry', group: 'Daily work' },
  { to: '/duties', label: 'Duty Register' },
  { to: '/billing', label: 'Billing Workspace', group: 'Billing' },
  { to: '/bills', label: 'Billing Export / Invoices' },
  { to: '/templates', label: 'Billing Templates' },
  { to: '/reports', label: 'Reports & Reconciliation' },
  { to: '/users', label: 'User Management', perm: 'user.admin', group: 'Administration' },
  { to: '/audit', label: 'Audit Logs', perm: 'audit.view' },
  { to: '/settings', label: 'System Settings' },
];

function Shell() {
  const { user, can, needsSetup } = useAuth();
  const client = useQueryClient();
  if (!user) return <LoginPage setup={needsSetup} />;
  const logout = async () => {
    await api.post('/auth/logout');
    client.clear();
    location.href = '/';
  };
  return (
    <div className="app">
      <aside className="side">
        <div className="brand">LR Taxi Services<small>Billing &amp; Duty Management</small></div>
        <nav>
          {NAV.filter((n) => !n.perm || can(n.perm)).map((n) => (
            <div key={n.to}>
              {n.group && <div className="group">{n.group}</div>}
              <NavLink to={n.to} end={n.to === '/' || n.to === '/duties'}>{n.label}</NavLink>
            </div>
          ))}
        </nav>
        <div className="me">
          <div style={{ color: '#fff' }}>{user.name}</div>
          <div className="small">{user.role}</div>
          <button className="btn sm" style={{ marginTop: 8 }} onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
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
          <Route path="/billing" element={<BillingWorkspacePage />} />
          <Route path="/billing/:id" element={<BillingWorkspacePage />} />
          <Route path="/bills" element={<BillsPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <BrowserRouter>
          <AuthProvider>
            <Shell />
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
