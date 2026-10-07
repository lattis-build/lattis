import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { digest, canonicalJson, manifestSchema, publisherFingerprint } from './manifest.js';
import { readProject, projectFile } from './project.js';
import { lockSchema } from './registry-client.js';
import { distributionClient } from '../updater/lib/tuf-client.mjs';
import { boundedFile, insideFile, relativePath, exclusive } from './security-files.js';
import { approvalBytes, fileSchema, releaseSchema, releaseDigest, releaseEnvelopeSchema, type ReleaseManifest } from './release-contract.js';
import { readExtensions } from './extensions.js';
import { requireReview, reviewedInventoryDigest, REVIEW_CATEGORIES } from '../updater/lib/release-review.mjs';
import { LATTIS_VERSION } from './version.js';

export const platformSchema = z.object({ schemaVersion: z.literal(1), version: z.string(), files: z.record(z.string(), fileSchema) }).strict();
const forbidden = /(^|\/)(\.git|\.lattis|\.env(?:\..*)?|\.npmrc|\.ssh|.*\.(?:pem|key|p12|pfx))($|\/)/i;
export async function inventory(directory: string) {
  const files: ReleaseManifest['files'] = {};
  let total = 0;
  async function walk(path: string, prefix = ''): Promise<void> {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${item.name}` : item.name;
      relativePath(name);
      if (forbidden.test(name)) throw new Error(`Secret or workspace path cannot enter a release: ${name}`);
      if (item.isSymbolicLink()) throw new Error(`Assemble release without symlinks: ${name}`);
      if (item.isDirectory()) { await walk(join(path, item.name), name); continue; }
      if (!item.isFile()) throw new Error('Only regular files may enter a release');
      const bytes = await insideFile(directory, name, 100_000_000);
      total += bytes.length;
      if (total > 256_000_000 || Object.keys(files).length >= 20000) throw new Error('Release exceeds limits');
      files[name] = { digest: digest(bytes), length: bytes.length };
    }
  }
  await walk(directory);
  return files;
}

export async function prepareRelease(workspace: string, assembledDirectory: string, platformTarget: string, previousRelease?: string) {
  const directory = resolve(assembledDirectory);
  const config = await readProject(directory);
  const lock = lockSchema.parse(JSON.parse((await boundedFile(join(directory, 'lattis.lock'), 5_000_000)).toString('utf8')));
  if (lock.core !== LATTIS_VERSION) throw new Error('Prepare a release using its exact Core version');
  const files = await inventory(directory);
  if (config.trustedModules.length) throw new Error('Migrate TypeScript extensions to declarative extensions before production release');
  const extensions = (await readExtensions(directory)).map(({ path, digest: sha, definition }) => ({ path, digest: sha, name: definition.name, version: definition.version }));
  const configurationDigest = digest(Buffer.from(canonicalJson(config)));
  const review = JSON.parse((await insideFile(directory, 'lattis.review.json', 100000)).toString('utf8'));
  requireReview(review, files, lock.core, configurationDigest);
  const state = join(workspace, '.lattis', 'platform-distribution');
  const platform = await exclusive(join(state, 'refresh.lock'), async () => {
    const client = await distributionClient({ stateDirectory: state, channel: 'updates', development: process.env.LATTIS_REGISTRY_MODE === 'development' });
    await client.refresh();
    const target = await client.getTargetInfo(platformTarget);
    if (!/^platform\/[a-zA-Z0-9._-]+\.json$/.test(platformTarget) || !target || target.length > 10_000_000) throw new Error('Official platform target unavailable');
    const bytes = await boundedFile(await client.downloadTarget(target), 10_000_000);
    const official = platformSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (official.version !== lock.core) throw new Error('Core version differs from the official platform');
    for (const [path, expected] of Object.entries(official.files)) if (!files[path] || canonicalJson(files[path]) !== canonicalJson(expected)) throw new Error(`Platform file differs: ${path}`);
    for (const path of Object.keys(files)) if ((path.startsWith('node_modules/') || path.startsWith('vendor/')) && !official.files[path]) throw new Error(`Unapproved dependency in release: ${path}`);
    if (!Object.keys(official.files).some((p) => p.startsWith('node_modules/lattis/'))) throw new Error('Platform must include installed Core and its complete dependency closure');
    return { target: platformTarget, digest: digest(bytes), length: bytes.length };
  });
  for (const entry of config.trustedModules) {
    if (!entry.startsWith('./packages/local/')) throw new Error('Only local application modules may execute');
    const path = await projectFile(directory, entry, '.ts');
    const manifest = manifestSchema.parse(JSON.parse((await boundedFile(join(dirname(path), 'lattis.manifest.json'), 100_000)).toString('utf8')));
    if (!manifest.name.startsWith(`@${config.localPublisher}/`)) throw new Error('Foreign publisher code cannot execute in Core');
  }
  const migrations: ReleaseManifest['migrations'] = [];
  for (const migration of config.migrations) {
    for (const dialect of ['postgres', 'mariadb'] as const) {
      const path = dialect === 'postgres' ? migration.path : migration.mariadbPath;
      if (!path) continue;
      const relative = path.replace(/^\.\//, '');
      const bytes = await insideFile(directory, relative, 5_000_000);
      if (!bytes.length || bytes.includes('LATTIS_MIGRATION_PLACEHOLDER')) throw new Error(`Migration is a placeholder: ${migration.id}`);
      migrations.push({ id: migration.id, path: relative, digest: digest(bytes), dialect, phase: migration.phase, reversible: false, scope: config.applicationId });
    }
  }
  const manifest = releaseSchema.parse({ schemaVersion: 3, applicationId: config.applicationId, localPublisher: config.localPublisher,
    core: lock.core, coreArtifact: null, platform, files, packages: lock.packages, trustedModules: config.trustedModules.map((p) => p.replace(/^\.\//, '')), migrations,
    extensions, security: { profile: 'controlled-v1', ui: 'declarative-v1', execution: 'data-only-v1', reviewDigest: files['lattis.review.json'].digest },
    components: config.releaseComponents, configurationDigest,
    compatibility: { previousRelease: previousRelease ?? null, dataRollback: migrations.length ? 'forward-only' : 'compatible', minimumUpdater: 2 } });
  const id = releaseDigest(manifest);
  const outputDirectory = join(workspace, '.lattis', 'releases');
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const path = join(outputDirectory, `${id.slice(7)}.json`);
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { path, digest: id, status: 'candidate-awaiting-offline-authorization', migrations };
}

// Generates a pending record only. Does not run checks or approve a candidate.
export async function reviewTemplate(directory: string, edgePolicyDigest: string, output: string) {
  const root = resolve(directory);
  const config = await readProject(root);
  const lock = lockSchema.parse(JSON.parse((await boundedFile(join(root, 'lattis.lock'), 5_000_000)).toString('utf8')));
  const files = await inventory(root);
  const template = { schemaVersion: 1, decision: 'pending', core: lock.core,
    configurationDigest: digest(Buffer.from(canonicalJson(config))), inventoryDigest: reviewedInventoryDigest(files), edgePolicyDigest,
    reviewer: '', reviewedAt: null, expiresAt: null,
    checks: REVIEW_CATEGORIES.map((category) => ({ category, status: 'pending', evidence: [] })),
  };
  await writeFile(output, JSON.stringify(template, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { path: output, status: 'pending-no-checks-executed' };
}

export async function signRelease(descriptorPath: string, offlinePrivateKey: string) {
  if (resolve(offlinePrivateKey).startsWith(resolve(process.cwd()) + '/')) throw new Error('Owner signing key must be outside the application workspace');
  const stat = await lstat(offlinePrivateKey);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Owner private key must have mode 0600');
  const manifest = releaseSchema.parse(JSON.parse((await boundedFile(descriptorPath, 10_000_000)).toString('utf8')));
  const key = createPrivateKey(await boundedFile(offlinePrivateKey, 10_000));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 owner key is required');
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  const signature = { keyId: publisherFingerprint(publicKey), signature: sign(null, approvalBytes(manifest), key).toString('base64') };
  const path = `${descriptorPath}.${signature.keyId.slice(7, 19)}.authorization.json`;
  await writeFile(path, JSON.stringify(releaseEnvelopeSchema.parse({ signed: manifest, signatures: [signature] }), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { path, releaseId: releaseDigest(manifest), note: 'Combine independent owner signatures for installations requiring a threshold greater than one.' };
}

export async function platformCandidate(assembledPlatform: string, version: string, output: string) {
  const files = await inventory(resolve(assembledPlatform));
  if (!Object.keys(files).length || Object.keys(files).some((p) => !p.startsWith('node_modules/')) || !files['node_modules/lattis/package.json']) throw new Error('Assemble only node_modules, including installed Core and its dependency closure');
  const core = JSON.parse((await insideFile(resolve(assembledPlatform), 'node_modules/lattis/package.json', 100000)).toString('utf8'));
  if (core.name !== 'lattis' || core.version !== version) throw new Error('Core package identity mismatch');
  const candidate = platformSchema.parse({ schemaVersion: 1, version, files });
  await writeFile(output, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { path: output, digest: digest(await boundedFile(output, 10_000_000)), status: 'unsigned-platform-awaiting-independent-review' };
}

export async function bundleRelease(directory: string, descriptor: string, output: string) {
  const manifest = releaseSchema.parse(JSON.parse((await boundedFile(descriptor, 10_000_000)).toString('utf8')));
  const actual = await inventory(resolve(directory));
  if (canonicalJson(actual) !== canonicalJson(manifest.files)) throw new Error('Assembled release differs from descriptor');
  const files: Record<string, string> = {};
  for (const [name, file] of Object.entries(manifest.files)) files[name] = (await insideFile(directory, name, file.length)).toString('base64');
  await writeFile(output, JSON.stringify({ schemaVersion: 1, files }), { flag: 'wx', mode: 0o600 });
  return { path: output, releaseId: releaseDigest(manifest), status: 'untrusted-transport-bundle' };
}
