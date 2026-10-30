/**
 * Scanner access. A browser cannot reach a USB or network scanner, so the server (running on the
 * computer the scanner is attached to) drives it through Windows Image Acquisition (WIA) with
 * server/scripts/wia-scan.ps1. SCANNER_DRIVER=mock stands in for a scanner in tests.
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

export function scannerStatus(): { driver: string; available: boolean; reason?: string } {
  if (config.scannerDriver === 'mock') return { driver: 'mock', available: true };
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
    let chain: Promise<void> = Promise.resolve();
    const timer = setTimeout(() => { p.kill(); reject(new ScannerError('timeout', 'The scanner did not finish in time.')); }, timeoutMs);
    const handle = (line: string) => {
      let o: Record<string, any>;
      try { o = JSON.parse(line); } catch { return; }
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
      if (failure) reject(failure);
      else resolve();
    });
    void err;
  });
}

export async function listScanners(): Promise<ScanDevice[]> {
  const st = scannerStatus();
  if (!st.available) throw new ScannerError('unavailable', st.reason ?? 'Scanning is not available here.');
  if (config.scannerDriver === 'mock') return [{ id: 'mock-1', name: 'Test scanner', feeder: true, flatbed: true, duplex: false }];
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
