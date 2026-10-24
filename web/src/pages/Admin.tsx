import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Field, Loading, Modal, PageHead, Tabs, useAction } from '../components/ui';
import { dt } from '../format';
import { useCategories, useClients, useDutyTypes, useSuppliers } from '../lookups';

const ROLES: [string, string][] = [['admin', 'Administrator'], ['operator', 'Billing operator'], ['reviewer', 'Billing reviewer'], ['approver', 'Approver'], ['readonly', 'Read-only']];

export function UsersPage() {
  const q = useQuery({ queryKey: ['users'], queryFn: () => api.get<any[]>('/users') });
  const [edit, setEdit] = useState<any>(null);
  const { run, busy } = useAction();
  const save = async () => {
    const body = { ...edit };
    if (!body.password) delete body.password;
    const r = await run(() => (edit.id ? api.patch(`/users/${edit.id}`, { name: body.name, role: body.role, active: body.active, password: body.password }) : api.post('/users', body)), 'User saved');
    if (r) { setEdit(null); q.refetch(); }
  };
  return (
    <>
      <PageHead title="User Management"><button className="btn primary" onClick={() => setEdit({ email: '', name: '', role: 'operator', password: '', active: true })}>Add user</button></PageHead>
      <ErrorBox error={q.error} />
      <div className="panel tight">{q.isLoading ? <Loading /> : (
        <table className="t"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th /></tr></thead>
          <tbody>{q.data?.map((u) => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{ROLES.find((r) => r[0] === u.role)?.[1]}</td><td>{u.active ? 'Active' : <span className="badge err">Disabled</span>}</td><td>{dt(u.created_at)}</td><td><button className="btn sm" onClick={() => setEdit({ ...u, password: '' })}>Edit</button></td></tr>)}</tbody></table>
      )}</div>
      <div className="panel small">
        <b>Roles.</b> Operator: enter/import duties, upload documents, prepare bills. Reviewer: verify and correct duties, review extracted terms, review bills and accept warnings. Approver: approve rates, taxes, templates and bills; mark bills submitted. Administrator: everything including configuration. Read-only: view only.
      </div>
      {edit && (
        <Modal title={edit.id ? 'Edit user' : 'Add user'} onClose={() => setEdit(null)}>
          <div className="grid">
            <Field label="Email" required><input type="email" disabled={!!edit.id} value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="Name" required><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Role"><select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>{ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label={edit.id ? 'Reset password (optional)' : 'Initial password'} required={!edit.id} hint="At least 10 characters with letters and digits. Share it securely; ask the user to change it."><input type="password" autoComplete="new-password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
            {edit.id && <label className="check"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />Active</label>}
            <div className="row end"><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></div>
          </div>
        </Modal>
      )}
    </>
  );
}

export function AuditPage() {
  const [sp] = useSearchParams();
  const [entityType, setEntityType] = useState(sp.get('entityType') ?? '');
  const [entityId, setEntityId] = useState(sp.get('entityId') ?? '');
  const [offset, setOffset] = useState(0);
  const q = useQuery({ queryKey: ['audit', entityType, entityId, offset], queryFn: () => api.get<any[]>(`/audit${qs({ entityType, entityId, limit: 100, offset })}`) });
  return (
    <>
      <PageHead title="Audit Logs" sub="Every change with who, when, and previous / new values.">
        <select value={entityType} onChange={(e) => { setEntityType(e.target.value); setOffset(0); }}><option value="">All records</option>{['bill', 'duty', 'rate_version', 'tax_rule', 'template_version', 'contract', 'client', 'document', 'extracted_item', 'billing_exception', 'user', 'setting', 'supplier'].map((t) => <option key={t}>{t}</option>)}</select>
        <input placeholder="Record id" value={entityId} onChange={(e) => setEntityId(e.target.value)} />
      </PageHead>
      <ErrorBox error={q.error} />
      <div className="panel tight">{q.isLoading ? <Loading /> : (
        <table className="t"><thead><tr><th>When</th><th>User</th><th>Record</th><th>Action</th><th>Changes</th><th>Note</th></tr></thead>
          <tbody>{q.data?.map((a) => (
            <tr key={a.id}><td className="nowrap">{dt(a.at)}</td><td>{a.user_name}</td><td>{a.entity_type}<div className="mono small muted">{a.entity_id?.slice(0, 13)}</div></td><td>{a.action}</td>
              <td className="small mono" style={{ maxWidth: 520, wordBreak: 'break-word' }}>{a.before && a.after ? Object.keys(a.after).filter((k) => JSON.stringify(a.before[k]) !== JSON.stringify(a.after[k])).slice(0, 12).map((k) => <div key={k}>{k}: {JSON.stringify(a.before[k])} → {JSON.stringify(a.after[k])}</div>) : a.after ? JSON.stringify(a.after).slice(0, 300) : ''}</td><td>{a.note}</td></tr>
          ))}</tbody></table>
      )}</div>
      <div className="row"><button className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Newer</button><button className="btn sm" disabled={(q.data?.length ?? 0) < 100} onClick={() => setOffset(offset + 100)}>Older</button></div>
    </>
  );
}

