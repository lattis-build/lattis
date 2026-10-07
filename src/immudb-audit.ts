import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { AppDatabase } from './app-db.js';

type AuditRow = { id: string | number; at: Date | string; actor: string; action: string; resource: string; result: string; correlation_id: string };
type Receipt = { digest: string };

function immudbPool(migration = false): Pool {
  const runtimeUrl = process.env.LATTIS_IMMUDB_URL;
  if (!runtimeUrl) throw new Error('LATTIS_IMMUDB_URL is required');
  const migrationUrl = process.env.LATTIS_IMMUDB_MIGRATION_URL;
  if (migration && process.env.NODE_ENV === 'production' && !migrationUrl) throw new Error('LATTIS_IMMUDB_MIGRATION_URL is required for production migrations');
  const selected = migration ? migrationUrl ?? runtimeUrl : runtimeUrl;
  const parsed = new URL(selected);
  if (!['postgres:','postgresql:'].includes(parsed.protocol) || !parsed.username || !parsed.password || !parsed.pathname.slice(1) || [...parsed.searchParams.keys()].length || parsed.hash) throw new Error('immudb connection must be a PostgreSQL URL without connection options');
  if (migration && process.env.NODE_ENV === 'production') {
    const runtime = new URL(runtimeUrl);
    if (runtime.username === parsed.username && runtime.host === parsed.host && runtime.pathname === parsed.pathname) throw new Error('immudb migration and exporter users must differ');
  }
  const caPath = process.env.LATTIS_IMMUDB_CA_FILE;
  if (process.env.NODE_ENV === 'production' && !caPath) throw new Error('LATTIS_IMMUDB_CA_FILE is required in production');
  const ssl = caPath ? { ca: readFileSync(caPath),rejectUnauthorized: true } : undefined;
  return new Pool({ connectionString: selected,ssl,max: 1,connectionTimeoutMillis: 5_000,idleTimeoutMillis: 30_000,query_timeout: 10_000 });
}

export async function migrateImmuDb(): Promise<void> {
  const pool = immudbPool(true);
  try {
    const sql = await readFile(new URL('../db/immudb.sql',import.meta.url),'utf8');
    await pool.query(sql);
  } finally { await pool.end(); }
}

function settings(): { namespace: string; key: string } {
  const namespace = process.env.LATTIS_IMMUDB_NAMESPACE ?? (process.env.NODE_ENV === 'production' ? '' : 'local');
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(namespace)) throw new Error('Set a stable LATTIS_IMMUDB_NAMESPACE');
  const key = process.env.LATTIS_AUDIT_HMAC_KEY ?? '';
  if (key.length < 32 || key.startsWith('replace-')) throw new Error('Set a random LATTIS_AUDIT_HMAC_KEY of at least 32 characters');
  return { namespace,key };
}

function digest(row: AuditRow, namespace: string, key: string): string {
  const event = { namespace,id: String(row.id),at: new Date(row.at).toISOString(),actor: row.actor,action: row.action,resource: row.resource,result: row.result,correlationId: row.correlation_id };
  return createHmac('sha256',key).update(JSON.stringify(event)).digest('hex');
}

export class ImmuDbAuditBridge {
  private readonly pool: Pool;
  private readonly namespace: string;
  private readonly key: string;
  constructor(private readonly db: AppDatabase) {
    const config = settings();
    this.namespace = config.namespace;
    this.key = config.key;
    this.pool = immudbPool();
  }

