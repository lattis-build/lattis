import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { Pool } from 'pg';
import { createPool, type Pool as MysqlPool, type PoolConnection } from 'mysql2/promise';

export type AppDialect = 'postgres' | 'mariadb';
export type QueryResult<T = Record<string, unknown>> = { rows: T[]; rowCount: number };
export interface AppClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
  lock(key: string): Promise<void>;
  unlock(key: string): Promise<void>;
  release(): Promise<void>;
}
export interface AppDatabase {
  dialect: AppDialect;
  authPool: Pool | MysqlPool;
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
  connect(): Promise<AppClient>;
  end(): Promise<void>;
}

function mysqlSql(sql: string, values: unknown[]): [string, unknown[]] {
  const ordered: unknown[] = [];
  const statement = sql.replace(/\$(\d+)/g, (_match, index: string) => {
    const position = Number(index) - 1;
    if (position < 0 || position >= values.length) throw new Error('Missing SQL parameter');
    ordered.push(values[position]);
    return '?';
  });
  return [statement, ordered];
}

function mysqlResult<T>(value: unknown): QueryResult<T> {
  if (Array.isArray(value)) return { rows: value as T[], rowCount: value.length };
  const header = value as { affectedRows?: number };
  return { rows: [], rowCount: header.affectedRows ?? 0 };
}

export function appDatabase(url: string): AppDatabase {
  const parsed = new URL(url);
  const scheme = parsed.protocol;
  if (['sslmode','ssl','tls','multipleStatements'].some((name) => parsed.searchParams.has(name))) throw new Error('Database TLS and statement options must be configured by Lattis, not the URL');
  const caPath = process.env.APP_DATABASE_CA_FILE;
  if (process.env.NODE_ENV === 'production' && !caPath) throw new Error('APP_DATABASE_CA_FILE is required in production');
  const ca = caPath ? readFileSync(caPath) : undefined;
  const tls = ca ? { ca, rejectUnauthorized: true } : undefined;
  if (scheme === 'postgres:' || scheme === 'postgresql:') {
    const raw = new Pool({ connectionString: url, max: 10, ssl: tls, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, statement_timeout: 30_000, query_timeout: 35_000 });
    return {
      dialect: 'postgres', authPool: raw,
      query: async <T = Record<string, unknown>>(sql: string, values?: unknown[]) => {
        const result = await raw.query(sql, values);
        return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
      },
      async connect() {
        const client = await raw.connect();
        const locks = new Set<string>();
        return {
          query: async <T = Record<string, unknown>>(sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
          },
          async lock(key) { await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]); locks.add(key); },
          async unlock(key) { if (locks.has(key)) { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); locks.delete(key); } },
          async release() {
            let failure: Error | undefined;
            for (const key of locks) {
              try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); }
              catch (error) { failure = error as Error; }
            }
            client.release(failure);
          },
        };
      },
      end: () => raw.end(),
    };
  }
  if (scheme === 'mysql:' || scheme === 'mariadb:') {
    if (process.env.NODE_ENV === 'production' && isIP(parsed.hostname.replace(/^\[|\]$/g, ''))) throw new Error('MariaDB production URL must use a DNS host with a matching certificate SAN');
    const mysqlUrl = scheme === 'mariadb:' ? `mysql:${url.slice('mariadb:'.length)}` : url;
    const mysqlTls = ca ? { ca, rejectUnauthorized: true, verifyIdentity: true } : undefined;
    const raw = createPool({ uri: mysqlUrl, connectionLimit: 10, timezone: 'Z', decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, ssl: mysqlTls, connectTimeout: 5_000 });
    const query = async <T>(conn: MysqlPool | PoolConnection, sql: string, values: unknown[] = []): Promise<QueryResult<T>> => {
      const [statement, ordered] = mysqlSql(sql, values);
      const [result] = await conn.execute(statement, ordered);
      return mysqlResult<T>(result);
    };
    return {
      dialect: 'mariadb', authPool: raw,
      query: <T = Record<string, unknown>>(sql: string, values?: unknown[]) => query<T>(raw, sql, values),
      async connect() {
        const conn = await raw.getConnection();
        const locks = new Set<string>();
        const lockName = (key: string) => `lattis:${createHash('sha256').update(key).digest('hex').slice(0, 55)}`;
        return {
          query: <T = Record<string, unknown>>(sql: string, values?: unknown[]) => query<T>(conn, sql, values),
          async lock(key) {
            const name = lockName(key);
            const acquired = await query<{ acquired: number }>(conn, 'SELECT GET_LOCK($1, 30) AS acquired', [name]);
            if (acquired.rows[0]?.acquired !== 1) throw new Error('Could not acquire database lock');
            locks.add(name);
          },
          async unlock(key) {
            const name = lockName(key);
            if (locks.has(name)) { await query(conn, 'SELECT RELEASE_LOCK($1)', [name]); locks.delete(name); }
          },
          async release() {
            let failed = false;
            for (const name of locks) {
              try { await query(conn, 'SELECT RELEASE_LOCK($1)', [name]); }
              catch { failed = true; }
            }
            if (failed) conn.destroy(); else conn.release();
          },
        };
      },
      end: () => raw.end(),
    };
  }
  throw new Error('APP_DATABASE_URL must use postgres://, postgresql://, mysql:// or mariadb://');
}

