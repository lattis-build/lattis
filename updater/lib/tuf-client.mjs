import { BaseFetcher, Updater } from 'tuf-js';
import { DownloadHTTPError } from 'tuf-js/dist/error.js';
import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export const OFFICIAL_GEODE = 'https://geode.lattis.build';
export const OFFICIAL_UPDATES = 'https://updates.lattis.build';
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// The transport can fail or lie. Only TUF metadata rooted in an independently
// provisioned trust anchor authorizes downloaded bytes.
class FixedOriginFetcher extends BaseFetcher {
  constructor(origin) { super(); this.origin = new URL(origin).origin; }
  async fetch(value) {
    const url = new URL(value);
    if (url.origin !== this.origin || url.username || url.password || url.hash) throw new Error('Unapproved distribution origin');
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'accept-encoding': 'identity' } });
    if (!response.ok) { await response.body?.cancel(); throw new DownloadHTTPError('Distribution download failed', response.status); }
    if (!response.body) throw new Error('Empty distribution response');
    return response.body;
  }
}

export async function protectedFile(path, maximum = 1_000_000) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('Trust policy must be a root-owned, non-writable regular file');
  if (await realpath(path) !== path) throw new Error('Trust policy path contains symlinks');
  let parent = dirname(path);
  while (true) { const directory = await lstat(parent); if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o022)) throw new Error('Trust policy parent must be protected'); const next = dirname(parent); if (next === parent) break; parent = next; }
  const data = await readFile(path);
  if (data.length > maximum) throw new Error('Trust policy too large');
  return data;
}

export async function distributionClient({ stateDirectory, channel = 'geode', development = false }) {
  if (!['geode', 'updates'].includes(channel)) throw new Error('Unknown distribution channel');
  if (development && process.env.NODE_ENV === 'production') throw new Error('Development registries are unavailable in production');
  const policyFile = development ? process.env.LATTIS_DEVELOPMENT_REGISTRY_POLICY : `/etc/lattis/${channel}-trust.json`;
  if (!policyFile) throw new Error('An independently provisioned registry trust policy is required');
  const bytes = development ? await readFile(policyFile) : await protectedFile(policyFile);
  const policy = JSON.parse(bytes.toString('utf8'));
  if (policy.schemaVersion !== 1 || typeof policy.rootPath !== 'string' || !policy.rootPath.startsWith('/') || !/^sha256:[a-f0-9]{64}$/.test(policy.rootDigest)) throw new Error('Invalid registry trust policy');
  const root = development ? await readFile(policy.rootPath) : await protectedFile(policy.rootPath);
  if (hash(root) !== policy.rootDigest) throw new Error('Bootstrap root differs from the provisioned fingerprint');
  const origin = development ? new URL(policy.origin).origin : channel === 'geode' ? OFFICIAL_GEODE : OFFICIAL_UPDATES;
  if (!development && policy.origin !== origin) throw new Error('Official distribution URL cannot be overridden');
  if (development && !['http:', 'https:'].includes(new URL(origin).protocol)) throw new Error('Invalid development origin');
  const metadataDir = join(stateDirectory, channel, 'metadata');
  const targetDir = join(stateDirectory, channel, 'targets');
  await mkdir(metadataDir, { recursive: true, mode: 0o700 });
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  await writeFile(join(metadataDir, 'root.json'), root, { flag: 'wx', mode: 0o600 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  return new Updater({ metadataDir, metadataBaseUrl: `${origin}/tuf/metadata`, targetBaseUrl: `${origin}/tuf/targets`, targetDir,
    fetcher: new FixedOriginFetcher(origin), config: { maxRootRotations: 32, maxDelegations: 0, rootMaxLength: 100_000, timestampMaxLength: 100_000, snapshotMaxLength: 1_000_000, targetsMaxLength: 10_000_000 } });
}