type STab = 'supplier' | 'categories' | 'types' | 'vehicles' | 'drivers' | 'rules' | 'account';

export function SettingsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<STab>('supplier');
  return (
    <>
      <PageHead title="System Settings" />
      <Tabs<STab> tabs={[['supplier', 'Supplier profiles'], ['categories', 'Vehicle categories'], ['types', 'Duty types'], ['vehicles', 'Vehicles'], ['drivers', 'Drivers'], ['rules', 'Validation & approvals'], ['account', 'My password']]} value={tab} onChange={setTab} />
      {tab === 'supplier' && <Suppliers canEdit={can('settings.write')} />}
      {tab === 'categories' && <Categories canEdit={can('settings.write')} />}
      {tab === 'types' && <DutyTypes canEdit={can('settings.write')} />}
      {tab === 'vehicles' && <Vehicles canEdit={can('duty.write')} />}
      {tab === 'drivers' && <Drivers canEdit={can('duty.write')} />}
      {tab === 'rules' && <Rules canEdit={can('settings.write')} />}
      {tab === 'account' && <Password />}
    </>
  );
}

function Suppliers({ canEdit }: { canEdit: boolean }) {
  const q = useSuppliers();
  const qc = useQueryClient();
  const [edit, setEdit] = useState<any>(null);
  const { run, busy } = useAction();
  const save = async () => { if (await run(() => (edit.id ? api.put(`/suppliers/${edit.id}`, edit) : api.post('/suppliers', edit)), 'Saved')) { setEdit(null); qc.invalidateQueries({ queryKey: ['suppliers'] }); } };
  const set = (k: string) => (e: React.ChangeEvent<any>) => setEdit({ ...edit, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <>
      <div className="panel tight"><table className="t"><thead><tr><th>Name</th><th>GSTIN</th><th>PAN</th><th>State</th><th>Default</th><th /></tr></thead>
        <tbody>{q.data?.map((s) => <tr key={s.id}><td>{s.name}<div className="small muted pre">{s.address}</div></td><td className="mono">{s.gstin}</td><td>{s.pan}</td><td>{s.state_name} {s.state_code}</td><td>{s.is_default ? '✔' : ''}</td><td>{canEdit && <button className="btn sm" onClick={() => setEdit(s)}>Edit</button>}</td></tr>)}
          {q.data?.length === 0 && <tr><td colSpan={6} className="empty">Add LR Taxi Services' invoicing details. They are printed on every bill.</td></tr>}</tbody></table></div>
      {canEdit && <button className="btn primary" onClick={() => setEdit({ name: '', address: '', gstin: '', pan: '', state_name: '', state_code: '', phone: '', email: '', bank_details: '', is_default: (q.data?.length ?? 0) === 0 })}>Add supplier profile</button>}
      {edit && (
        <Modal title="Supplier profile" onClose={() => setEdit(null)}>
          <div className="grid">
            <Field label="Legal name" required><input value={edit.name} onChange={set('name')} /></Field>
            <Field label="Address"><textarea value={edit.address} onChange={set('address')} /></Field>
            <div className="grid g2"><Field label="GSTIN"><input value={edit.gstin ?? ''} onChange={set('gstin')} /></Field><Field label="PAN"><input value={edit.pan ?? ''} onChange={set('pan')} /></Field>
              <Field label="State"><input value={edit.state_name ?? ''} onChange={set('state_name')} /></Field><Field label="State code"><input value={edit.state_code ?? ''} onChange={set('state_code')} /></Field>
              <Field label="Phone"><input value={edit.phone ?? ''} onChange={set('phone')} /></Field><Field label="Email"><input value={edit.email ?? ''} onChange={set('email')} /></Field></div>
            <Field label="Bank details (printed via {bankDetails})"><textarea value={edit.bank_details ?? ''} onChange={set('bank_details')} /></Field>
            <label className="check"><input type="checkbox" checked={edit.is_default} onChange={set('is_default')} />Default profile</label>
            <div className="row end"><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></div>
          </div>
        </Modal>
      )}
    </>
  );
}

function Categories({ canEdit }: { canEdit: boolean }) {
  const q = useCategories();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const { run } = useAction();
  return (
    <div className="panel">
      <table className="t"><tbody>{q.data?.map((c) => <tr key={c.id}><td>{c.name}</td></tr>)}</tbody></table>
      {canEdit && <div className="row" style={{ marginTop: 8 }}><input placeholder="e.g. Innova Crysta" value={name} onChange={(e) => setName(e.target.value)} /><button className="btn primary" disabled={!name.trim()} onClick={async () => { if (await run(() => api.post('/vehicle-categories', { name }), 'Added')) { setName(''); qc.invalidateQueries({ queryKey: ['vehicle-categories'] }); } }}>Add category</button></div>}
      <p className="small muted">Category names are matched (case-insensitive) when importing duty sheets.</p>
    </div>
  );
}

function DutyTypes({ canEdit }: { canEdit: boolean }) {
  const q = useDutyTypes();
  const qc = useQueryClient();
  const [f, setF] = useState({ code: '', name: '' });
  const { run } = useAction();
  return (
    <div className="panel">
      <table className="t"><tbody>{q.data?.map((t) => <tr key={t.code}><td className="mono">{t.code}</td><td>{t.name}</td></tr>)}</tbody></table>
      {canEdit && <div className="row" style={{ marginTop: 8 }}><input placeholder="CODE" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} style={{ width: 120 }} /><input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><button className="btn primary" disabled={!f.code || !f.name} onClick={async () => { if (await run(() => api.post('/duty-types', f), 'Saved')) { setF({ code: '', name: '' }); qc.invalidateQueries({ queryKey: ['duty-types'] }); } }}>Add / update</button></div>}
    </div>
  );
}

function Vehicles({ canEdit }: { canEdit: boolean }) {
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ['vehicles', search], queryFn: () => api.get<any[]>(`/vehicles${qs({ q: search })}`) });
  const cats = useCategories();
  const clients = useClients();
  const [f, setF] = useState({ registration_no: '', category_id: '', vendor_name: '', client_id: '' });
  const { run } = useAction();
  return (
    <div className="panel">
      <div className="row"><input placeholder="Search vehicle no." value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <table className="t"><thead><tr><th>Vehicle no.</th><th>Category</th><th>Vendor</th><th>Department</th></tr></thead>
        <tbody>{q.data?.map((v) => <tr key={v.id}><td className="mono">{v.registration_no}</td><td>{v.category_name}</td><td>{v.vendor_name}</td><td>{v.client_name}</td></tr>)}</tbody></table>
      {canEdit && <div className="row" style={{ marginTop: 8 }}>
        <input placeholder="Registration no." value={f.registration_no} onChange={(e) => setF({ ...f, registration_no: e.target.value })} />
        <select value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}><option value="">Category…</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <input placeholder="Vendor" value={f.vendor_name} onChange={(e) => setF({ ...f, vendor_name: e.target.value })} />
        <select value={f.client_id} onChange={(e) => setF({ ...f, client_id: e.target.value })}><option value="">Department…</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button className="btn primary" disabled={!f.registration_no} onClick={async () => { if (await run(() => api.post('/vehicles', { ...f, category_id: f.category_id || null, client_id: f.client_id || null }), 'Vehicle added')) { setF({ registration_no: '', category_id: '', vendor_name: '', client_id: '' }); q.refetch(); } }}>Add vehicle</button></div>}
      <p className="small muted">When the vehicle register has entries, duties for unregistered vehicles are flagged with a warning.</p>
    </div>
  );
}

