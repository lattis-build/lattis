#!/usr/bin/env node
// Install this directory under /opt/lattis-updater, owned by root. Never load
// updater code or dependencies from an application release or its workspace.
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, rename, unlink, lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { distributionClient, protectedFile } from './lib/tuf-client.mjs';
import { requireReview } from './lib/release-review.mjs';

const hash = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
function canonical(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((v) => JSON.parse(canonical(v))));
  if (value && typeof value === 'object') return JSON.stringify(Object.fromEntries(Object.keys(value).sort((a,b) => a.localeCompare(b)).map((k) => [k, JSON.parse(canonical(value[k]))])));
  return JSON.stringify(value);
}
function relative(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.split('/').some((p) => !/^[A-Za-z0-9@_.-]+$/.test(p) || p === '.' || p === '..')) throw new Error('Invalid release path');
  return value;
}
async function read(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size > maximum) throw new Error('File exceeds limits'); const data = await file.readFile(); if (data.length > maximum) throw new Error('File exceeds limits'); return data; }
  finally { await file.close(); }
}
async function atomic(path, data, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', mode);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const parent = await open(dirname(path), 'r'); try { await parent.sync(); } finally { await parent.close(); }
}
async function protectedDirectory(path) {
  if (!path.startsWith('/') || await realpath(path) !== path) throw new Error('Protected directory must be an absolute path without symlinks');
  let current = path;
  while (true) { const stat = await lstat(current); if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('Protected directory must be root-owned and non-writable'); const parent = dirname(current); if (parent === current) break; current = parent; }
}
async function policy() {
  const p = JSON.parse((await protectedFile('/etc/lattis/installation.json')).toString('utf8'));
  if (p.schemaVersion !== 1 || !/^[a-z0-9-]{1,100}$/.test(p.applicationId) || !/^[a-z0-9-]+$/.test(p.localPublisher) || p.allowDownloadedExecution !== false || !Number.isInteger(p.ownerThreshold) || p.ownerThreshold < 1 || p.ownerThreshold > 10 || !p.ownerKeys) throw new Error('Invalid installation policy');
  if (p.edgeProtection?.mode !== 'blocking' || p.edgeProtection.originIsolated !== true || !/^sha256:[a-f0-9]{64}$/.test(p.edgeProtection.configurationDigest)) throw new Error('Protected blocking WAF and isolated origin policy required');
  await protectedDirectory(p.stateDirectory); await protectedDirectory(p.releaseDirectory);
  return p;
}
async function authorization(path, p) {
  const envelope = JSON.parse((await read(path, 10_000_000)).toString('utf8'));
  const m = envelope.signed;
  if (!m || m.schemaVersion !== 3 || m.applicationId !== p.applicationId || m.localPublisher !== p.localPublisher || m.compatibility?.minimumUpdater !== 2 || !m.files || !m.platform || !Array.isArray(envelope.signatures) || envelope.signatures.length > 10) throw new Error('Invalid release authorization');
  const accepted = new Set();
  for (const s of envelope.signatures) {
    const pem = p.ownerKeys[s.keyId]; if (!pem || accepted.has(s.keyId)) continue;
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519' || hash(key.export({ type: 'spki', format: 'der' })) !== s.keyId) throw new Error('Invalid owner key');
    if (verify(null, Buffer.from(`lattis.application-release.v3\n${canonical(m)}`), key, Buffer.from(s.signature, 'base64'))) accepted.add(s.keyId);
  }
  if (accepted.size < p.ownerThreshold) throw new Error('Owner authorization threshold not met');
  if (!Array.isArray(m.trustedModules) || m.trustedModules.length || !Array.isArray(m.extensions) || m.extensions.length > 100) throw new Error('Only declarative local extensions may be activated in 0.3');
  if (m.security?.profile !== 'controlled-v1' || m.security.ui !== 'declarative-v1' || m.security.execution !== 'data-only-v1' || m.security.reviewDigest !== m.files['lattis.review.json']?.digest) throw new Error('Controlled release and bound quality review required');
  for (const extension of m.extensions) if (!relative(extension.path).startsWith('extensions/') || !extension.path.endsWith('.json') || extension.digest !== m.files[extension.path]?.digest || !extension.name?.startsWith(`@${p.localPublisher}/`)) throw new Error('Invalid extension identity');
  if (m.extensions.length) {
    if (!p.runner || p.runner.executablePath !== '/opt/lattis-runner/extension-runner.mjs' || typeof p.runner.socketPath !== 'string' || !p.runner.socketPath.startsWith('/') || !p.runner.socketPath.endsWith('.sock') || p.runner.digest !== m.files['node_modules/lattis/runner/extension-runner.mjs']?.digest || hash(await protectedFile(p.runner.executablePath)) !== p.runner.digest) throw new Error('Provision the exact authorized runner outside the application before deployment');
  }
  if (!Array.isArray(m.migrations) || !Array.isArray(m.components) || m.components.some((v) => !['app','admin','worker'].includes(v))) throw new Error('Invalid release components');
  const names = Object.keys(m.files); let total = 0;
  if (!names.length || names.length > 20000) throw new Error('Invalid release size');
  for (const name of names) { relative(name); const f = m.files[name]; if (!Number.isSafeInteger(f.length) || f.length < 0 || f.length > 100_000_000 || !/^sha256:[a-f0-9]{64}$/.test(f.digest)) throw new Error('Invalid release inventory'); total += f.length; }
  if (total > 256_000_000 || !/^platform\/[A-Za-z0-9._-]+\.json$/.test(m.platform.target)) throw new Error('Invalid platform reference');
  return { envelope, manifest: m, id: hash(Buffer.from(canonical(m))) };
}
async function officialPlatform(m, p) {
  const tuf = await distributionClient({ stateDirectory: join(p.stateDirectory, 'distribution'), channel: 'updates' });
  await tuf.refresh();
  const target = await tuf.getTargetInfo(m.platform.target);
  if (!target || target.length > 10_000_000 || target.length !== m.platform.length || target.hashes.sha256 !== m.platform.digest.slice(7)) throw new Error('Platform target is no longer authorized');
  const platform = JSON.parse((await read(await tuf.downloadTarget(target), 10_000_000)).toString('utf8'));
  if (platform.schemaVersion !== 1 || platform.version !== m.core || !platform.files || !Object.keys(platform.files).some((n) => n.startsWith('node_modules/lattis/'))) throw new Error('Invalid official platform inventory');
  for (const [name, expected] of Object.entries(platform.files)) if (canonical(m.files[relative(name)] ?? null) !== canonical(expected)) throw new Error('Core or dependency differs from the official platform');
  for (const name of Object.keys(m.files)) if ((name.startsWith('node_modules/') || name.startsWith('vendor/')) && !platform.files[name]) throw new Error('Release contains an unapproved dependency');
}
async function checkFiles(directory, m) {
  const found = new Set();
  async function walk(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name; relative(name);
      const full = join(path, entry.name); const stat = await lstat(full);
      if (entry.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('Release file is mutable or a symlink');
      if (entry.isDirectory()) { await walk(full, name); continue; }
      const f = m.files[name];
      if (!entry.isFile() || !f) throw new Error('Unlisted release file');
      const bytes = await read(full, f.length); if (bytes.length !== f.length || hash(bytes) !== f.digest) throw new Error(`Release content differs: ${name}`);
      found.add(name);
    }
  }
  await walk(directory);
  if (found.size !== Object.keys(m.files).length) throw new Error('Release files missing');
}
async function active(p) { try { return JSON.parse((await protectedFile(join(p.stateDirectory, 'active.json'), 1000)).toString('utf8')).releaseId; } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function locked(p, operation) {
  const file = await open(join(p.stateDirectory, 'update.lock'), 'wx', 0o600).catch(() => { throw new Error('Updater is locked; inspect journal before operator recovery'); });
  try { await file.writeFile(JSON.stringify({ pid: process.pid })); await file.sync(); return await operation(); }
  finally { await file.close(); await unlink(join(p.stateDirectory, 'update.lock')); }
}
async function stage(bundleFile, authorizationFile, p) {
  const release = await authorization(authorizationFile, p);
  await officialPlatform(release.manifest, p);
  const bundle = JSON.parse((await read(bundleFile, 360_000_000)).toString('utf8'));
  if (bundle.schemaVersion !== 1 || !bundle.files || Object.keys(bundle.files).length !== Object.keys(release.manifest.files).length) throw new Error('Invalid release bundle');
  const destination = join(p.releaseDirectory, release.id.slice(7));
  const temporary = join(p.releaseDirectory, `.staging-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o755 });
  for (const [name, f] of Object.entries(release.manifest.files)) {
    if (typeof bundle.files[name] !== 'string' || bundle.files[name].length > 133_333_336) throw new Error('Missing or oversized bundle file');
    const bytes = Buffer.from(bundle.files[name], 'base64');
    if (bytes.toString('base64') !== bundle.files[name] || bytes.length !== f.length || hash(bytes) !== f.digest) throw new Error('Bundle file differs from authorization');
    const path = join(temporary, relative(name)); await mkdir(dirname(path), { recursive: true, mode: 0o755 });
    const handle = await open(path, 'wx', 0o444); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }
  await checkFiles(temporary, release.manifest);
  requireReview(JSON.parse((await read(join(temporary, 'lattis.review.json'), 100000)).toString('utf8')), release.manifest.files, release.manifest.core, release.manifest.configurationDigest, true, p.edgeProtection.configurationDigest);
  await rename(temporary, destination);
  await atomic(join(p.stateDirectory, 'authorizations', `${release.id.slice(7)}.json`), JSON.stringify(release.envelope), 0o644);
  await atomic(join(p.stateDirectory, 'journal.json'), JSON.stringify({ operation: 'stage', status: 'staged', releaseId: release.id, at: new Date().toISOString() }));
  return { releaseId: release.id, directory: destination, status: 'staged' };
}
async function activate(id, p) {
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Invalid release ID');
  const r = await authorization(join(p.stateDirectory, 'authorizations', `${id.slice(7)}.json`), p);
  if (r.id !== id || (await active(p)) !== r.manifest.compatibility.previousRelease) throw new Error('Active release differs from the authorized update predecessor');
  // The service manager, not candidate code, supplies this root-owned receipt
  // after stopping all runtime processes and completing approved DB operations.
  const receipt = JSON.parse((await protectedFile(join(p.stateDirectory, 'maintenance', `${id.slice(7)}.json`))).toString('utf8'));
  if (receipt.releaseId !== id || receipt.runtimeStopped !== true || receipt.previousRelease !== r.manifest.compatibility.previousRelease || typeof receipt.backupReference !== 'string' || !receipt.backupReference || !['postgres','mariadb'].includes(receipt.databaseDialect) || !Array.isArray(receipt.appliedMigrations)) throw new Error('Protected maintenance and backup receipt required');
  if (receipt.edgeProtection?.mode !== 'blocking' || receipt.edgeProtection.originIsolated !== true || receipt.edgeProtection.configurationDigest !== p.edgeProtection.configurationDigest) throw new Error('Operator must attest the configured blocking WAF and isolated origins');
  for (const m of r.manifest.migrations.filter((v) => v.dialect === receipt.databaseDialect)) if (!receipt.appliedMigrations.some((v) => v.id === m.id && v.digest === m.digest && v.phase === m.phase)) throw new Error('Approved migration receipt missing');
  await officialPlatform(r.manifest, p);
  await checkFiles(join(p.releaseDirectory, id.slice(7)), r.manifest);
  requireReview(JSON.parse((await read(join(p.releaseDirectory, id.slice(7), 'lattis.review.json'), 100000)).toString('utf8')), r.manifest.files, r.manifest.core, r.manifest.configurationDigest, true, p.edgeProtection.configurationDigest);
  await atomic(join(p.stateDirectory, 'journal.json'), JSON.stringify({ operation: 'activate', status: 'committing', releaseId: id, previousRelease: await active(p), at: new Date().toISOString() }));
  await atomic(join(p.stateDirectory, 'active.json'), JSON.stringify({ releaseId: id }), 0o644);
  await atomic(join(p.stateDirectory, 'journal.json'), JSON.stringify({ operation: 'activate', status: 'active-awaiting-service-health', releaseId: id, at: new Date().toISOString() }));
  return { releaseId: id, status: 'active-awaiting-service-health', note: 'Restart the managed service, then record health externally. Database rollback is never automatic.' };
}
async function run(component, p) {
  if (!['app','admin'].includes(component) || process.getuid?.() === 0) throw new Error('Run requires an authorized component and an unprivileged runtime account');
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH) throw new Error('Node runtime injection options are forbidden');
  const id = await active(p); if (!/^sha256:[a-f0-9]{64}$/.test(id ?? '')) throw new Error('No active release');
  const r = await authorization(join(p.stateDirectory, 'authorizations', `${id.slice(7)}.json`), p);
  if (r.id !== id || !r.manifest.components.includes(component)) throw new Error('Runtime component not authorized');
  const directory = join(p.releaseDirectory, id.slice(7)); await checkFiles(directory, r.manifest);
  requireReview(JSON.parse((await read(join(directory, 'lattis.review.json'), 100000)).toString('utf8')), r.manifest.files, r.manifest.core, r.manifest.configurationDigest, false, p.edgeProtection.configurationDigest);
  const cli = join(directory, 'node_modules/lattis/bin/lattis.js');
  const child = spawn(process.execPath, [cli, component === 'app' ? 'serve-app' : 'serve-admin'], { cwd: directory, env: { ...process.env, NODE_ENV: 'production' }, stdio: 'inherit', shell: false });
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
  return undefined;
}
async function integrity(p) {
  const id=await active(p); if (!/^sha256:[a-f0-9]{64}$/.test(id ?? '')) throw new Error('No active release');
  const r=await authorization(join(p.stateDirectory,'authorizations',`${id.slice(7)}.json`),p);
  if (r.id!==id) throw new Error('Active authorization mismatch');
  await checkFiles(join(p.releaseDirectory,id.slice(7)),r.manifest);
  return { releaseId:id,integrity:'matches-authorized-files',scope:'files-only-not-runtime-or-vulnerability-assurance' };
}
const [command, ...args] = process.argv.slice(2);
try {
  const p = await policy();
  if (command !== 'run' && process.getuid?.() !== 0) throw new Error('Updater mutations require the protected deployment account');
  const result = command === 'run' ? await run(args[0], p) : await locked(p, () => command === 'stage' ? stage(args[0], args[1], p) : command === 'activate' ? activate(args[0], p) : command === 'integrity' ? integrity(p) : Promise.reject(new Error('Commands: stage BUNDLE AUTHORIZATION; activate RELEASE_ID; run app|admin; integrity')));
  if (result) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
