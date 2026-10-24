import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Field, Loading, Modal, PageHead, Status, useAction } from '../components/ui';
import { d } from '../format';
import { useClients } from '../lookups';
import { ContractForm } from './Contracts';

const EMPTY = { name: '', short_code: '', billing_address: '', gstin: '', pan: '', state_name: '', state_code: '', contact_name: '', contact_email: '', contact_phone: '', special_instructions: '', status: 'active' };

export function ClientForm({ initial, onDone }: { initial?: any; onDone: () => void }) {
  const [f, setF] = useState<any>({ ...EMPTY, ...(initial ?? {}) });
  const { run, busy } = useAction();
  const qc = useQueryClient();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const r = await run(() => (initial?.id ? api.put(`/clients/${initial.id}`, f) : api.post('/clients', f)), 'Department saved');
    if (r) { qc.invalidateQueries({ queryKey: ['clients'] }); onDone(); }
  };
  return (
    <div className="grid">
      <div className="grid g2">
        <Field label="Department / client name" required><input value={f.name} onChange={set('name')} /></Field>
        <Field label="Short code (used in bill numbers)" required><input value={f.short_code} onChange={set('short_code')} maxLength={20} /></Field>
      </div>
      <Field label="Billing address"><textarea value={f.billing_address} onChange={set('billing_address')} /></Field>
      <div className="grid g4">
        <Field label="GSTIN"><input value={f.gstin ?? ''} onChange={set('gstin')} /></Field>
        <Field label="PAN"><input value={f.pan ?? ''} onChange={set('pan')} /></Field>
        <Field label="State"><input value={f.state_name ?? ''} onChange={set('state_name')} /></Field>
        <Field label="State code"><input value={f.state_code ?? ''} onChange={set('state_code')} /></Field>
      </div>
      <div className="grid g3">
        <Field label="Contact person"><input value={f.contact_name ?? ''} onChange={set('contact_name')} /></Field>
        <Field label="Contact email"><input value={f.contact_email ?? ''} onChange={set('contact_email')} /></Field>
        <Field label="Contact phone"><input value={f.contact_phone ?? ''} onChange={set('contact_phone')} /></Field>
      </div>
      <Field label="Special billing instructions"><textarea value={f.special_instructions ?? ''} onChange={set('special_instructions')} /></Field>
      <Field label="Status"><select value={f.status} onChange={set('status')}><option value="active">Active</option><option value="inactive">Inactive</option></select></Field>
      <div className="row end"><button className="btn" onClick={onDone}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></div>
    </div>
  );
}

export function ClientsPage() {
  const { can } = useAuth();
  const q = useClients();
  const [edit, setEdit] = useState<any>(null);
  const [search, setSearch] = useState('');
  const rows = (q.data ?? []).filter((c) => !search || `${c.name} ${c.short_code}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <PageHead title="Departments / Clients" sub="Each department has its own contracts, rates, tax rules and bill formats.">
        <input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {can('client.write') && <button className="btn primary" onClick={() => setEdit({})}>Add department</button>}
      </PageHead>
      <ErrorBox error={q.error} />
      <div className="panel tight">
        {q.isLoading ? <Loading /> : (
          <table className="t">
            <thead><tr><th>Name</th><th>Code</th><th>GSTIN</th><th>State</th><th className="num">Contracts</th><th className="num">Active</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}><td><Link to={`/clients/${c.id}`}>{c.name}</Link></td><td>{c.short_code}</td><td className="mono">{c.gstin}</td><td>{c.state_name}</td><td className="num">{c.contract_count}</td><td className="num">{c.active_contracts}</td><td><Status s={c.status} /></td></tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="empty">No departments yet. Add the first department to begin.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {edit && <Modal title="Department" onClose={() => setEdit(null)} wide><ClientForm initial={edit.id ? edit : undefined} onDone={() => setEdit(null)} /></Modal>}
    </>
  );
}

export function ClientDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['client', id], queryFn: () => api.get(`/clients/${id}`) });
  const [editing, setEditing] = useState(false);
  const [newContract, setNewContract] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const c = q.data;
  return (
    <>
      <PageHead title={c.name} sub={<>{c.short_code} · GSTIN {c.gstin || '—'} · <Status s={c.status} /></>}>
        {can('client.write') && <button className="btn" onClick={() => setEditing(true)}>Edit</button>}
        {can('client.write') && <button className="btn primary" onClick={() => setNewContract(true)}>Add contract</button>}
      </PageHead>
      <div className="grid g2">
        <div className="panel"><h3>Billing address</h3><div className="pre">{c.billing_address || '—'}</div>
          <h3 style={{ marginTop: 12 }}>Contact</h3><div>{[c.contact_name, c.contact_email, c.contact_phone].filter(Boolean).join(' · ') || '—'}</div></div>
        <div className="panel"><h3>Special billing instructions</h3><div className="pre">{c.special_instructions || '—'}</div></div>
      </div>
      <div className="panel tight">
        <table className="t">
          <thead><tr><th>Contract</th><th>Reference</th><th>Work order / PO</th><th>Validity</th><th>Status</th></tr></thead>
          <tbody>
            {c.contracts.map((k: any) => (
              <tr key={k.id}><td><Link to={`/contracts/${k.id}`}>{k.title}</Link></td><td>{k.reference_no}</td><td>{k.po_number}</td><td>{d(k.start_date)} – {k.end_date ? d(k.end_date) : 'open'}</td><td><Status s={k.status} /></td></tr>
            ))}
            {c.contracts.length === 0 && <tr><td colSpan={5} className="empty">No contracts yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {editing && <Modal title="Edit department" onClose={() => setEditing(false)} wide><ClientForm initial={c} onDone={() => { setEditing(false); q.refetch(); }} /></Modal>}
      {newContract && <Modal title="New contract" onClose={() => setNewContract(false)} wide><ContractForm initial={{ client_id: c.id }} onDone={() => { setNewContract(false); q.refetch(); }} /></Modal>}
    </>
  );
}