export async function migrateApp(db: AppDatabase): Promise<void> {
  const file = db.dialect === 'postgres' ? 'app.sql' : 'app.mariadb.sql';
  const sql = await readFile(new URL(`../db/${file}`, import.meta.url), 'utf8');
  if (db.dialect === 'postgres') { await db.query(sql); return; }
  for (const statement of splitSql(sql)) await db.query(statement);
}

export async function migrateMigrationProtocol(db:AppDatabase):Promise<void> {
  const sql=await readFile(new URL(`../db/upgrades/0.4-migration-protocol.${db.dialect}.sql`,import.meta.url),'utf8');
  const client=await db.connect();
  try {
    await client.lock('lattis_core_migration_protocol');
    if(db.dialect==='postgres')await client.query(sql);
    else for(const statement of splitSql(sql))await client.query(statement);
  }catch(error){if(db.dialect==='postgres')await client.query('ROLLBACK');throw error;}
  finally{await client.unlock('lattis_core_migration_protocol').finally(()=>client.release());}
}

export async function migrateAdmin(db: AppDatabase): Promise<void> {
  const file = db.dialect === 'postgres' ? 'admin.sql' : 'admin.mariadb.sql';
  const sql = await readFile(new URL(`../db/${file}`, import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const client = await db.connect();
  try {
    await client.lock('lattis_admin_migrations');
    await client.query(db.dialect === 'postgres'
      ? 'CREATE TABLE IF NOT EXISTS lattis_admin_migration (id text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())'
      : 'CREATE TABLE IF NOT EXISTS lattis_admin_migration (id varchar(191) PRIMARY KEY, checksum char(64) NOT NULL, applied_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))');
    const previous = (await client.query<{ checksum:string }>('SELECT checksum FROM lattis_admin_migration WHERE id=$1',['admin_001'])).rows[0];
    if (previous) {
      if (previous.checksum !== checksum) throw new Error('Applied admin migration changed: admin_001');
      return;
    }
    if (db.dialect === 'postgres') {
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO lattis_admin_migration (id,checksum) VALUES ($1,$2)',['admin_001',checksum]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    } else {
      for (const statement of splitSql(sql)) await client.query(statement);
      await client.query('INSERT INTO lattis_admin_migration (id,checksum) VALUES ($1,$2)',['admin_001',checksum]);
    }
  } finally { await client.unlock('lattis_admin_migrations').finally(() => client.release()); }
}

export async function insertIgnore(db: AppDatabase | AppClient, dialect: AppDialect, table: 'lattis_role' | 'lattis_role_grant' | 'lattis_user_role', columns: string[], values: unknown[]): Promise<void> {
  const args = values.map((_value, index) => `$${index + 1}`).join(',');
  const suffix = dialect === 'postgres' ? ' ON CONFLICT DO NOTHING' : ` ON DUPLICATE KEY UPDATE ${columns[0]}=${columns[0]}`;
  await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${args})${suffix}`, values);
}

export function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

// Project SQL uses ordinary statements; DELIMITER directives and stored routines are not supported.
export function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | '`' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index++; } continue; }
    if (quote) {
      if (char === '\\') { index++; continue; }
      if (char === quote && next === quote) { index++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if ((char === '-' && next === '-' && (index === 0 || /\s/.test(sql[index - 1])) && (sql[index + 2] === undefined || /\s/.test(sql[index + 2]))) || char === '#') { lineComment = true; if (char === '-') index++; continue; }
    if (char === '/' && next === '*') { blockComment = true; index++; continue; }
    if (char === ';') { const statement = sql.slice(start,index).trim(); if (statement) statements.push(statement); start = index + 1; }
  }
  if (quote || blockComment) throw new Error('Unterminated SQL string or comment');
  const remainder = sql.slice(start).trim();
  if (remainder) statements.push(remainder);
  return statements;
}
