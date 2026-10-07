import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { splitSql, type AppDatabase } from './app-db.js';
import { projectFile, readProject, type ProjectMigration } from './project.js';

export async function migrateProject(db: AppDatabase, root: string, phase: ProjectMigration['phase']): Promise<{ applied: string[]; skipped: string[] }> {
  const config = await readProject(root);
  const seen = new Set<string>();
  for (const migration of config.migrations) {
    if (!migration || !/^[a-zA-Z0-9_-]+$/.test(migration.id) || !['expand', 'backfill', 'contract'].includes(migration.phase) || seen.has(migration.id)) throw new Error('Invalid or duplicate project migration');
    seen.add(migration.id);
  }
  const client = await db.connect();
  const applied: string[] = [], skipped: string[] = [];
  try {
    await client.lock('lattis_project_migrations');
    await client.query(db.dialect === 'postgres' ? `CREATE TABLE IF NOT EXISTS lattis_project_migration (
      id text PRIMARY KEY, phase text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )` : `CREATE TABLE IF NOT EXISTS lattis_project_migration (
      id varchar(191) PRIMARY KEY, phase varchar(20) NOT NULL, checksum char(64) NOT NULL, applied_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    )`);
    const previous = await client.query<{ id: string; phase: string; checksum: string }>('SELECT id,phase,checksum FROM lattis_project_migration');
    const recorded = new Map(previous.rows.map((row) => [row.id, row]));
    for (const id of recorded.keys()) if (!seen.has(id)) throw new Error(`Applied migration is missing from project configuration: ${id}`);
    const phaseOrder = { expand: 0, backfill: 1, contract: 2 };
    for (const migration of config.migrations) {
      if (phaseOrder[migration.phase] < phaseOrder[phase] && !recorded.has(migration.id)) throw new Error(`Earlier migration phase is pending: ${migration.id}`);
    }
    for (const migration of config.migrations) {
      const path = db.dialect === 'mariadb' ? migration.mariadbPath : migration.path;
      if (!path) throw new Error(`Migration ${migration.id} has no MariaDB SQL`);
      const sql = await readFile(await projectFile(root, path, '.sql'), 'utf8');
      if (sql.includes('LATTIS_MIGRATION_PLACEHOLDER') || !sql.trim()) throw new Error(`Migration has no SQL: ${migration.id}`);
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = recorded.get(migration.id);
      if (prior && (prior.phase !== migration.phase || prior.checksum !== checksum)) throw new Error(`Applied migration changed: ${migration.id}`);
      if (migration.phase !== phase) continue;
      if (prior) { skipped.push(migration.id); continue; }
      if (db.dialect === 'mariadb') {
        // MariaDB DDL commits implicitly. Each statement must be safe to rerun after interruption.
        for (const statement of splitSql(sql)) await client.query(statement);
        await client.query('INSERT INTO lattis_project_migration (id,phase,checksum) VALUES ($1,$2,$3)', [migration.id, migration.phase, checksum]);
        applied.push(migration.id);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO lattis_project_migration (id,phase,checksum) VALUES ($1,$2,$3)', [migration.id, migration.phase, checksum]);
        await client.query('COMMIT');
        applied.push(migration.id);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
    return { applied, skipped };
  } finally {
    await client.unlock('lattis_project_migrations').finally(() => client.release());
  }
}
