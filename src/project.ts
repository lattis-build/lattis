import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export type ProjectMigration = { id: string; path: string; mariadbPath?: string; phase: 'expand' | 'backfill' | 'contract' };
export type ProjectConfig = {
  schemaVersion: 1;
  applicationId: string;
  localPublisher: string;
  releaseComponents: ('app' | 'admin')[];
  trustedModules: string[];
  extensions: string[];
  trustedPublishers: Record<string, string>;
  migrations: ProjectMigration[];
};

export async function readProject(root = process.cwd()): Promise<ProjectConfig> {
  const parsed = JSON.parse(await readFile(resolve(root, 'lattis.config.json'), 'utf8')) as Partial<ProjectConfig>;
  if (!parsed.applicationId || !/^[a-z0-9-]{1,100}$/.test(parsed.applicationId) || !parsed.localPublisher || !/^[a-z0-9-]+$/.test(parsed.localPublisher)) throw new Error('Set applicationId and localPublisher in lattis.config.json');
  if (parsed.releaseComponents !== undefined && (!Array.isArray(parsed.releaseComponents) || !parsed.releaseComponents.length || parsed.releaseComponents.some((v) => !['app','admin'].includes(v)))) throw new Error('Invalid releaseComponents');
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.trustedModules) || !parsed.trustedModules.every((value) => typeof value === 'string')) throw new Error('Invalid Lattis project configuration');
  if (parsed.extensions !== undefined && (!Array.isArray(parsed.extensions) || parsed.extensions.length > 100 || !parsed.extensions.every((value) => typeof value === 'string') || new Set(parsed.extensions).size !== parsed.extensions.length)) throw new Error('Invalid declarative extension list');
  if (parsed.migrations !== undefined && !Array.isArray(parsed.migrations)) throw new Error('Invalid project migrations');
  if (parsed.trustedPublishers !== undefined && (typeof parsed.trustedPublishers !== 'object' || parsed.trustedPublishers === null || Array.isArray(parsed.trustedPublishers) || Object.values(parsed.trustedPublishers).some((value) => typeof value !== 'string'))) throw new Error('Invalid trusted publishers');
  if (parsed.migrations?.some((migration) => !migration || typeof migration.id !== 'string' || typeof migration.path !== 'string' || (migration.mariadbPath !== undefined && typeof migration.mariadbPath !== 'string') || !['expand', 'backfill', 'contract'].includes(migration.phase))) throw new Error('Invalid project migration entry');
  if (new Set(parsed.trustedModules).size !== parsed.trustedModules.length) throw new Error('Duplicate trusted module path');
  return { schemaVersion: 1, applicationId: parsed.applicationId, localPublisher: parsed.localPublisher, releaseComponents: parsed.releaseComponents ?? ['app','admin'], trustedModules: parsed.trustedModules, extensions: parsed.extensions ?? [], trustedPublishers: parsed.trustedPublishers ?? {}, migrations: parsed.migrations ?? [] };
}

export async function projectFile(root: string, path: string, extension: string): Promise<string> {
  if (!path.startsWith('./') || path.includes('\\') || path.split('/').includes('..') || !path.endsWith(extension)) throw new Error(`Invalid project path: ${path}`);
  const base = await realpath(root);
  const file = await realpath(resolve(base, path));
  if (!file.startsWith(base + sep)) throw new Error(`Path escapes project: ${path}`);
  return file;
}
