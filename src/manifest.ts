import { createHash, createPublicKey } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import semver from 'semver';
import { z } from 'zod';

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(['node', 'shard']),
  name: z.string().regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/),
  version: z.string().refine((v) => !!semver.valid(v)),
  description: z.string().max(1000).default(''),
  coreCompatibility: z.string().refine((v) => !!semver.validRange(v)),
  databaseDialects: z.array(z.enum(['postgres','mariadb'])).min(1).default(['postgres']),
  files: z.array(z.string()).min(1).max(200),
  dependencies: z.record(z.string().regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/), z.string().refine((v) => !!semver.validRange(v))).default({}),
  capabilities: z.array(z.string()).default([]),
  secrets: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
  connections: z.array(z.object({ from:z.string().min(1).max(191),to:z.string().min(1).max(191),kind:z.enum(['invokes','queues','processes','outbound','depends-on']) }).strict()).max(100).optional(),
  nodes: z.array(z.object({ name: z.string(), kind: z.enum(['command', 'query', 'event-handler', 'event']), inputSchema: z.record(z.string(), z.unknown()), outputSchema: z.record(z.string(), z.unknown()), idempotent: z.boolean() })).default([]),
  routes: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().refine((path) => path === '/' || /^\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9_]*)(?:\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9_]*))*$/.test(path)),
    access: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('public') }).strict(),
      z.object({ kind: z.literal('permission'), action: z.string().min(1), resourceType: z.string().min(1) }).strict(),
    ]),
  }).strict().refine((route) => route.access.kind !== 'public' || route.method === 'GET', 'Public routes must use GET')).default([]),
  migrations: z.array(z.object({ id: z.string(), path: z.string(), mariadbPath: z.string().optional(), phase: z.enum(['expand', 'backfill', 'contract']) })).default([]),
  license: z.object({ identifier: z.string(), textUrl: z.url().optional() }),
}).strict();
export type Manifest = z.infer<typeof manifestSchema>;

const forbidden = /(^|\/)(lattis\.manifest\.json|\.env(?:\..*)?|\.git|node_modules|\.ssh|id_[a-z0-9]+|.*\.(?:pem|key|p12|pfx))($|\/)/i;
function safePath(path: string): boolean {
  return !!path && path.length <= 512 && !path.startsWith('/') && !path.includes('\\') && path.split('/').every((p) => p !== '.' && p !== '..' && /^[A-Za-z0-9@_.-]+$/.test(p)) && !forbidden.test(path);
}

export type Artifact = { manifest: Manifest; files: Record<string, string> };

export async function pack(directory: string): Promise<{ artifact: Buffer; manifest: Manifest; digest: string }> {
  const root = resolve(directory);
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(root, 'lattis.manifest.json'), 'utf8')));
  const present = await collectFiles(root);
  if (present.join('|') !== [...manifest.files].sort().join('|')) throw new Error('Package files differ from manifest.files');
  const files: Record<string, string> = {};
  for (const path of manifest.files) {
    if (!safePath(path)) throw new Error(`Unsafe artifact path: ${path}`);
    const full = resolve(root, path);
    if (!full.startsWith(root + sep)) throw new Error(`Path escapes package: ${path}`);
    const actual = await realpath(full);
    if (!actual.startsWith(root + sep)) throw new Error(`Symlink escapes package: ${path}`);
    const bytes = await readFile(actual);
    if (bytes.length > 1_000_000) throw new Error(`File too large: ${path}`);
    files[path] = bytes.toString('base64');
  }
  const artifact = Buffer.from(JSON.stringify({ manifest, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) }));
  if (artifact.length > 5_000_000) throw new Error('Artifact exceeds 5 MB');
  return { artifact, manifest, digest: `sha256:${createHash('sha256').update(artifact).digest('hex')}` };
}

export function unpack(bytes: Buffer): Artifact {
  if (bytes.length > 5_000_000) throw new Error('Artifact exceeds 5 MB');
  const parsed = z.object({ manifest: manifestSchema, files: z.record(z.string(), z.string().max(1_333_336)) }).strict().parse(JSON.parse(bytes.toString('utf8')));
  const manifest = manifestSchema.parse(parsed.manifest);
  if (Object.keys(parsed.files).sort().join('|') !== [...manifest.files].sort().join('|')) throw new Error('Artifact files differ from manifest');
  for (const [path, encoded] of Object.entries(parsed.files)) {
    const decoded = Buffer.from(encoded, 'base64');
    if (!safePath(path) || decoded.length > 1_000_000 || decoded.toString('base64') !== encoded) throw new Error('Invalid artifact file');
  }
  if (new Set(manifest.files).size !== manifest.files.length) throw new Error('Duplicate manifest file');
  for (const migration of manifest.migrations) if (!manifest.files.includes(migration.path) || (migration.mariadbPath && !manifest.files.includes(migration.mariadbPath))) throw new Error('Migration file is absent from artifact');
  return { manifest, files: parsed.files };
}

export function digest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function canonicalJson(value: unknown): string {
  function normalize(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, normalize(nested)]));
    return item;
  }
  return JSON.stringify(normalize(value));
}

export function publisherFingerprint(publicKey: string): string {
  const der = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  return digest(der);
}

export async function collectFiles(directory: string): Promise<string[]> {
  const root = resolve(directory);
  const files: string[] = [];
  async function walk(path: string): Promise<void> {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const full = join(path, item.name);
      const rel = relative(root, full).split(sep).join('/');
      if (!safePath(rel) || rel === 'lattis.manifest.json') continue;
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) files.push(rel);
    }
  }
  await walk(root);
  return files.sort();
}
