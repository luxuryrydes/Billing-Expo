/**
 * Scanner access. A browser cannot reach a USB or network scanner, so the server (running on the
 * computer the scanner is attached to) drives it. The preferred engine is NAPS2 (its command line, WIA or TWAIN); when
 * NAPS2 is not installed it falls back to Windows Image Acquisition (WIA) with server/scripts/wia-scan.ps1.
 * SCANNER_DRIVER = auto (default) | naps2 | wia | mock (a stand-in for tests).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

export interface ScanDevice { id: string; name: string; feeder: boolean; flatbed: boolean; duplex: boolean }
export interface ScanOptions { deviceId: string; mode: 'color' | 'gray' | 'bw'; dpi: number; source: 'feeder' | 'flatbed'; duplex: boolean; maxPages?: number }

export class ScannerError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const SCRIPT = path.join(config.root, 'server', 'scripts', 'wia-scan.ps1');
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
/** A 1×1 JPEG, used by the mock driver. */
const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

/** The NAPS2 command-line program, if it is installed (NAPS2_PATH in .env can point at it). */
function naps2Path(): string | null {
  const candidates = [process.env.NAPS2_PATH, path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'NAPS2', 'NAPS2.Console.exe'), path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'NAPS2', 'NAPS2.Console.exe')];
  return candidates.find((c) => c && fs.existsSync(c)) ?? null;
}
function engine(): 'mock' | 'naps2' | 'wia' {
  if (config.scannerDriver === 'mock') return 'mock';
  if (config.scannerDriver === 'wia') return 'wia';
  if (config.scannerDriver === 'naps2') return 'naps2';
  return naps2Path() ? 'naps2' : 'wia';   // auto
}

export function scannerStatus(): { driver: string; available: boolean; reason?: string } {
  if (config.scannerDriver === 'mock') return { driver: 'mock', available: true };
  if (engine() === 'naps2') {
    if (config.onVercel || process.platform !== 'win32') return { driver: 'naps2', available: false, reason: 'Scanner access needs Windows and runs only on the computer the scanner is connected to. Upload scanned images instead.' };
    if (!naps2Path()) return { driver: 'naps2', available: false, reason: 'NAPS2 is not installed (https://www.naps2.com). Install it on this computer, or upload scanned images instead.' };
    return { driver: 'naps2', available: true };
  }
  if (config.onVercel) return { driver: 'wia', available: false, reason: 'A hosted copy of the software cannot reach your scanner. Run the software on the computer the scanner is connected to, or upload scanned images instead.' };
  if (process.platform !== 'win32') return { driver: 'wia', available: false, reason: 'Scanner access uses Windows (WIA). On this computer, upload scanned images instead.' };
  if (!fs.existsSync(SCRIPT)) return { driver: 'wia', available: false, reason: 'The scanner helper script is missing (server/scripts/wia-scan.ps1).' };
  return { driver: 'wia', available: true };
}

let busy = false;
export const scannerBusy = () => busy;

/** Runs the helper and hands each JSON line it prints to `onLine`, in order. */
function runScript(args: string[], onLine: (o: Record<string, any>) => Promise<void> | void, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    let err = '';
    let failure: ScannerError | null = null;
    let finished = false;
    let chain: Promise<void> = Promise.resolve();
    const timer = setTimeout(() => { p.kill(); reject(new ScannerError('timeout', 'The scanner did not finish in time.')); }, timeoutMs);
    const handle = (line: string) => {
      let o: Record<string, any>;
      try { o = JSON.parse(line); } catch { return; }
      if (o.done || o.ok) finished = true;
      if (o.error) { failure = new ScannerError(String(o.error), String(o.message ?? o.error)); return; }
      chain = chain.then(() => onLine(o)).catch((e) => { failure ??= e instanceof ScannerError ? e : new ScannerError('failed', (e as Error).message); });
    };
    p.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(line); }
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(timer); reject(new ScannerError('start_failed', `Could not start the scanner helper: ${e.message}`)); });
    p.on('close', async () => {
      clearTimeout(timer);
      if (buf.trim()) handle(buf.trim());
      await chain;
      // The helper stopped without saying it finished or why: show what Windows told it instead of a bare "no pages".
      if (!failure && !finished && err.trim()) failure = new ScannerError('helper_failed', `The scanner helper stopped: ${err.trim().replace(/\s+/g, ' ').slice(0, 300)}`);
      if (failure) reject(failure);
      else resolve();
    });
  });
}

