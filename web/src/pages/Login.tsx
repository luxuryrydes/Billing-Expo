import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ErrorBox, Field } from '../components/ui';

export function LoginPage({ setup }: { setup: boolean }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (setup) await api.post('/auth/setup', { email, name, password });
      else await api.post('/auth/login', { email, password });
      await qc.invalidateQueries();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-wrap">
      <div className="login-hero">
        <span className="logo">LR</span>
        <h2>Billing &amp; duty management that does the sums for you</h2>
        <p>Scan duty slips, apply the right rate card, and send clean department invoices, with every figure traceable.</p>
        <ul>
          <li>📄 Scan a stack of slips and have them read for you</li>
          <li>💰 Rates, GST and totals worked out from your rate cards</li>
          <li>🧾 Excel and PDF invoices in each department's format</li>
        </ul>
      </div>
      <div className="login-form">
        <div className="login panel">
          <h1 style={{ marginBottom: 4 }}>{setup ? 'Welcome' : 'Sign in'}</h1>
          <p className="muted" style={{ marginTop: 0 }}>LR Taxi Services · Billing &amp; Duty Management</p>
          {setup && <div className="alert info">First run: create the administrator account. Further users are added from User Management.</div>}
          <ErrorBox error={error} />
          <form onSubmit={submit} className="grid">
            <Field label="Email" required><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus /></Field>
            {setup && <Field label="Full name" required><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>}
            <Field label="Password" required hint={setup ? 'At least 10 characters with letters and digits' : undefined}>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setup ? 'new-password' : 'current-password'} required />
            </Field>
            <button className="btn primary" disabled={busy} style={{ padding: '10px 14px', fontSize: 14 }}>{setup ? 'Create administrator' : 'Sign in'}</button>
          </form>
        </div>
      </div>
    </div>
  );
}