  async exportBatch(limit = 25): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Audit batch limit must be 1-100');
    const client = await this.db.connect();
    const lock = `immudb-audit-export:${this.namespace}`;
    try {
      await client.lock(lock);
      const pending = await client.query<AuditRow>('SELECT a.id,a.at,a.actor,a.action,a.resource,a.result,a.correlation_id FROM lattis_immudb_outbox o JOIN lattis_audit a ON a.id=o.audit_id WHERE o.exported_at IS NULL ORDER BY a.id LIMIT $1', [limit]);
      for (const row of pending.rows) {
        const id = String(row.id);
        const hash = digest(row,this.namespace,this.key);
        let receipt = await this.pool.query<Receipt>('SELECT digest FROM lattis_audit_receipt WHERE namespace=$1 AND audit_id=$2', [this.namespace,id]);
        if (!receipt.rows[0]) {
          try { await this.pool.query('INSERT INTO lattis_audit_receipt(namespace,audit_id,digest) VALUES ($1,$2,$3)', [this.namespace,id,hash]); }
          catch (error) {
            receipt = await this.pool.query<Receipt>('SELECT digest FROM lattis_audit_receipt WHERE namespace=$1 AND audit_id=$2', [this.namespace,id]);
            if (!receipt.rows[0]) throw error;
          }
          receipt = await this.pool.query<Receipt>('SELECT digest FROM lattis_audit_receipt WHERE namespace=$1 AND audit_id=$2', [this.namespace,id]);
        }
        if (receipt.rows[0]?.digest !== hash) throw new Error(`Audit receipt mismatch at ${id}`);
        await client.query('UPDATE lattis_immudb_outbox SET exported_at=$1,digest=$2 WHERE audit_id=$3 AND exported_at IS NULL', [new Date(),hash,id]);
      }
      return pending.rows.length;
    } finally { await client.unlock(lock).finally(() => client.release()); }
  }

  async status(): Promise<{ pending: number; oldestPendingAt: Date | string | null }> {
    const result = await this.db.query<{ pending: number | string; oldest_pending_at: Date | string | null }>('SELECT COUNT(*) AS pending, MIN(a.at) AS oldest_pending_at FROM lattis_immudb_outbox o JOIN lattis_audit a ON a.id=o.audit_id WHERE o.exported_at IS NULL');
    return { pending: Number(result.rows[0]?.pending ?? 0),oldestPendingAt: result.rows[0]?.oldest_pending_at ?? null };
  }

  async verify(): Promise<{ receipts: number; pending: number }> {
    let after = '0', receipts = 0;
    for (;;) {
      const page = await this.pool.query<{ audit_id: string | number; digest: string }>('SELECT audit_id,digest FROM lattis_audit_receipt WHERE namespace=$1 AND audit_id>$2 ORDER BY audit_id LIMIT 100', [this.namespace,after]);
      if (!page.rows.length) break;
      for (const receipt of page.rows) {
        const id = String(receipt.audit_id);
        const source = await this.db.query<AuditRow & { exported_at: Date | string | null; recorded_digest: string | null }>('SELECT a.id,a.at,a.actor,a.action,a.resource,a.result,a.correlation_id,o.exported_at,o.digest AS recorded_digest FROM lattis_audit a JOIN lattis_immudb_outbox o ON o.audit_id=a.id WHERE a.id=$1', [id]);
        const row = source.rows[0];
        if (!row || !row.exported_at || receipt.digest !== digest(row,this.namespace,this.key) || receipt.digest !== row.recorded_digest) throw new Error(`Audit integrity mismatch at ${id}`);
        after = id;
        receipts++;
      }
    }
    let localAfter = '0';
    for (;;) {
      const page = await this.db.query<{ audit_id: string | number; digest: string | null }>('SELECT audit_id,digest FROM lattis_immudb_outbox WHERE exported_at IS NOT NULL AND audit_id>$1 ORDER BY audit_id LIMIT 100', [localAfter]);
      if (!page.rows.length) break;
      for (const row of page.rows) {
        const id = String(row.audit_id);
        const remote = await this.pool.query<Receipt>('SELECT digest FROM lattis_audit_receipt WHERE namespace=$1 AND audit_id=$2', [this.namespace,id]);
        if (!remote.rows[0] || remote.rows[0].digest !== row.digest) throw new Error(`Missing audit receipt at ${id}`);
        localAfter = id;
      }
    }
    const state = await this.status();
    return { receipts,pending: state.pending };
  }

  close(): Promise<void> { return this.pool.end(); }
}

export function optionalImmuDbAuditBridge(db: AppDatabase): ImmuDbAuditBridge | null {
  return process.env.LATTIS_IMMUDB_URL ? new ImmuDbAuditBridge(db) : null;
}
