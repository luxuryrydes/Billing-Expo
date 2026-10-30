/**
 * Reads one scanned duty slip image into the fields below. The AI only transcribes what is printed or
 * handwritten on the slip, with a confidence for each value; nothing it returns is trusted without a
 * person's review (the review screen shows every value next to the image, and saving checks it again).
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { config } from '../config.js';

export type SlipKind = 'text' | 'date' | 'time' | 'number' | 'status';
export const SLIP_FIELDS: { key: string; label: string; kind: SlipKind; hint: string }[] = [
  { key: 'slip_no', label: 'Duty slip no.', kind: 'text', hint: 'the serial / duty slip number' },
  { key: 'duty_date', label: 'Date of duty', kind: 'date', hint: 'as dd/mm/yyyy' },
  { key: 'vehicle_no', label: 'Vehicle no.', kind: 'text', hint: 'registration number, e.g. DL1CAA1001' },
  { key: 'vehicle_category', label: 'Vehicle category', kind: 'text', hint: 'e.g. Innova, Dzire, Sedan, SUV' },
  { key: 'vehicle_model', label: 'Vehicle model', kind: 'text', hint: 'make / model if written' },
  { key: 'department', label: 'Department / customer', kind: 'text', hint: 'the department, ministry or company the duty is for' },
  { key: 'officer', label: 'Officer / employee', kind: 'text', hint: 'the person who used the car' },
  { key: 'reporting_location', label: 'Reporting location', kind: 'text', hint: 'where the car reported / started' },
  { key: 'destination', label: 'Destination', kind: 'text', hint: 'where the duty went' },
  { key: 'reporting_time', label: 'Reporting time', kind: 'time', hint: '24-hour HH:MM' },
  { key: 'release_time', label: 'Release time', kind: 'time', hint: '24-hour HH:MM' },
  { key: 'opening_km', label: 'Opening km', kind: 'number', hint: 'starting odometer reading' },
  { key: 'closing_km', label: 'Closing km', kind: 'number', hint: 'closing odometer reading' },
  { key: 'total_km', label: 'Total km', kind: 'number', hint: 'as written on the slip' },
  { key: 'extra_km', label: 'Extra km', kind: 'number', hint: 'as written on the slip' },
  { key: 'total_hours', label: 'Total hours', kind: 'number', hint: 'as written on the slip, in hours' },
  { key: 'extra_hours', label: 'Extra hours', kind: 'number', hint: 'as written on the slip, in hours' },
  { key: 'night_charges', label: 'Night charges', kind: 'number', hint: 'amount in rupees' },
  { key: 'parking', label: 'Parking', kind: 'number', hint: 'amount in rupees' },
  { key: 'toll', label: 'Toll', kind: 'number', hint: 'amount in rupees' },
  { key: 'other_expenses', label: 'Other expenses', kind: 'number', hint: 'amount in rupees' },
  { key: 'driver_name', label: 'Driver name', kind: 'text', hint: '' },
  { key: 'driver_mobile', label: 'Driver mobile', kind: 'text', hint: '10-digit mobile number' },
  { key: 'remarks', label: 'Remarks', kind: 'text', hint: 'any remarks written on the slip' },
  { key: 'signature', label: 'Signature / approval', kind: 'status', hint: 'signed, not signed or unclear' },
];

export interface FieldRead { value: string | null; confidence: number }
export interface SlipReading { isDutySlip: boolean; fields: Record<string, FieldRead>; notes: string; model: string }

const FieldSchema = z.object({ value: z.string().nullable(), confidence: z.number() });
const SlipSchema = z.object({
  is_duty_slip: z.boolean(),
  fields: z.object(Object.fromEntries(SLIP_FIELDS.map((f) => [f.key, FieldSchema]))),
  notes: z.string(),
});

const SYSTEM = `You read scanned taxi / car-hire duty slips used by Indian government departments and companies. Layouts differ between departments, and entries may be handwritten, faded, skewed or stamped.

Rules:
- Transcribe only what is written on the slip. If a field is blank, not on this layout or unreadable, return null. Never guess digits, names or numbers.
- Handwriting: read it as carefully as you can, but lower the confidence when letters or digits are ambiguous (for example 1/7, 0/6, 4/9).
- confidence is a number from 0 to 1: how sure you are that the value is exactly what is written. Use below 0.6 for anything you had to guess between possibilities.
- Dates as dd/mm/yyyy. Times in 24-hour HH:MM (convert AM/PM). Kilometres, hours and rupee amounts as plain numbers with no units, commas or currency signs. Vehicle numbers upper-case without spaces.
- signature: "signed" if there is a signature or stamp of approval by the user/officer, "not signed" if the place for it is empty, otherwise "unclear".
- If the image is not a duty slip, set is_duty_slip to false and leave every field null.
- notes: mention anything a reviewer should know (strike-outs, overwriting, cut-off text, a second slip on the page, a stamp over a number).`;

function mediaType(buf: Buffer): 'image/jpeg' | 'image/png' {
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString() === 'PNG') return 'image/png';
  return 'image/jpeg';
}

const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const emptyFields = () => Object.fromEntries(SLIP_FIELDS.map((f) => [f.key, { value: null, confidence: 0 }])) as Record<string, FieldRead>;

/** Test stand-in: a fixed, plausible slip whose date and kilometres depend on the page. */
function mockRead(buf: Buffer): SlipReading {
  const n = Math.max(1, Math.min(9, Number(String.fromCharCode(buf[buf.length - 1])) || 1));
  const f = emptyFields();
  const put = (k: string, v: string, c = 0.95) => { f[k] = { value: v, confidence: c }; };
  put('slip_no', `S-${n}`); put('duty_date', `0${n}/09/2026`); put('vehicle_no', 'DL1CAA1001'); put('vehicle_category', 'Innova'); put('department', process.env.SLIP_MOCK_DEPARTMENT ?? 'Test Department');
  put('officer', 'Shri A. Kumar'); put('reporting_location', 'Shastri Bhawan'); put('destination', 'Airport');
  put('reporting_time', '09:00'); put('release_time', '17:30'); put('opening_km', String(1000 + (n - 1) * 100)); put('closing_km', String(1080 + (n - 1) * 100), n === 2 ? 0.4 : 0.95);
  put('total_km', '80'); put('toll', n === 2 ? '120' : '0'); put('driver_name', 'Ram Singh'); put('driver_mobile', '9810012345'); put('signature', 'signed');
  return { isDutySlip: true, fields: f, notes: '', model: 'mock' };
}

