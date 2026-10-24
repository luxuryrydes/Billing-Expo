import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, downloadBlob, errorText, fileUrl, qs } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Field, Loading, Modal, PageHead, Status, Tabs, useAction, useToast } from '../components/ui';
import { dt } from '../format';
import { useClients, useContracts } from '../lookups';

export function TemplatesPage() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const clients = useClients();
  const [clientId, setClientId] = useState(sp.get('client') ?? '');
  const q = useQuery({ queryKey: ['templates', clientId], queryFn: () => api.get<any[]>(`/templates${qs({ clientId })}`) });
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHead title="Billing Templates" sub="Each department's bill layout — designed here or mapped onto its own Excel workbook. Versions are locked once approved.">
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">All departments</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        {can('template.write') && <button className="btn primary" onClick={() => setAdding(true)}>New template</button>}
      </PageHead>
      <ErrorBox error={q.error} />
      <div className="panel tight">
        {q.isLoading ? <Loading /> : (
          <table className="t">
            <thead><tr><th>Department</th><th>Template</th><th>Applies to</th><th>Versions</th></tr></thead>
            <tbody>
              {q.data?.map((t) => (
                <tr key={t.id}><td>{t.client_name}</td><td>{t.name}<div className="small muted">{t.description}</div></td><td>{t.contract_ref ?? 'All contracts'}</td>
                  <td>{(t.versions ?? []).map((v: any) => <span key={v.id} style={{ marginRight: 10 }}><Link to={`/templates/versions/${v.id}`}>v{v.version_no}</Link> <Status s={v.status} />{v.has_xlsx && <span className="badge brand">xlsx</span>}</span>)}</td></tr>
              ))}
              {q.data?.length === 0 && <tr><td colSpan={4} className="empty">No templates yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {adding && <NewTemplate onClose={() => setAdding(false)} />}
    </>
  );
}

function NewTemplate({ onClose }: { onClose: () => void }) {
  const clients = useClients();
  const [f, setF] = useState({ client_id: '', contract_id: '', name: '', description: '' });
  const contracts = useContracts(f.client_id || undefined);
  const { run, busy } = useAction();
  const nav = useNavigate();
  return (
    <Modal title="New billing template" onClose={onClose}>
      <div className="grid">
        <Field label="Department" required><select value={f.client_id} onChange={(e) => setF({ ...f, client_id: e.target.value })}><option value="">Select…</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Contract" hint="Leave empty to use for all the department's contracts"><select value={f.contract_id} onChange={(e) => setF({ ...f, contract_id: e.target.value })}><option value="">All contracts</option>{contracts.data?.map((k) => <option key={k.id} value={k.id}>{k.reference_no}</option>)}</select></Field>
        <Field label="Name" required><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Monthly duty bill" /></Field>
        <div className="row end"><button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !f.client_id || !f.name} onClick={async () => {
            const t = await run(() => api.post('/templates', { ...f, contract_id: f.contract_id || null }));
            if (!t) return;
            const list = await api.get<any[]>(`/templates${qs({ clientId: f.client_id })}`);
            const v = list.find((x) => x.id === t.id)?.versions?.[0];
            if (v) nav(`/templates/versions/${v.id}`);
          }}>Create</button></div>
      </div>
    </Modal>
  );
}

type Tab = 'layout' | 'columns' | 'summary' | 'xlsx' | 'reference';