function Drivers({ canEdit }: { canEdit: boolean }) {
  const q = useQuery({ queryKey: ['drivers'], queryFn: () => api.get<any[]>('/drivers') });
  const [f, setF] = useState({ name: '', phone: '', licence_no: '' });
  const { run } = useAction();
  return (
    <div className="panel">
      <table className="t"><thead><tr><th>Name</th><th>Phone</th><th>Licence</th></tr></thead><tbody>{q.data?.map((x) => <tr key={x.id}><td>{x.name}</td><td>{x.phone}</td><td>{x.licence_no}</td></tr>)}</tbody></table>
      {canEdit && <div className="row" style={{ marginTop: 8 }}><input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><input placeholder="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /><input placeholder="Licence no." value={f.licence_no} onChange={(e) => setF({ ...f, licence_no: e.target.value })} />
        <button className="btn primary" disabled={!f.name} onClick={async () => { if (await run(() => api.post('/drivers', f), 'Driver added')) { setF({ name: '', phone: '', licence_no: '' }); q.refetch(); } }}>Add driver</button></div>}
    </div>
  );
}

function Rules({ canEdit }: { canEdit: boolean }) {
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get('/settings') });
  const [v, setV] = useState<any>(null);
  const [mc, setMc] = useState(false);
  const { run, busy } = useAction();
  useEffect(() => { if (q.data) { setV(q.data.validation); setMc(!!q.data.makerChecker); } }, [q.data]);
  if (!v) return <Loading />;
  return (
    <div className="panel grid" style={{ maxWidth: 760 }}>
      <h3>Default duty validation (contracts may override)</h3>
      <div className="grid g3">
        <Field label="Review threshold: km per duty"><input type="number" value={v.maxKmPerDuty} disabled={!canEdit} onChange={(e) => setV({ ...v, maxKmPerDuty: Number(e.target.value) })} /></Field>
        <Field label="Review threshold: hours per duty"><input type="number" value={v.maxHoursPerDuty} disabled={!canEdit} onChange={(e) => setV({ ...v, maxHoursPerDuty: Number(e.target.value) })} /></Field>
        <label className="check"><input type="checkbox" disabled={!canEdit} checked={v.requireExpenseEvidence} onChange={(e) => setV({ ...v, requireExpenseEvidence: e.target.checked })} />Require document reference for toll/parking</label>
      </div>
      <Field label="Mandatory duty fields" hint="Comma-separated: dutyDate, vehicleRegNo, vehicleCategoryId, driverName, fieldOfficer, dutyTypeCode, startKm, endKm, startAt, endAt">
        <input disabled={!canEdit} value={v.mandatoryFields.join(', ')} onChange={(e) => setV({ ...v, mandatoryFields: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
      </Field>
      <h3>Approvals</h3>
      <label className="check"><input type="checkbox" disabled={!canEdit} checked={mc} onChange={(e) => setMc(e.target.checked)} />Maker-checker: the person who prepares a bill, rate version, tax rule or template cannot approve it</label>
      {canEdit && <div className="row end"><button className="btn primary" disabled={busy} onClick={async () => { await run(() => api.put('/settings/validation', { value: v })); await run(() => api.put('/settings/makerChecker', { value: mc }), 'Settings saved'); q.refetch(); }}>Save</button></div>}
    </div>
  );
}

function Password() {
  const [f, setF] = useState({ currentPassword: '', newPassword: '' });
  const { run, busy } = useAction();
  return (
    <div className="panel grid" style={{ maxWidth: 420 }}>
      <Field label="Current password"><input type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} /></Field>
      <Field label="New password" hint="At least 10 characters with letters and digits"><input type="password" autoComplete="new-password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} /></Field>
      <button className="btn primary" disabled={busy} onClick={async () => { if (await run(() => api.post('/auth/change-password', f), 'Password changed')) setF({ currentPassword: '', newPassword: '' }); }}>Change password</button>
    </div>
  );
}
