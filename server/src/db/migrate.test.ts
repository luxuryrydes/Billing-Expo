import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, MIGRATIONS_DIR } from './migrate.js';

describe('migration list', () => {
  it('names every file in the migrations folder, in order', () => {
    const onDisk = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(MIGRATIONS.map(([name]) => name)).toEqual(onDisk);
    for (const [name, url] of MIGRATIONS) expect(url.pathname.endsWith(`/migrations/${name}`)).toBe(true);
  });
});