export async function readSlip(image: Buffer, hints: { departments?: string[]; categories?: string[] } = {}): Promise<SlipReading> {
  if (config.slipReader === 'mock') return mockRead(image);
  if (!config.anthropicApiKey) throw new Error('AI reading is off: set ANTHROPIC_API_KEY in the settings file (.env) and restart.');
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const fields = SLIP_FIELDS.map((f) => `- ${f.key}: ${f.label}${f.hint ? ` (${f.hint})` : ''}`).join('\n');
  const known = [
    hints.departments?.length ? `Departments we bill (match the slip's name to one of these when it clearly is the same, otherwise write what the slip says): ${hints.departments.slice(0, 60).join('; ')}` : '',
    hints.categories?.length ? `Vehicle categories we use: ${hints.categories.slice(0, 40).join(', ')}` : '',
  ].filter(Boolean).join('\n');
  const res = await client.beta.messages.parse({
    model: config.anthropicModel,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: betaZodOutputFormat(SlipSchema) },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType(image), data: image.toString('base64') } },
        { type: 'text', text: `Read this duty slip.\n\nFields to fill (key: meaning):\n${fields}\n\n${known}` },
      ],
    }],
  });
  if (res.stop_reason === 'refusal') throw new Error('The AI model declined to read this image.');
  if (res.stop_reason === 'max_tokens' || !res.parsed_output) throw new Error('The AI reply was incomplete. Try reading this page again.');
  const out = emptyFields();
  for (const f of SLIP_FIELDS) {
    const v = (res.parsed_output.fields as Record<string, FieldRead>)[f.key];
    const value = v?.value?.toString().trim() || null;
    out[f.key] = { value, confidence: value ? clamp(v.confidence) : 0 };
  }
  return { isDutySlip: res.parsed_output.is_duty_slip, fields: out, notes: res.parsed_output.notes, model: config.anthropicModel };
}
