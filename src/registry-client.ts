import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import semver from 'semver';
import { distributionClient, OFFICIAL_GEODE } from '../updater/lib/tuf-client.mjs';
import { digest, unpack, canonicalJson, publisherFingerprint } from './manifest.js';
import { boundedFile, boundedResponse, exclusive, atomicFile } from './security-files.js';
import { sha256Schema, packagePinSchema } from './release-contract.js';

export function registryOrigin(): string {
  if (process.env.LATTIS_REGISTRY_MODE === 'development' && process.env.NODE_ENV !== 'production') {
    const url = new URL(process.env.GEODE_DEVELOPMENT_URL ?? 'http://127.0.0.1:4200');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid development Geode origin');
    return url.origin;
  }
  if (process.env.GEODE_BASE_URL && new URL(process.env.GEODE_BASE_URL).origin !== OFFICIAL_GEODE) throw new Error('GEODE_BASE_URL cannot override the official client source; use an explicit development workspace');
  return OFFICIAL_GEODE;
}

export async function registryRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const origin = registryOrigin();
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password) throw new Error('Geode request escapes the selected origin');
  return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) });
}

export const admittedPackageSchema = z.object({
  name: z.string().regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/), version: z.string().refine((v) => !!semver.valid(v)),
  target: z.string().regex(/^artifacts\/[a-f0-9]{64}\.json$/), digest: sha256Schema, length: z.number().int().min(1).max(5_000_000),
  publisherPublicKey: z.string().max(2000), signature: z.string().max(256),
  dependencies: z.record(z.string().regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/), sha256Schema),
  admission: z.object({ id: z.string().min(1).max(100), decision: z.literal('approved'), evidence: z.array(z.string().min(1).max(2000)).min(1).max(100), reviewedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), execution: z.literal('download-only'),
    policy: z.literal('controlled-v1'), reviewer: z.string().min(1).max(200),
    checks: z.array(z.object({ category: z.enum(['security','compatibility','ui','dependencies','license','maintenance']), status: z.literal('passed'), evidence: z.array(z.string().min(1).max(2000)).min(1).max(30) }).strict()).length(6).refine((checks) => new Set(checks.map((check) => check.category)).size === 6),
  }).strict().refine((admission) => Date.parse(admission.reviewedAt) <= Date.now() && Date.parse(admission.expiresAt) > Date.parse(admission.reviewedAt) && Date.parse(admission.expiresAt) - Date.parse(admission.reviewedAt) <= 180 * 86400000, 'Invalid admission validity'),
}).strict();
export const catalogSchema = z.object({ schemaVersion: z.literal(3), registryId: z.literal('lattis-official'), packages: z.array(admittedPackageSchema).max(20000) }).strict();
export const lockSchema = z.object({ schemaVersion: z.literal(2), core: z.string().refine((v) => !!semver.valid(v)), packages: z.record(z.string().regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/), packagePinSchema) }).strict();

