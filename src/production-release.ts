import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, parse, sep } from 'node:path';
import { z } from 'zod';
import { digest } from './manifest.js';
import { boundedFile, insideFile } from './security-files.js';
import { installationPolicySchema, verifyRelease, releaseDigest, type ReleaseManifest } from './release-contract.js';
import { requireReview } from '../updater/lib/release-review.mjs';

export const INSTALLATION_POLICY_PATH = '/etc/lattis/installation.json';
let verified: { root: string; manifest: ReleaseManifest } | null = null;

async function protectedPath(path: string, runtimeUid: number): Promise<void> {
  let current = path;
  while (true) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || stat.uid === runtimeUid || (stat.mode & 0o022) !== 0) throw new Error('Production deployment must be owned by a separate protected account');
    if (current === parse(current).root) break;
    current = dirname(current);
  }
}

export async function productionRelease(): Promise<ReleaseManifest | null> {
  if (process.env.NODE_ENV !== 'production') return null;
  const root = await realpath(process.cwd());
  if (verified?.root === root) return verified.manifest;
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) throw new Error('Production runtime requires an unprivileged Unix account');
  await protectedPath(INSTALLATION_POLICY_PATH, uid);
  const policy = installationPolicySchema.parse(JSON.parse((await boundedFile(INSTALLATION_POLICY_PATH, 100_000)).toString('utf8')));
  await protectedPath(policy.stateDirectory, uid);
  await protectedPath(root, uid);
  const releaseRoot = await realpath(policy.releaseDirectory);
  if (!root.startsWith(releaseRoot + sep)) throw new Error('Runtime is outside the protected release directory');
  const active = z.object({ releaseId: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict().parse(JSON.parse((await boundedFile(join(policy.stateDirectory, 'active.json'), 1000)).toString('utf8')));
  await protectedPath(join(policy.stateDirectory, 'active.json'), uid);
  const envelopePath = join(policy.stateDirectory, 'authorizations', `${active.releaseId.slice(7)}.json`);
  await protectedPath(envelopePath, uid);
  const manifest = verifyRelease(JSON.parse((await boundedFile(envelopePath, 10_000_000)).toString('utf8')), policy);
  if (releaseDigest(manifest) !== active.releaseId || root !== join(releaseRoot, active.releaseId.slice(7))) throw new Error('Active release identity mismatch');
  const found = new Set<string>();
  async function walk(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Production release contains a symlink');
      const full = join(directory, entry.name);
      const stat = await lstat(full);
      if (stat.uid === uid || (stat.mode & 0o022) !== 0) throw new Error('Runtime can alter production release');
      if (entry.isDirectory()) { await walk(full, name); continue; }
      const expected = manifest.files[name];
      if (!entry.isFile() || !expected) throw new Error(`Unlisted production file: ${name}`);
      const bytes = await insideFile(root, name, expected.length);
      if (bytes.length !== expected.length || digest(bytes) !== expected.digest) throw new Error(`Production file differs from authorized release: ${name}`);
      found.add(name);
    }
  }
  await walk(root);
  if (found.size !== Object.keys(manifest.files).length) throw new Error('Authorized production files are missing');
  requireReview(JSON.parse((await insideFile(root, 'lattis.review.json', 100000)).toString('utf8')), manifest.files, manifest.core, manifest.configurationDigest, false, policy.edgeProtection.configurationDigest);
  verified = { root, manifest };
  return manifest;
}

export async function requireRuntimeComponent(component: ReleaseManifest['components'][number]): Promise<void> {
  const manifest = await productionRelease();
  if (manifest && !manifest.components.includes(component)) throw new Error('Component not authorized in this release');
}

export function prohibitProductionMutation(): void {
  if (process.env.NODE_ENV === 'production') throw new Error('Production mutations require the independent updater; use a development workspace to prepare a candidate');
}