/** Runs NAPS2 and returns what it printed. Fails with the program's own message, never a bare "no pages". */
function runNaps2(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const exe = naps2Path();
    if (!exe) return reject(new ScannerError('unavailable', 'NAPS2 is not installed.'));
    const p = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { p.kill(); reject(new ScannerError('timeout', 'The scanner did not finish in time.')); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => { clearTimeout(timer); reject(new ScannerError('start_failed', `Could not start NAPS2: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      const msg = out.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 300);
      reject(new ScannerError('naps2_failed', msg ? `The scanner reported: ${msg}` : `NAPS2 stopped with code ${code}.`));
    });
  });
}

export async function listScanners(): Promise<ScanDevice[]> {
  const st = scannerStatus();
  if (!st.available) throw new ScannerError('unavailable', st.reason ?? 'Scanning is not available here.');
  if (config.scannerDriver === 'mock') return [{ id: 'mock-1', name: 'Test scanner', feeder: true, flatbed: true, duplex: false }];
  if (engine() === 'naps2') {
    // One entry per driver that sees the device: "wia::Name" or "twain::Name". WIA is listed first (it is the usual choice).
    const out: ScanDevice[] = [];
    for (const driver of ['wia', 'twain'] as const) {
      const text = await runNaps2(['--listdevices', '--driver', driver], 30_000).catch(() => '');
      for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) out.push({ id: `${driver}::${line}`, name: `${line} (${driver.toUpperCase()})`, feeder: true, flatbed: true, duplex: false });
    }
    // Windows often lists a second "#2" copy of the same scanner; put the plain ones first so they are the default.
    return out.sort((a, b) => Number(/#\d+/.test(a.name)) - Number(/#\d+/.test(b.name)));
  }
  let devices: ScanDevice[] = [];
  await runScript(['-Action', 'list'], (o) => { if (o.ok) devices = (o.devices ?? []) as ScanDevice[]; }, 30_000);
  return devices;
}

/** Scans and calls `onPage` with the file of each page as soon as it is ready. Returns the number of pages. */
export async function scan(o: ScanOptions, onPage: (file: string, index: number) => Promise<void>): Promise<number> {
  const st = scannerStatus();
  if (!st.available) throw new ScannerError('unavailable', st.reason ?? 'Scanning is not available here.');
  if (busy) throw new ScannerError('busy', 'A scan is already running. Wait for it to finish.');
  busy = true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-scan-'));
  try {
    let pages = 0;
    if (config.scannerDriver === 'mock') {
      const n = o.source === 'flatbed' ? 1 : Number(process.env.SCANNER_MOCK_PAGES ?? 3);
      for (let i = 1; i <= n; i++) {
        const f = path.join(dir, `page-${String(i).padStart(3, '0')}.jpg`);
        fs.writeFileSync(f, Buffer.concat([TINY_JPEG, Buffer.from(`${i}`)])); // each page differs
        await onPage(f, i);
        pages = i;
      }
      return pages;
    }
    if (engine() === 'naps2') {
      const [driver, ...rest] = o.deviceId.split('::');
      const device = rest.join('::');
      const ext = o.mode === 'bw' ? 'png' : 'jpg';
      const source = o.source === 'flatbed' ? 'glass' : o.duplex ? 'duplex' : 'feeder';
      const args = ['-o', path.join(dir, `page-$(nnn).${ext}`), '--noprofile', '--driver', driver, '--device', device, '--source', source, '--pagesize', 'a4', '--dpi', String(o.dpi), '--bitdepth', o.mode === 'bw' ? 'bw' : o.mode === 'gray' ? 'gray' : 'color', '--jpegquality', '92', '--force'];
      await runNaps2(args, 15 * 60_000);
      const files = fs.readdirSync(dir).filter((f) => /^page-\d+\.(jpg|png)$/.test(f)).sort();
      if (!files.length) throw new ScannerError('no_pages', 'The scanner finished but returned no pages. Check that the pages are in the feeder (or on the glass) and try again.');
      for (const f of files) { pages += 1; await onPage(path.join(dir, f), pages); }
      return pages;
    }
    const args = ['-Action', 'scan', '-DeviceId', o.deviceId, '-OutDir', dir, '-Mode', o.mode, '-Dpi', String(o.dpi), '-Source', o.source, '-MaxPages', String(o.maxPages ?? 200)];
    if (o.duplex) args.push('-Duplex');
    await runScript(args, async (m) => {
      if (typeof m.page === 'number' && m.file) { pages = m.page; await onPage(String(m.file), m.page); }
    }, 15 * 60_000);
    return pages;
  } finally {
    busy = false;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
