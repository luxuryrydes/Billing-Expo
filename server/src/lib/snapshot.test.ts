import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotDatabase } from './snapshot.js';

describe('snapshotDatabase', () => {
  it('copies the database folder once, skips a recent one, and keeps only the newest copies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-snap-'));
    const db = path.join(root, 'pglite');
    fs.mkdirSync(db);
    fs.writeFileSync(path.join(db, 'PG_VERSION'), '17');
    const first = snapshotDatabase(db, 12, 2);
    expect(first && fs.existsSync(path.join(first, 'PG_VERSION'))).toBe(true);
    expect(snapshotDatabase(db, 12, 2)).toBeNull();
    const backups = path.join(root, 'backups');
    for (const n of ['auto-20200101-0000', 'auto-20200102-0000']) { fs.mkdirSync(path.join(backups, n)); fs.utimesSync(path.join(backups, n), new Date(2020, 0, 1), new Date(2020, 0, 1)); }
    fs.renameSync(first!, path.join(backups, 'auto-20200103-0000'));
    fs.utimesSync(path.join(backups, 'auto-20200103-0000'), new Date(2020, 0, 3), new Date(2020, 0, 3));
    expect(snapshotDatabase(db, 12, 2)).not.toBeNull();
    expect(fs.readdirSync(backups).filter((n) => n.startsWith('auto-'))).toHaveLength(2);
    expect(snapshotDatabase(path.join(root, 'missing'))).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