// Discovery API responses are display data. Resolution uses only the TUF target.
export async function installCandidate(root: string, name: string, range: string) {
  if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(name) || !semver.validRange(range)) throw new Error('Invalid package request');
  const state = join(root, '.lattis', 'distribution');
  return exclusive(join(state, 'refresh.lock'), async () => {
    const lock = lockSchema.parse(JSON.parse((await boundedFile(join(root, 'lattis.lock'), 5_000_000)).toString('utf8')));
    const candidate = structuredClone(lock);
    const client = await distributionClient({ stateDirectory: state, development: process.env.LATTIS_REGISTRY_MODE === 'development' });
    await client.refresh();
    const target = await client.getTargetInfo('catalog.json');
    if (!target || target.length > 10_000_000) throw new Error('Signed Geode catalog unavailable');
    const catalog = catalogSchema.parse(JSON.parse((await boundedFile(await client.downloadTarget(target), 10_000_000)).toString('utf8')));
    const visiting = new Set<string>(), selected = new Map<string, string>(), constraints = new Map<string, string[]>();
    let downloaded = 0;
    const cache = join(root, '.lattis', 'artifacts');
    await mkdir(cache, { recursive: true, mode: 0o700 });
    async function resolvePackage(packageName: string, wanted: string): Promise<void> {
      if (visiting.size > 32 || selected.size > 200) throw new Error('Dependency graph exceeds installation limits');
      const needs = constraints.get(packageName) ?? []; needs.push(wanted); constraints.set(packageName, needs);
      if (visiting.has(packageName)) throw new Error(`Dependency cycle: ${packageName}`);
      const existing = selected.get(packageName);
      if (existing) { if (!needs.every((r) => semver.satisfies(existing, r))) throw new Error(`Conflicting dependency constraints: ${packageName}`); return; }
      const records = catalog.packages.filter((p) => p.name === packageName && new Date(p.admission.reviewedAt).getTime() <= Date.now() && new Date(p.admission.expiresAt).getTime() > Date.now());
      const version = semver.maxSatisfying(records.filter((p) => needs.every((r) => semver.satisfies(p.version, r))).map((p) => p.version), '*');
      const matches = records.filter((p) => p.version === version);
      if (matches.length !== 1) throw new Error(`No unambiguous admitted version: ${packageName}`);
      const meta = matches[0];
      const artifactTarget = await client.getTargetInfo(meta.target);
      if (!artifactTarget || artifactTarget.length !== meta.length || artifactTarget.hashes.sha256 !== meta.digest.slice(7)) throw new Error('Catalog and TUF artifact disagree');
      const bytes = await boundedFile(await client.downloadTarget(artifactTarget), 5_000_000);
      downloaded += bytes.length; if (downloaded > 100_000_000) throw new Error('Dependency download exceeds limits');
      if (digest(bytes) !== meta.digest || bytes.length !== meta.length) throw new Error('Artifact differs from admission');
      const key = createPublicKey(meta.publisherPublicKey);
      if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(meta.digest), key, Buffer.from(meta.signature, 'base64'))) throw new Error('Invalid publisher signature');
      const { manifest } = unpack(bytes);
      if (manifest.name !== packageName || manifest.version !== version || !semver.satisfies(lock.core, manifest.coreCompatibility, { includePrerelease: true })) throw new Error('Artifact identity or compatibility mismatch');
      if (Object.keys(manifest.dependencies).sort().join('|') !== Object.keys(meta.dependencies).sort().join('|')) throw new Error('Review does not cover the exact dependency graph');
      visiting.add(packageName);
      for (const [dependency, dependencyRange] of Object.entries(manifest.dependencies)) await resolvePackage(dependency, dependencyRange);
      for (const [dependency, dependencyDigest] of Object.entries(meta.dependencies)) if (candidate.packages[dependency]?.digest !== dependencyDigest) throw new Error('Dependency differs from the version reviewed with its parent');
      visiting.delete(packageName); selected.set(packageName, version!);
      await writeFile(join(cache, meta.digest.slice(7)), bytes, { flag: 'wx', mode: 0o600 }).catch(async (error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; if (digest(await boundedFile(join(cache, meta.digest.slice(7)), 5_000_000)) !== meta.digest) throw new Error('Immutable artifact cache conflict'); });
      candidate.packages[packageName] = { version: version!, digest: meta.digest, kind: manifest.kind, publisherPublicKey: meta.publisherPublicKey, signature: meta.signature, registryId: catalog.registryId, admissionDigest: digest(Buffer.from(canonicalJson({ admission: meta.admission, dependencies: meta.dependencies }))) };
    }
    await resolvePackage(name, range);
    // Existing pins must also remain admitted in the current catalog.
    for (const [pkg, pin] of Object.entries(candidate.packages)) if (!catalog.packages.some((p) => p.name === pkg && p.version === pin.version && p.digest === pin.digest && digest(Buffer.from(canonicalJson({ admission: p.admission, dependencies: p.dependencies }))) === pin.admissionDigest && new Date(p.admission.expiresAt).getTime() > Date.now() && Object.entries(p.dependencies).every(([name, sha]) => candidate.packages[name]?.digest === sha))) throw new Error(`Existing pin requires renewal or removal: ${pkg}`);
    const path = join(root, '.lattis', 'candidates', 'lattis.lock');
    await atomicFile(path, `${JSON.stringify(candidate, null, 2)}\n`);
    return { candidate: path, package: name, version: candidate.packages[name].version, execution: 'disabled', note: 'Downloaded packages cannot execute in Core in phase 1. Active lattis.lock is unchanged.' };
  });
}