export function TemplateVersionPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['tv', id], queryFn: () => api.get(`/template-versions/${id}`) });
  const cols = useQuery({ queryKey: ['template-cols'], queryFn: () => api.get('/templates/columns') });
  const [layout, setLayout] = useState<any>(null);
  const [mapping, setMapping] = useState<string>('');
  const [tab, setTab] = useState<Tab>('layout');
  const [pdfUrl, setPdfUrl] = useState<string>('');
  const [previewBill, setPreviewBill] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { run, busy } = useAction();
  const bills = useQuery({ queryKey: ['bills-for-preview', q.data?.client_id], queryFn: () => api.get<any[]>(`/bills${qs({ clientId: q.data?.client_id })}`), enabled: !!q.data?.client_id });
  useEffect(() => { if (q.data) { setLayout(structuredClone(q.data.layout)); setMapping(q.data.xlsx_mapping ? JSON.stringify(q.data.xlsx_mapping, null, 2) : ''); setDirty(false); } }, [q.data]);
  if (q.isLoading || !layout) return q.error ? <ErrorBox error={q.error} /> : <Loading />;
  const v = q.data;
  const editable = v.status === 'draft' && can('template.write');
  const upd = (fn: (l: any) => void) => { const n = structuredClone(layout); fn(n); setLayout(n); setDirty(true); };
  const parsedMapping = () => { if (!mapping.trim()) return null; try { return JSON.parse(mapping); } catch { throw new Error('Workbook mapping is not valid JSON'); } };
  const save = async () => { const r = await run(() => api.put(`/template-versions/${id}`, { layout, xlsx_mapping: parsedMapping(), notes: v.notes }), 'Template saved'); if (r) q.refetch(); };
  const preview = async (format: 'pdf' | 'xlsx') => {
    try {
      const blob = await api.blob('POST', `/template-versions/${id}/preview`, { format, billId: previewBill || undefined, layout, xlsx_mapping: parsedMapping() });
      if (format === 'pdf') { if (pdfUrl) URL.revokeObjectURL(pdfUrl); setPdfUrl(URL.createObjectURL(blob)); }
      else downloadBlob(blob, `preview-${v.template_name}.xlsx`);
    } catch (e) { toast(errorText(e), true); }
  };
  const upload = async (kind: 'xlsx' | 'reference', file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    if (await run(() => api.post(`/template-versions/${id}/upload/${kind}`, fd), 'Uploaded')) q.refetch();
  };
  const dutyKeys: Record<string, string> = cols.data?.[layout.rowMode === 'line' ? 'line' : 'duty'] ?? {};
  return (
    <>
      <PageHead title={`${v.template_name} — v${v.version_no}`} sub={<><Status s={v.status} /> {v.approved_by_name && <span className="small muted">approved by {v.approved_by_name} {dt(v.approved_at)}</span>}</>}>
        {editable && <button className="btn primary" disabled={!dirty || busy} onClick={save}>Save</button>}
        {can('template.write') && <button className="btn" onClick={async () => { const r = await run(() => api.post(`/templates/${v.template_id}/versions`, { fromVersionId: id })); if (r) nav(`/templates/versions/${r.id}`); }}>Copy as new version</button>}
      </PageHead>
      {!editable && <div className="alert info">This version is {v.status} and locked. Bills keep the exact version they were approved with; copy it to make changes.</div>}
      <div className="split">
        <div>
          <Tabs<Tab> tabs={[['layout', 'Page & header'], ['columns', 'Table columns'], ['summary', 'Totals & footer'], ['xlsx', 'Department workbook'], ['reference', 'Reference sample']]} value={tab} onChange={setTab} />
          <fieldset disabled={!editable} style={{ border: 'none', padding: 0, margin: 0 }}>
            {tab === 'layout' && (
              <div className="panel grid">
                <div className="grid g4">
                  <Field label="Paper"><select value={layout.page.size} onChange={(e) => upd((l) => (l.page.size = e.target.value))}><option>A4</option><option>A3</option><option>LEGAL</option></select></Field>
                  <Field label="Orientation"><select value={layout.page.orientation} onChange={(e) => upd((l) => (l.page.orientation = e.target.value))}><option value="landscape">Landscape</option><option value="portrait">Portrait</option></select></Field>
                  <Field label="Font size"><input type="number" value={layout.page.fontSize} onChange={(e) => upd((l) => (l.page.fontSize = Number(e.target.value)))} /></Field>
                  <Field label="Margins (pt) L,T,R,B"><input value={layout.page.margins.join(',')} onChange={(e) => upd((l) => (l.page.margins = e.target.value.split(',').map(Number)))} /></Field>
                </div>
                <Field label="Title"><input value={layout.title} onChange={(e) => upd((l) => (l.title = e.target.value))} /></Field>
                <div className="row"><label className="check"><input type="checkbox" checked={layout.showSupplier} onChange={(e) => upd((l) => (l.showSupplier = e.target.checked))} />Supplier block</label>
                  <label className="check"><input type="checkbox" checked={layout.showClient} onChange={(e) => upd((l) => (l.showClient = e.target.checked))} />Client block</label></div>
                <Field label="Period label" hint="Tokens: {periodStart} {periodEnd} {monthName} {year}"><input value={layout.periodLabel} onChange={(e) => upd((l) => (l.periodLabel = e.target.value))} /></Field>
                <h3>Header fields</h3>
                {layout.headerFields.map((h: any, i: number) => (
                  <div className="row" key={i}><input style={{ width: 160 }} value={h.label} onChange={(e) => upd((l) => (l.headerFields[i].label = e.target.value))} /><input style={{ flex: 1 }} value={h.value} onChange={(e) => upd((l) => (l.headerFields[i].value = e.target.value))} /><button className="btn sm danger" onClick={() => upd((l) => l.headerFields.splice(i, 1))}>✕</button></div>
                ))}
                <div><button className="btn sm" onClick={() => upd((l) => l.headerFields.push({ label: '', value: '' }))}>Add header field</button></div>
                <p className="small muted">Placeholders: {'{billNo} {billDate} {periodLabel} {contractRef} {contractTitle} {poNumber} {clientName} {clientGstin} {supplierName} {supplierGstin} {bankDetails} {dutyCount}'}</p>
              </div>
            )}
            {tab === 'columns' && (
              <div className="panel">
                <div className="grid g3">
                  <Field label="One row per"><select value={layout.rowMode} onChange={(e) => upd((l) => (l.rowMode = e.target.value))}><option value="duty">Duty</option><option value="line">Charge line</option></select></Field>
                  <Field label="Sort by"><select value={layout.sortBy} onChange={(e) => upd((l) => (l.sortBy = e.target.value))}><option value="date">Date</option><option value="vehicle">Vehicle</option></select></Field>
                  <Field label="Subtotals by"><select value={layout.groupBy} onChange={(e) => upd((l) => (l.groupBy = e.target.value))}><option value="none">None</option><option value="vehicle">Vehicle</option><option value="date">Date</option></select></Field>
                </div>
                <table className="t cols-editor" style={{ marginTop: 10 }}>
                  <thead><tr><th>Field</th><th>Heading</th><th>Group heading</th><th>Format</th><th>Width</th><th>Total</th><th /></tr></thead>
                  <tbody>{layout.columns.map((c: any, i: number) => (
                    <tr key={i}>
                      <td><input list="colkeys" className="mono" value={c.key} onChange={(e) => upd((l) => (l.columns[i].key = e.target.value))} title={dutyKeys[c.key] ?? 'comp:<CODE>:amount|qty|rate or var:<name>'} /></td>
                      <td><input value={c.label} onChange={(e) => upd((l) => (l.columns[i].label = e.target.value))} /></td>
                      <td><input value={c.group ?? ''} onChange={(e) => upd((l) => (l.columns[i].group = e.target.value || undefined))} /></td>
                      <td><select value={c.format} onChange={(e) => upd((l) => (l.columns[i].format = e.target.value))}>{['text', 'date', 'time', 'datetime', 'number', 'money', 'km', 'hours'].map((x) => <option key={x}>{x}</option>)}</select></td>
                      <td><input type="number" step="0.1" style={{ width: 60 }} value={c.width} onChange={(e) => upd((l) => (l.columns[i].width = Number(e.target.value)))} /></td>
                      <td><input type="checkbox" checked={!!c.total} onChange={(e) => upd((l) => (l.columns[i].total = e.target.checked))} /></td>
                      <td className="nowrap"><button className="btn sm" disabled={i === 0} onClick={() => upd((l) => { const x = l.columns.splice(i, 1)[0]; l.columns.splice(i - 1, 0, x); })}>↑</button><button className="btn sm danger" onClick={() => upd((l) => l.columns.splice(i, 1))}>✕</button></td>
                    </tr>
                  ))}</tbody>
                </table>
                <datalist id="colkeys">{Object.keys(dutyKeys).map((k) => <option key={k} value={k}>{dutyKeys[k]}</option>)}<option value="comp:BASE:amount" /><option value="comp:EXKM:qty" /><option value="var:billable_km" /></datalist>
                <button className="btn sm" style={{ marginTop: 8 }} onClick={() => upd((l) => l.columns.push({ key: 'remarks', label: 'Remarks', width: 1, format: 'text', total: false }))}>Add column</button>
                <p className="small muted">Component columns use the rate scheme's component codes: <code>comp:EXKM:amount</code>, <code>comp:EXKM:qty</code>, <code>comp:EXKM:rate</code>. Any duty variable: <code>var:extra_hours</code>.</p>
              </div>
            )}
            {tab === 'summary' && (
              <div className="panel grid">
                <h3>Summary rows</h3>
                {layout.summary.map((s: any, i: number) => (
                  <div className="row" key={i}><input style={{ flex: 1 }} value={s.label} onChange={(e) => upd((l) => (l.summary[i].label = e.target.value))} />
                    <select value={s.value} onChange={(e) => upd((l) => (l.summary[i].value = e.target.value))}>{['chargesTotal', 'reimbursementsTotal', 'deductionsTotal', 'taxableValue', 'taxLines', 'tax:CGST', 'tax:SGST', 'tax:IGST', 'taxTotal', 'nonTaxableTotal', 'roundOff', 'preRoundTotal', 'grandTotal'].map((x) => <option key={x}>{x}</option>)}</select>
                    <button className="btn sm danger" onClick={() => upd((l) => l.summary.splice(i, 1))}>✕</button></div>
                ))}
                <div><button className="btn sm" onClick={() => upd((l) => l.summary.push({ label: '', value: 'grandTotal' }))}>Add row</button></div>
                <label className="check"><input type="checkbox" checked={layout.amountInWords} onChange={(e) => upd((l) => (l.amountInWords = e.target.checked))} />Amount in words (Indian system)</label>
                <Field label="Notes (one per line)"><textarea value={layout.notes.join('\n')} onChange={(e) => upd((l) => (l.notes = e.target.value.split('\n').filter(Boolean)))} /></Field>
                <Field label="Declaration"><textarea value={layout.declaration} onChange={(e) => upd((l) => (l.declaration = e.target.value))} /></Field>
                <Field label="Signature blocks (one per line)"><textarea value={layout.signatures.join('\n')} onChange={(e) => upd((l) => (l.signatures = e.target.value.split('\n').filter(Boolean)))} /></Field>
              </div>
            )}
            {tab === 'xlsx' && (
              <div className="panel grid">
                <p className="small">Optional: upload the department's own .xlsx bill format. The system fills mapped cells and inserts one styled row per table row, keeping the workbook's fonts, borders and merged headers. If no workbook is mapped, the Excel file is laid out from the designer.</p>
                <div className="row">{v.xlsx_name ? <><b>{v.xlsx_name}</b> <a href={fileUrl(v.xlsx_file_id)}>download</a></> : <span className="muted">No workbook uploaded.</span>}
                  {editable && <input type="file" accept=".xlsx" onChange={(e) => e.target.files?.[0] && upload('xlsx', e.target.files[0])} />}</div>
                {v.xlsx_file_id && <XlsxCells id={id!} />}
                <Field label="Cell mapping (JSON)" hint='{"cells": {"B3": "{billNo}"}, "table": {"startRow": 10, "columns": {"A": 0, "B": 1}, "templateRows": 1}, "afterTable": {"H:2": "{grandTotal}"}} — table column numbers are positions in the "Table columns" list (0 = first).'>
                  <textarea className="mono" style={{ minHeight: 200 }} value={mapping} onChange={(e) => { setMapping(e.target.value); setDirty(true); }} />
                </Field>
              </div>
            )}
          </fieldset>
          {tab === 'reference' && (
            <div className="panel grid">
              <p className="small">Upload the department's sample bill (PDF/image) to compare against the preview. The original PDF is used as a visual reference; the bill itself is rendered from this template.</p>
              {editable && <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => e.target.files?.[0] && upload('reference', e.target.files[0])} />}
              {v.reference_file_id ? (v.reference_mime === 'application/pdf' ? <iframe className="preview" src={fileUrl(v.reference_file_id, true)} title="Reference" /> : <img src={fileUrl(v.reference_file_id)} alt="Reference sample" style={{ maxWidth: '100%' }} />) : <p className="muted">No reference uploaded.</p>}
            </div>
          )}
        </div>
        <div>
          <div className="panel">
            <div className="row">
              <select value={previewBill} onChange={(e) => setPreviewBill(e.target.value)}><option value="">Preview with sample data</option>{bills.data?.filter((b) => b.current_snapshot_id).map((b) => <option key={b.id} value={b.id}>{b.bill_no ?? 'Draft'} — {b.period_start?.slice(0, 7)}</option>)}</select>
              <button className="btn primary" onClick={() => preview('pdf')}>Preview PDF</button>
              <button className="btn" onClick={() => preview('xlsx')}>Download Excel preview</button>
            </div>
            {pdfUrl ? <iframe className="preview" src={pdfUrl} title="Preview" style={{ marginTop: 10 }} /> : <p className="muted">Render the preview and compare it with the department's required format before approval.</p>}
          </div>
          {v.status === 'draft' && can('template.approve') && (
            <div className="panel">
              <h3>Approve this version</h3>
              <label className="check"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} disabled={!pdfUrl} />I reviewed the rendered PDF and Excel preview against the department's format.</label>
              <button className="btn ok" style={{ marginTop: 8 }} disabled={!reviewed || dirty || busy} onClick={async () => { if (await run(() => api.post(`/template-versions/${id}/approve`, { previewReviewed: true }), 'Template approved')) q.refetch(); }}>Approve template</button>
              {dirty && <div className="small muted">Save changes first.</div>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function XlsxCells({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['xlsx-cells', id], queryFn: () => api.get<any[]>(`/template-versions/${id}/xlsx-cells`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <details><summary>Workbook contents (first 60 rows)</summary>
      {q.data?.map((s) => (
        <div key={s.sheet}><b>{s.sheet}</b> <span className="small muted">merged: {s.merges.join(', ') || 'none'}</span>
          <div className="scroll" style={{ maxHeight: 260 }}><table className="t"><tbody>{s.rows.map((r: any) => <tr key={r.row}><td className="muted">{r.row}</td><td className="small">{r.cells.map((c: any) => `${c.addr}: ${c.text}`).join('   ·   ')}</td></tr>)}</tbody></table></div></div>
      ))}
    </details>
  );
}
