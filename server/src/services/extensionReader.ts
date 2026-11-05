/**
 * Reads a contract extension letter (PDF or picture) with Claude and returns the dates and reference numbers it shows,
 * each with a confidence. The result is only a proposal: a person confirms or corrects it before anything is applied.
 * EXTENSION_READER=mock (or SLIP_READER=mock) stands in for the AI in tests: it reads a JSON marker embedded in the file.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { config } from '../config.js';

export const EXT_FIELDS: { key: string; label: string }[] = [
  { key: 'department_name', label: 'Department' },
  { key: 'contract_reference', label: 'Contract / GeM bid / work order number' },
  { key: 'original_reference', label: 'Original contract reference' },
  { key: 'letter_no', label: 'Extension letter number' },
  { key: 'letter_date', label: 'Extension letter date' },
  { key: 'existing_end_date', label: 'Existing contract end date' },
  { key: 'extension_start', label: 'Extension start date' },
  { key: 'new_end_date', label: 'New extended end date' },
  { key: 'remarks', label: 'Special conditions / remarks' },
];

export interface ExtField { value: string | null; confidence: number }
export interface ExtReading { isExtensionLetter: boolean; fields: Record<string, ExtField>; notes: string; model: string }

const FieldSchema = z.object({ value: z.string().nullable(), confidence: z.number() });
const ExtSchema = z.object({
  is_extension_letter: z.boolean(),
  fields: z.object(Object.fromEntries(EXT_FIELDS.map((f) => [f.key, FieldSchema])) as Record<string, typeof FieldSchema>),
  notes: z.string(),
});

const SYSTEM = `You read letters that extend the period of a vehicle-hire contract for the transport company LR Taxi Services.
Return only what is printed in the letter. Never guess a date or a number: if a value is not clearly there, return null with confidence 0.
Dates must be written as YYYY-MM-DD (convert 31.03.2027, 31st March 2027 and similar). A letter that extends a contract "up to 30 September 2027"
gives new_end_date 2027-09-30; "w.e.f. 01.04.2027" gives extension_start 2027-04-01. Keep letter numbers exactly as printed.
Confidence is 0 to 1: how sure you are that you read the value correctly. If the document is not an extension letter, set is_extension_letter to false.`;

const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const emptyFields = () => Object.fromEntries(EXT_FIELDS.map((f) => [f.key, { value: null, confidence: 0 }])) as Record<string, ExtField>;

export const readerAvailable = () => config.slipReader === 'mock' || !!config.anthropicApiKey;

function mockRead(buf: Buffer): ExtReading {
  const m = /EXTENSION_JSON:(\{.*?\})/s.exec(buf.toString('latin1'));
  const f = emptyFields();
  if (m) { const o = JSON.parse(m[1]) as Record<string, string>; for (const k of Object.keys(f)) if (o[k]) f[k] = { value: o[k], confidence: 0.95 }; }
  return { isExtensionLetter: !!m, fields: f, notes: '', model: 'mock' };
}

export async function readExtensionLetter(file: Buffer, hints: { departments?: string[] } = {}): Promise<ExtReading> {
  if (config.slipReader === 'mock') return mockRead(file);
  if (!config.anthropicApiKey) throw new Error('AI reading is off: set ANTHROPIC_API_KEY in the settings file (.env) and restart, or type the dates in by hand.');
  const isPdf = file.subarray(0, 5).toString() === '%PDF-';
  const isPng = file[0] === 0x89 && file.subarray(1, 4).toString() === 'PNG';
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const fields = EXT_FIELDS.map((f) => `- ${f.key}: ${f.label}`).join('\n');
  const known = hints.departments?.length ? `Departments we bill (use the letter's own wording): ${hints.departments.slice(0, 60).join('; ')}` : '';
  const block = isPdf
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: file.toString('base64') } }
    : { type: 'image' as const, source: { type: 'base64' as const, media_type: (isPng ? 'image/png' : 'image/jpeg') as 'image/png' | 'image/jpeg', data: file.toString('base64') } };
  const res = await client.beta.messages.parse({
    model: config.anthropicModel,
    max_tokens: 3000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: betaZodOutputFormat(ExtSchema) },
    system: SYSTEM,
    messages: [{ role: 'user', content: [block, { type: 'text', text: `Read this contract extension letter.\n\nFields (key: meaning):\n${fields}\n\n${known}` }] }],
  });
  if (res.stop_reason === 'refusal') throw new Error('The AI model declined to read this document.');
  if (res.stop_reason === 'max_tokens' || !res.parsed_output) throw new Error('The AI reply was incomplete. Upload the letter again, or type the dates in by hand.');
  const out = emptyFields();
  for (const f of EXT_FIELDS) {
    const v = (res.parsed_output.fields as Record<string, ExtField>)[f.key];
    const value = v?.value?.toString().trim() || null;
    out[f.key] = { value, confidence: value ? clamp(v.confidence) : 0 };
  }
  return { isExtensionLetter: res.parsed_output.is_extension_letter, fields: out, notes: res.parsed_output.notes, model: config.anthropicModel };
}
