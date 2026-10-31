import fs from 'node:fs';
import path from 'node:path';

/**
 * Copies the embedded database folder to <data>/backups/auto-YYYYMMDD-HHMM before it is opened, at most once
 * every `everyHours`, keeping the newest `keep`. It runs before the database is opened, so the copy is of a
 * closed folder. A failure here never stops the app.
 */
export function snapshotDatabase(dbFolder: string, everyHours = 12, keep = 7): string | null {
  try {
    if (!fs.existsSync(path.join(dbFolder, 'PG_VERSION'))) return null;
    const dir = path.join(path.dirname(dbFolder), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const autos = fs.readdirSync(dir).filter((n) => n.startsWith('auto-')).sort();
    const newest = autos[autos.length - 1];
    if (newest && Date.now() - fs.statSync(path.join(dir, newest)).mtimeMs < everyHours * 3600_000) return null;
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const name = `auto-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    const target = path.join(dir, name);
    fs.cpSync(dbFolder, target, { recursive: true });
    for (const old of autos.slice(0, Math.max(0, autos.length + 1 - keep))) fs.rmSync(path.join(dir, old), { recursive: true, force: true });
    return target;
  } catch (e) {
    console.error('Could not make a backup copy of the database:', (e as Error).message);
    return null;
  }
}
