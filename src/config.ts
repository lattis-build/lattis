import { resolve } from 'node:path';
import { isIP } from 'node:net';

function trustedProxies(): string[] {
  const entries = (process.env.LATTIS_TRUSTED_PROXY_CIDRS ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/');
    const family = isIP(address);
    if (!family || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)))) throw new Error('Invalid LATTIS_TRUSTED_PROXY_CIDRS');
  }
  return entries;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export const appConfig = () => {
  const authSecret = required('BETTER_AUTH_SECRET');
  const baseUrl = required('APP_BASE_URL');
  if (authSecret.length < 32 || authSecret.startsWith('replace-with-')) throw new Error('Set a random BETTER_AUTH_SECRET with at least 32 characters');
  if (process.env.NODE_ENV === 'production' && new URL(baseUrl).protocol !== 'https:') throw new Error('APP_BASE_URL must use HTTPS in production');
  return {
    databaseUrl: required('APP_DATABASE_URL'),
    baseUrl,
    authSecret,
    ownerEmail: required('LATTIS_OWNER_EMAIL').toLowerCase(),
    signupOpen: process.env.LATTIS_SIGNUP_OPEN === 'true',
    trustedOrigins: (process.env.LATTIS_TRUSTED_ORIGINS ?? '').split(',').filter(Boolean),
    trustedProxies: trustedProxies(),
    port: Number(process.env.APP_PORT ?? 4100),
    host: process.env.APP_HOST ?? '127.0.0.1',
  };
};

export function appMigrationDatabaseUrl(): string {
  const runtimeUrl = required('APP_DATABASE_URL');
  const migrationUrl = process.env.APP_MIGRATION_DATABASE_URL;
  if (process.env.NODE_ENV === 'production' && !migrationUrl) throw new Error('APP_MIGRATION_DATABASE_URL is required for production migrations');
  const selected = migrationUrl ?? runtimeUrl;
  if (process.env.NODE_ENV === 'production') {
    const runtime = new URL(runtimeUrl), migration = new URL(selected);
    const dialect = (protocol: string) => ['mysql:', 'mariadb:'].includes(protocol) ? 'mariadb' : ['postgres:', 'postgresql:'].includes(protocol) ? 'postgres' : protocol;
    if (dialect(runtime.protocol) !== dialect(migration.protocol) || runtime.host !== migration.host || runtime.pathname !== migration.pathname) throw new Error('Migration and runtime database URLs must target the same server and database');
    if (runtime.username === migration.username) throw new Error('Migration and runtime database principals must differ');
  }
  return selected;
}

export const geodeConfig = () => {
  const mcpPublicUrl = required('GEODE_MCP_PUBLIC_URL');
  if (process.env.NODE_ENV === 'production' && new URL(mcpPublicUrl).protocol !== 'https:') throw new Error('Public MCP requires HTTPS in production');
  return {
    databaseUrl: required('GEODE_DATABASE_URL'),
    baseUrl: required('GEODE_BASE_URL'),
    port: Number(process.env.GEODE_PORT ?? 4200),
    host: process.env.GEODE_HOST ?? '127.0.0.1',
    mcpHost: process.env.GEODE_MCP_HOST ?? '127.0.0.1',
    mcpPort: Number(process.env.GEODE_MCP_PORT ?? 4201),
    mcpPublicUrl,
    artifactDir: resolve(process.env.GEODE_ARTIFACT_DIR ?? './geode-artifacts'),
    publisher: required('GEODE_PUBLISHER_SLUG'),
  };
};
