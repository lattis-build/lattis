import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

export function pool(url: string): Pool {
  return new Pool({ connectionString: url, max: 10 });
}

export async function migrate(db: Pool, file: 'app' | 'geode'): Promise<void> {
  const sql = await readFile(new URL(`../db/${file}.sql`, import.meta.url), 'utf8');
  await db.query(sql);
}

export async function audit(db: Pool, table: 'lattis_audit' | 'geode_audit', actor: string, action: string, resource: string, result: string, correlationId: string): Promise<void> {
  await db.query(`INSERT INTO ${table} (actor, action, resource, result, correlation_id) VALUES ($1,$2,$3,$4,$5)`, [actor, action, resource, result, correlationId]);
}
