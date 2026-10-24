import type { Db } from './index.js';

/**
 * Seeds only neutral reference lists (duty types). No rates, tax percentages,
 * clients or users are seeded — those must be entered and approved by people.
 */
export async function seedReferenceData(db: Db) {
  const types = [
    ['LOCAL', 'Local duty'],
    ['OUTSTATION', 'Outstation duty'],
    ['AIRPORT', 'Airport transfer'],
    ['MONTHLY', 'Monthly hire'],
  ];
  for (const [code, name] of types) {
    await db.query('INSERT INTO duty_types(code, name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING', [code, name]);
  }
}
