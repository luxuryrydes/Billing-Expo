import { createDb } from './index.js';
import { migrate } from './migrate.js';

const db = await createDb();
const applied = await migrate(db, (m) => console.log(m));
console.log(applied.length ? `${applied.length} migration(s) applied` : 'Database is up to date');
await db.close();
