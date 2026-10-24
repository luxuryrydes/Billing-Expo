import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Field, PageHead, useAction } from '../components/ui';
import { d, inr } from '../format';
import { useClients } from '../lookups';

const DOC_TYPES: [string, string][] = [
  ['contract', 'Contract / GeM order'], ['rate_schedule', 'Rate schedule / BOQ'], ['sample_invoice', 'Sample bill (billing format)'], ['duty_sheet', 'Duty sheet'],
  ['tender', 'Tender'], ['scc', 'SCC'], ['acc', 'ACC'], ['work_order', 'Work order'], ['other', 'Other'],
];

function guessType(name: string): string {
  const n = name.toLowerCase();
  if (/rate|boq|tariff/.test(n)) return 'rate_schedule';
  if (/duty|day to day|log ?sheet|trip/.test(n)) return 'duty_sheet';
  if (/bill|invoice|inv\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/.test(n)) return 'sample_invoice';
  if (/contract|gem|order|agreement/.test(n)) return 'contract';
  return 'other';
}

interface Src { value: string; page: number | null; text: string; doc?: string; confidence?: number }
interface PField { value: string; source?: Src; alternatives?: Src[]; note?: string; confirm?: boolean }
type Step = 'upload' | 'reading' | 'review' | 'done';

export function OnboardingPage() {
  const { can } = useAuth();
  const [step, setStep] = useState<Step>('upload');
  const [files, setFiles] = useState<{ file: File; type: string }[]>([]);
  const [useAi, setUseAi] = useState(true);
  const [docs, setDocs] = useState<{ name: string; documentId: string; versionId: string; status: string; error?: string }[]>([]);
  const [session, setSession] = useState<string>('');
  const [p, setP] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<any>(null);
  const { run, busy } = useAction();

  const upload = async () => {
    setError(null);
    const out: typeof docs = [];
    for (const f of files) {
      const fd = new FormData();
      fd.append('doc_type', f.type);
      fd.append('title', f.file.name.replace(/\.[^.]+$/, ''));
      fd.append('run_ai', String(useAi));
      fd.append('file', f.file);
      try {
        const v = await api.post('/documents', fd);
        out.push({ name: f.file.name, documentId: v.document_id, versionId: v.id, status: 'running' });
      } catch (e) {
        out.push({ name: f.file.name, documentId: '', versionId: '', status: 'failed', error: errorText(e) });
      }
    }
    setDocs(out);
    setStep('reading');
  };

  // Poll extraction, then analyse
  useEffect(() => {
    if (step !== 'reading') return;
    let stop = false;
    const tick = async () => {
      const next = await Promise.all(docs.map(async (x) => {
        if (!x.documentId || ['done', 'failed'].includes(x.status)) return x;
        const doc = await api.get(`/documents/${x.documentId}`);
        const v = doc.versions.find((y: any) => y.id === x.versionId);
        return { ...x, status: v?.extraction_status ?? x.status, error: v?.extraction_error ?? undefined };
      }));
      if (stop) return;
      setDocs(next);
      if (next.every((x) => ['done', 'failed'].includes(x.status))) {
        const ok = next.filter((x) => x.status === 'done');
        if (!ok.length) { setError(new Error('None of the documents could be read.')); return; }
        try {
          const r = await api.post('/onboarding/analyze', { versionIds: ok.map((x) => x.versionId) });
          setSession(r.sessionId);
          setP(r.proposal);
          setStep('review');
        } catch (e) { setError(e); }
      } else setTimeout(tick, 1500);
    };
    const t = setTimeout(tick, 1000);
    return () => { stop = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  if (!can('client.write') || !can('rate.write')) return <><PageHead title="Set up from documents" /><div className="alert warn">An administrator sets up departments from documents.</div></>;

  return (
    <>
      <PageHead title="Set up from documents" sub="Upload a department's contract, rate schedule and a sample bill (and optionally a duty sheet). The details are read from them and shown here for you to check before anything is created." />
      <div className="steps">{(['upload', 'reading', 'review', 'done'] as Step[]).map((s, i) => <div key={s} className={`s ${s === step ? 'cur' : ['upload', 'reading', 'review', 'done'].indexOf(step) > i ? 'done' : ''}`}>{i + 1}. {{ upload: 'Upload documents', reading: 'Reading', review: 'Check & correct', done: 'Created' }[s]}</div>)}</div>
      <ErrorBox error={error} />

      {step === 'upload' && (
        <div className="panel grid" style={{ maxWidth: 900 }}>
          <Field label="Documents" hint="PDF, Excel, Word or scanned images. Examples: GeM contract, rate schedule / BOQ, a previous bill in the department's format, the day-to-day duty sheet.">
            <input type="file" multiple accept=".pdf,.xlsx,.csv,.docx,.png,.jpg,.jpeg" onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? []).map((f) => ({ file: f, type: guessType(f.name) }))])} />
          </Field>
          {files.length > 0 && (
            <table className="t"><thead><tr><th>File</th><th>What it is</th><th /></tr></thead>
              <tbody>{files.map((f, i) => (
                <tr key={i}><td>{f.file.name}</td>
                  <td><select value={f.type} onChange={(e) => setFiles(files.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>{DOC_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
                  <td><button className="btn sm danger" onClick={() => setFiles(files.filter((_, j) => j !== i))}>Remove</button></td></tr>
              ))}</tbody></table>
          )}
          <label className="check"><input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />Also use AI reading where configured (every AI value must quote the document)</label>
          <div className="row end"><button className="btn primary" disabled={!files.length} onClick={upload}>Upload and read</button></div>
        </div>
      )}

      {step === 'reading' && (
        <div className="panel">
          <table className="t"><tbody>{docs.map((x) => <tr key={x.name}><td>{x.name}</td><td>{x.status === 'done' ? '✔ read' : x.status === 'failed' ? <span style={{ color: 'var(--err)' }}>✖ {x.error}</span> : 'reading…'}</td></tr>)}</tbody></table>
          <p className="small muted">Large duty sheets take a little longer.</p>
        </div>
      )}

      {step === 'review' && p && <Review p={p} setP={setP} busy={busy} onCreate={async (body) => {
        const r = await run(() => api.post(`/onboarding/${session}/apply`, body), 'Created');
        if (r) { setCreated(r); setStep('done'); }
      }} />}

      {step === 'done' && created && (
        <div className="panel grid" style={{ maxWidth: 900 }}>
          <div className="alert ok">The department and contract are set up. Rates, tax and the bill format were created as <b>drafts</b>: they apply to bills only after they are checked and approved.</div>
          <h3>Next steps</h3>
          <ol>
            <li><Link to={`/contracts/${created.contractId}`}>Open the contract</Link> — check the details and the extracted terms.</li>
            <li>Rate schemes ({created.rateVersions.length} drafts): open each from the contract's <b>Rate schemes</b> tab, compare with the rate schedule, try the test calculator, then <b>Submit for approval</b>; an approver approves.</li>
            <li>Tax rules ({created.taxRules.length} drafts): on the contract's <b>Tax rules</b> tab, confirm the rate and source, then approve.</li>
            {created.templateVersionId && <li><Link to={`/templates/versions/${created.templateVersionId}`}>Bill format</Link>: preview it against the sample bill and approve it. Bills can be exported in both Excel and PDF.</li>}
            <li>Enter or import duties (<Link to="/duties/entry">Daily Duty Entry</Link> → Import; a shared duty sheet is split by its Department column), then prepare month-wise or date-wise bills in the <Link to="/billing">Billing Workspace</Link>.</li>
          </ol>
          {created.billSeries && <p className="small muted">Bill numbers continue the series {created.billSeries.prefix}… from {created.billSeries.next}.</p>}
        </div>
      )}
    </>
  );
}

function SourceNote({ f }: { f?: PField }) {
  if (!f) return null;
  return (
    <span className="small muted">
      {f.source && <span title={f.source.text}>from {f.source.doc ?? 'document'}{f.source.page ? ` p.${f.source.page}` : ''}{f.source.text ? ` — “${f.source.text.slice(0, 80)}${f.source.text.length > 80 ? '…' : ''}”` : ''}</span>}
      {!f.source && !f.value && <span style={{ color: 'var(--warn)' }}>not found — enter it</span>}
      {f.note && <div>{f.note}</div>}
    </span>
  );
}

function PInput({ label, f, onChange, type = 'text', required, wide }: { label: string; f: PField; onChange: (v: string) => void; type?: string; required?: boolean; wide?: boolean }) {
  return (
    <label className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <span className={required ? 'req' : ''}>{label}{f.confirm && <span className="badge warn" style={{ marginLeft: 6 }}>confirm</span>}</span>
      {type === 'textarea' ? <textarea value={f.value} onChange={(e) => onChange(e.target.value)} /> : <input type={type} value={f.value} onChange={(e) => onChange(e.target.value)} />}
      {(f.alternatives ?? []).length > 0 && (
        <span className="row">{f.alternatives!.map((a, i) => <button key={i} type="button" className="btn sm" title={`${a.doc ?? ''} ${a.page ? 'p.' + a.page : ''}`} onClick={() => onChange(a.value)}>use “{a.value.slice(0, 50)}”</button>)}</span>
      )}
      <SourceNote f={f} />
    </label>
  );
}

function Review({ p, setP, busy, onCreate }: { p: any; setP: (x: any) => void; busy: boolean; onCreate: (body: any) => void }) {
  const clients = useClients();
  const [existingClient, setExistingClient] = useState('');
  const [includeTemplate, setIncludeTemplate] = useState(!!p.template);
  const [templateName, setTemplateName] = useState(`${p.client.short_code.value || 'Department'} bill`);
  const [contractStatus, setContractStatus] = useState<'active' | 'draft'>('active');
  const [bank, setBank] = useState('');
  const setF = (section: string, key: string) => (v: string) => setP({ ...p, [section]: { ...p[section], [key]: { ...p[section][key], value: v } } });
  const val = (section: string, key: string) => p[section][key]?.value || null;
  const setRate = (i: number, path: string, v: string) => {
    const rates = structuredClone(p.rates);
    const r = rates[i];
    if (path.startsWith('pkg:')) r.packages[Number(path.slice(4))].rate.value = v;
    else r[path] = { ...(r[path] ?? { page: null, text: 'entered manually' }), value: v };
    setP({ ...p, rates });
  };
  const create = () => {
    const c = p.contract;
    onCreate({
      client: {
        existingId: existingClient || null, name: val('client', 'name'), short_code: val('client', 'short_code'), billing_address: val('client', 'billing_address') ?? '',
        gstin: val('client', 'gstin'), state_name: val('client', 'state_name'), state_code: val('client', 'state_code'), contact_name: val('client', 'contact_name'),
        contact_email: val('client', 'contact_email'), contact_phone: val('client', 'contact_phone'), special_instructions: val('client', 'special_instructions'), aliases: p.clientAliases,
      },
      supplier: {
        name: val('supplier', 'name'), gstin: val('supplier', 'gstin'), pan: val('supplier', 'pan'), address: val('supplier', 'address') ?? '', email: val('supplier', 'email'),
        phone: val('supplier', 'phone'), msme: val('supplier', 'msme'), state_name: val('supplier', 'state_name'), state_code: val('supplier', 'state_code'), tagline: val('supplier', 'tagline'), bank_details: bank || null,
      },
      contract: {
        title: c.title.value, reference_no: c.reference_no.value, bid_no: c.bid_no.value || null, po_number: c.po_number.value || null, start_date: c.start_date.value, end_date: c.end_date.value || null,
        billing_frequency: c.billing_frequency.value, contract_value: c.contract_value.value || null, sac_code: c.sac_code.value || null, tax_mode: c.tax_mode.value,
        invoice_rounding: c.invoice_rounding.value, bill_no_format: c.bill_no_format.value, status: contractStatus,
      },
      categories: p.categories,
      rates: p.rates,
      rateOptions: p.rateOptions,
      taxes: p.taxes,
      template: includeTemplate && p.template ? { name: templateName, layout: p.template.layout } : null,
      billSeries: p.billSeries,
    });
  };
  const ro = p.rateOptions;
  return (
    <>
      {p.questions.length > 0 && <div className="alert warn"><b>Please check:</b><ul style={{ margin: '4px 0 0' }}>{p.questions.map((q: string, i: number) => <li key={i}>{q}</li>)}</ul></div>}
      <div className="panel small">Read from: {p.documents.map((x: any) => <span key={x.versionId} className="badge" style={{ marginRight: 6 }}>{x.title} — {x.kind.replace('_', ' ')}</span>)}</div>

      <div className="panel">
        <h2>Department / client</h2>
        <Field label="Add to an existing department instead"><select value={existingClient} onChange={(e) => setExistingClient(e.target.value)}><option value="">No — create a new department</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        {!existingClient && <div className="grid g3" style={{ marginTop: 10 }}>
          <PInput label="Department name" required f={p.client.name} onChange={setF('client', 'name')} />
          <PInput label="Short code" required f={p.client.short_code} onChange={setF('client', 'short_code')} />
          <Field label="Codes used on duty sheets" hint="Comma-separated, e.g. DRI"><input value={p.clientAliases.join(', ')} onChange={(e) => setP({ ...p, clientAliases: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
          <PInput label="Billing address" f={p.client.billing_address} onChange={setF('client', 'billing_address')} type="textarea" wide />
          <PInput label="GSTIN" f={p.client.gstin} onChange={setF('client', 'gstin')} />
          <PInput label="State" f={p.client.state_name} onChange={setF('client', 'state_name')} />
          <PInput label="State code" f={p.client.state_code} onChange={setF('client', 'state_code')} />
          <PInput label="Contact (designation)" f={p.client.contact_name} onChange={setF('client', 'contact_name')} />
          <PInput label="Email" f={p.client.contact_email} onChange={setF('client', 'contact_email')} />
          <PInput label="Phone" f={p.client.contact_phone} onChange={setF('client', 'contact_phone')} />
          <PInput label="Notes (ministry, department, payment)" f={p.client.special_instructions} onChange={setF('client', 'special_instructions')} wide />
        </div>}
      </div>

      <div className="panel">
        <h2>Contract</h2>
        <div className="grid g3">
          <PInput label="Title" required f={p.contract.title} onChange={setF('contract', 'title')} />
          <PInput label="Contract no." required f={p.contract.reference_no} onChange={setF('contract', 'reference_no')} />
          <PInput label="Bid / tender no." f={p.contract.bid_no} onChange={setF('contract', 'bid_no')} />
          <PInput label="Order / PO no." f={p.contract.po_number} onChange={setF('contract', 'po_number')} />
          <PInput label="Start date" required type="date" f={p.contract.start_date} onChange={setF('contract', 'start_date')} />
          <PInput label="End date" type="date" f={p.contract.end_date} onChange={setF('contract', 'end_date')} />
          <label className="field"><span>Billing</span><select value={p.contract.billing_frequency.value} onChange={(e) => setF('contract', 'billing_frequency')(e.target.value)}><option value="monthly">Month-wise</option><option value="daily">Date-wise</option><option value="fortnightly">Fortnightly</option><option value="weekly">Weekly</option></select><SourceNote f={p.contract.billing_frequency} /></label>
          <PInput label="Contract value (₹)" f={p.contract.contract_value} onChange={setF('contract', 'contract_value')} />
          <PInput label="SAC code" f={p.contract.sac_code} onChange={setF('contract', 'sac_code')} />
          <label className="field"><span>Rates are</span><select value={p.contract.tax_mode.value} onChange={(e) => setF('contract', 'tax_mode')(e.target.value)}><option value="exclusive">Excluding GST</option><option value="inclusive">Including GST</option></select><SourceNote f={p.contract.tax_mode} /></label>
          <label className="field"><span>Bill total rounding</span><select value={p.contract.invoice_rounding.value} onChange={(e) => setF('contract', 'invoice_rounding')(e.target.value)}><option value="none">None</option><option value="nearest_rupee">Nearest rupee</option><option value="down_rupee">Down to rupee</option><option value="up_rupee">Up to rupee</option></select><SourceNote f={p.contract.invoice_rounding} /></label>
          <label className="field"><span>Status</span><select value={contractStatus} onChange={(e) => setContractStatus(e.target.value as never)}><option value="active">Active</option><option value="draft">Draft</option></select></label>
          <PInput label="Bill number format" f={p.contract.bill_no_format} onChange={setF('contract', 'bill_no_format')} />
          {p.billSeries && <Field label="Next bill number in this series" hint={`Last sample: ${p.billSeries.sample}`}><input type="number" value={p.billSeries.nextNumber ?? ''} onChange={(e) => setP({ ...p, billSeries: { ...p.billSeries, nextNumber: e.target.value ? Number(e.target.value) : null } })} /></Field>}
        </div>
        <p className="small muted">Format tokens: {'{CLIENT} {FY} (2026-27) {FYS} (26-27) {YYYY} {MM} {DD} {SEQ:4}'}</p>
      </div>

      <div className="panel">
        <h2>Our invoicing details (supplier)</h2>
        <div className="grid g3">
          <PInput label="Name" required f={p.supplier.name} onChange={setF('supplier', 'name')} />
          <PInput label="GSTIN used on bills" f={p.supplier.gstin} onChange={(v) => setP({ ...p, supplier: { ...p.supplier, gstin: { ...p.supplier.gstin, value: v }, state_code: { value: v.slice(0, 2) } } })} />
          <PInput label="PAN" f={p.supplier.pan} onChange={setF('supplier', 'pan')} />
          <PInput label="Address" f={p.supplier.address} onChange={setF('supplier', 'address')} type="textarea" wide />
          <PInput label="Email" f={p.supplier.email} onChange={setF('supplier', 'email')} />
          <PInput label="Phone" f={p.supplier.phone} onChange={setF('supplier', 'phone')} />
          <PInput label="MSME / Udyam no." f={p.supplier.msme} onChange={setF('supplier', 'msme')} />
          <PInput label="Heading on bills" f={p.supplier.tagline} onChange={setF('supplier', 'tagline')} />
          <Field label="Bank details (optional)"><textarea value={bank} onChange={(e) => setBank(e.target.value)} /></Field>
        </div>
        <p className="small muted">If a profile with this GSTIN already exists it is reused.</p>
      </div>

      <div className="panel">
        <h2>Vehicle categories and rates</h2>
        {p.rates.length === 0 ? <p className="muted">No rate table recognised. You can create rate schemes manually after setup.</p> : (
          <div className="scroll">
            <table className="t cols-editor">
              <thead><tr><th>Category</th><th>Names on duty sheets (aliases)</th>{p.rates[0].packages.map((pk: any, i: number) => <th key={i} className="num">{pk.hours} hrs / {pk.km} km</th>)}<th className="num">Extra / km</th><th className="num">Extra / hr</th><th className="num">Outstation / km</th><th className="num">Outstation / hr</th><th className="num">Night (local)</th><th className="num">Night (out)</th></tr></thead>
              <tbody>{p.rates.map((r: any, i: number) => (
                <tr key={i}>
                  <td><input value={p.categories[i]?.name ?? r.category} onChange={(e) => { const cats = structuredClone(p.categories); const rates = structuredClone(p.rates); cats[i].name = e.target.value; rates[i].category = e.target.value; setP({ ...p, categories: cats, rates }); }} /><div className="small muted">{r.description}</div></td>
                  <td><input value={(p.categories[i]?.aliases ?? []).join(', ')} onChange={(e) => { const cats = structuredClone(p.categories); cats[i].aliases = e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean); setP({ ...p, categories: cats }); }} /></td>
                  {r.packages.map((pk: any, j: number) => <td key={j}><input style={{ width: 80 }} value={pk.rate.value} onChange={(e) => setRate(i, `pkg:${j}`, e.target.value)} title={pk.rate.text} /></td>)}
                  {['extraKm', 'extraHour', 'outstationExtraKm', 'outstationExtraHour', 'nightLocal', 'nightOutstation'].map((k) => <td key={k}><input style={{ width: 70 }} value={r[k]?.value ?? ''} onChange={(e) => setRate(i, k, e.target.value)} title={r[k]?.text ?? 'not in the rate schedule'} /></td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {p.rates.length > 0 && <>
          <h3 style={{ marginTop: 12 }}>How hours and nights are counted</h3>
          {ro.notes.map((n: string, i: number) => <div key={i} className="alert warn" style={{ marginBottom: 6 }}>{n}</div>)}
          <div className="row">
            Extra hours: <select value={ro.hourRoundingMode} onChange={(e) => setP({ ...p, rateOptions: { ...ro, hourRoundingMode: e.target.value } })}><option value="ceil">round up</option><option value="nearest">round to nearest</option><option value="floor">round down</option><option value="exact">exact minutes</option></select>
            to <select value={ro.hourRoundingUnit} onChange={(e) => setP({ ...p, rateOptions: { ...ro, hourRoundingUnit: e.target.value } })}><option value="30">30 minutes</option><option value="60">1 hour</option><option value="15">15 minutes</option></select>
            <span className="spacer" />
            <label className="check"><input type="checkbox" checked={ro.nightEnabled} onChange={(e) => setP({ ...p, rateOptions: { ...ro, nightEnabled: e.target.checked } })} />Night charge when the duty runs between</label>
            <input type="time" value={ro.nightStart} onChange={(e) => setP({ ...p, rateOptions: { ...ro, nightStart: e.target.value } })} /> and <input type="time" value={ro.nightEnd} onChange={(e) => setP({ ...p, rateOptions: { ...ro, nightEnd: e.target.value } })} />
            <label className="check"><input type="checkbox" checked={ro.createOutstation} onChange={(e) => setP({ ...p, rateOptions: { ...ro, createOutstation: e.target.checked } })} />Create outstation rates</label>
          </div>
        </>}
      </div>

      <div className="panel">
        <h2>Tax</h2>
        {p.taxes.length === 0 ? <p className="muted">No tax found in the documents — add it on the contract after setup.</p> : (
          <table className="t cols-editor"><thead><tr><th>Tax</th><th className="num">Rate %</th><th>Source / authority (shown to the approver)</th><th>Check</th><th /></tr></thead>
            <tbody>{p.taxes.map((t: any, i: number) => (
              <tr key={i}>
                <td><select value={t.tax_type} onChange={(e) => { const x = structuredClone(p.taxes); x[i].tax_type = e.target.value; setP({ ...p, taxes: x }); }}>{['IGST', 'CGST', 'SGST', 'UTGST', 'CESS', 'OTHER'].map((k) => <option key={k}>{k}</option>)}</select></td>
                <td><input style={{ width: 70 }} value={t.rate} onChange={(e) => { const x = structuredClone(p.taxes); x[i].rate = e.target.value; setP({ ...p, taxes: x }); }} /></td>
                <td><input value={t.source_ref} onChange={(e) => { const x = structuredClone(p.taxes); x[i].source_ref = e.target.value; setP({ ...p, taxes: x }); }} /></td>
                <td className="small">{t.note}</td>
                <td><button className="btn sm danger" onClick={() => setP({ ...p, taxes: p.taxes.filter((_: any, j: number) => j !== i) })}>Remove</button></td>
              </tr>
            ))}</tbody></table>
        )}
        <p className="small muted">Tax rules are created as drafts and must be approved before they apply.</p>
      </div>

      <div className="panel">
        <h2>Bill format</h2>
        {!p.template ? <p className="muted">No sample bill uploaded — a standard layout can be designed under Billing Templates.</p> : <>
          {p.template.notes.map((n: string, i: number) => <p key={i} className="small">{n}</p>)}
          {p.sampleBill && <p className="small muted">Sample bill totals: taxable {inr(p.sampleBill.taxableTotal)}, non-taxable {inr(p.sampleBill.nonTaxableTotal)}, total {inr(p.sampleBill.grandTotal)}.</p>}
          {p.template.layout.rowMode === 'block' && (
            <div className="trace" style={{ marginBottom: 8 }}>
              {p.template.layout.block.header}<br />{p.template.layout.block.packageLabel}<br />{p.template.layout.block.runningLabel}<br />
              {Object.values(p.template.layout.block.componentLabels).join(' · ')}
            </div>
          )}
          <div className="row"><label className="check"><input type="checkbox" checked={includeTemplate} onChange={(e) => setIncludeTemplate(e.target.checked)} />Create this bill format (draft)</label>
            <input value={templateName} onChange={(e) => setTemplateName(e.target.value)} style={{ width: 260 }} /></div>
          <p className="small muted">Every bill can be downloaded as Excel and as PDF in this format. Preview and approve it under Billing Templates.</p>
        </>}
      </div>

      {p.dutySheet && (
        <div className="panel">
          <h2>Duty sheet</h2>
          <p className="small">{p.dutySheet.title}: {p.dutySheet.rows} rows, {Object.keys(p.dutySheet.departments).length} departments ({Object.entries(p.dutySheet.departments).sort((a: any, b: any) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ')}…).</p>
          <p className="small muted">After setup, import it from Daily Duty Entry → Import: rows are sent to each department's contract by the Department column.</p>
        </div>
      )}

      <div className="panel row end">
        <span className="small muted">Contract {p.contract.reference_no.value} · {d(p.contract.start_date.value)} – {d(p.contract.end_date.value)}</span>
        <button className="btn primary" disabled={busy || !p.contract.reference_no.value || !p.contract.start_date.value || (!existingClient && !p.client.name.value)} onClick={create}>Create department, contract and drafts</button>
      </div>
    </>
  );
}
