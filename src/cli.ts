import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { appConfig, appMigrationDatabaseUrl } from './config.js';
import { appDatabase, migrateAdmin, migrateApp, migrateMigrationProtocol, jsonValue } from './app-db.js';
import { digest, pack, publisherFingerprint, unpack, type Manifest } from './manifest.js';
import { getMigrations } from 'better-auth/db/migration';
import { createAuth } from './auth.js';
import { installCandidate, registryRequest } from './registry-client.js';
import { prohibitProductionMutation } from './production-release.js';
import { prepareRelease, signRelease, bundleRelease, platformCandidate, reviewTemplate } from './release.js';
import { migrateProject } from './project-migrations.js';
import { projectFile, readProject } from './project.js';
import { migrateImmuDb, optionalImmuDbAuditBridge } from './immudb-audit.js';
import { parseExtension } from './extension-contract.js';
import { relativePath } from './security-files.js';
import { initializeProject, installApplication, configureProject, installerArguments } from './installer.js';

const [command, ...args] = process.argv.slice(2);
const root = process.cwd();
const keys = join(root, '.lattis', 'keys');

function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function need(value: string | undefined, name: string): string { if (!value) throw new Error(`Missing ${name}`); return value; }
async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')); }
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); }
let cachedToken: string | undefined;
async function token(): Promise<string | undefined> {
  if (process.env.GEODE_API_TOKEN) return process.env.GEODE_API_TOKEN;
  if (cachedToken) return cachedToken;
  try { cachedToken = (await readFile(join(keys, 'geode-api-token'), 'utf8')).trim(); return cachedToken; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function request(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  const accessToken = await token();
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const response = await registryRequest(path, { ...options, headers });
  if (!response.ok) throw new Error(`Geode ${response.status}`);
  return response;
}

async function keygen(): Promise<void> {
  await mkdir(keys, { recursive: true, mode: 0o700 });
  const pair = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  await writeFile(join(keys, 'publisher-private.pem'), pair.privateKey, { flag: 'wx', mode: 0o600 });
  await writeFile(join(keys, 'publisher-public.pem'), pair.publicKey, { flag: 'wx', mode: 0o644 });
  output({ publicKey: join(keys, 'publisher-public.pem'), fingerprint: publisherFingerprint(pair.publicKey) });
}

async function trustOwner(): Promise<void> {
  const slug = need(process.env.GEODE_PUBLISHER_SLUG, 'GEODE_PUBLISHER_SLUG');
  const key = await readFile(join(keys, 'publisher-public.pem'), 'utf8');
  return trustPublisher(slug, publisherFingerprint(key));
}

async function trustPublisher(slug: string, fingerprint: string): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(slug) || !/^sha256:[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid publisher or fingerprint');
  const path = join(root, 'lattis.config.json');
  const config = await json(path) as { trustedPublishers?: Record<string, string> };
  config.trustedPublishers ??= {};
  config.trustedPublishers[slug] = fingerprint;
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  output({ publisher: slug, fingerprint: config.trustedPublishers[slug] });
}

async function appServiceToken(name: string, scopeList: string, daysText = '30'): Promise<void> {
  if (!/^[a-z0-9-]{1,50}$/.test(name)) throw new Error('Invalid service token name');
  const scopes = scopeList.split(',').filter(Boolean);
  if (!scopes.length || scopes.some((scope) => !/^[a-z0-9.*-]+:[a-z0-9.*-]+$/.test(scope))) throw new Error('Scopes must be action:resourceType, comma-separated');
  const days = Number(daysText);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Expiration must be 1-365 days');
  const db = appDatabase(appConfig().databaseUrl);
  const id = randomUUID();
  const secret = `lattis_app_${randomBytes(32).toString('base64url')}`;
  try {
    await db.query('INSERT INTO lattis_service_token (id,name,token_hash,scopes,expires_at) VALUES ($1,$2,$3,$4,$5)', [id, name, createHash('sha256').update(secret).digest('hex'), db.dialect === 'mariadb' ? JSON.stringify(scopes) : scopes, new Date(Date.now() + days * 86400_000)]);
    await mkdir(keys, { recursive: true, mode: 0o700 });
    const path = join(keys, `app-service-${name}-token`);
    await writeFile(path, `${secret}\n`, { flag: 'wx', mode: 0o600 });
    output({ id, name, scopes, tokenFile: path, expiresInDays: days });
  } catch (error) {
    await db.query('UPDATE lattis_service_token SET revoked_at=now() WHERE id=$1', [id]);
    throw error;
  } finally { await db.end(); }
}

async function appTokens(): Promise<void> {
  const db = appDatabase(appConfig().databaseUrl);
  try { output((await db.query('SELECT id,name,scopes,expires_at,revoked_at FROM lattis_service_token ORDER BY expires_at DESC')).rows.map((row) => ({ ...row, scopes: jsonValue(row.scopes) }))); }
  finally { await db.end(); }
}

async function revokeAppToken(id: string): Promise<void> {
  const db = appDatabase(appConfig().databaseUrl);
  try {
    const changed = await db.query('UPDATE lattis_service_token SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL' + (db.dialect === 'postgres' ? ' RETURNING id' : ''), [id]);
    if (!changed.rowCount) throw new Error('Token not found or already revoked');
    output({ revoked: id });
  } finally { await db.end(); }
}

async function auditLedgerCommand(action: 'export' | 'status' | 'verify'): Promise<void> {
  const db = appDatabase(appConfig().databaseUrl);
  const bridge = optionalImmuDbAuditBridge(db);
  if (!bridge) { await db.end(); throw new Error('Set LATTIS_IMMUDB_URL first'); }
  try {
    if (action === 'export') output({ exported: await bridge.exportBatch(100),...await bridge.status() });
    else if (action === 'status') output(await bridge.status());
    else output(await bridge.verify());
  } finally { await bridge.close(); await db.end(); }
}

async function scaffold(kind: 'node' | 'shard', name: string, directory: string): Promise<void> {
  if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(name)) throw new Error('Name must be @publisher/package');
  const project = await readProject(root);
  if (!name.startsWith(`@${project.localPublisher}/`)) throw new Error('In-process modules must belong to the installation localPublisher');
  const target = resolve(directory);
  if (!target.startsWith(root + sep)) throw new Error('Package must be inside the project');
  const entry = `./${relative(root, join(target, 'index.ts')).split(sep).join('/')}`;
  if (project.trustedModules.includes(entry)) throw new Error('Module already registered');
  await mkdir(target, { recursive: true });
  const core = await json(fileURLToPath(new URL('../package.json', import.meta.url))) as { version: string };
  const manifest: Manifest = {
    schemaVersion: 1, kind, name, version: '0.1.0', description: '', coreCompatibility: `^${core.version}`, databaseDialects: ['postgres'],
    files: ['index.ts', 'README.md'], dependencies: {}, capabilities: [], secrets: [], actions: [], connections: [], nodes: [], routes: [], migrations: [], license: { identifier: 'UNLICENSED' },
  };
  await writeJson(join(target, 'lattis.manifest.json'), manifest);
  await writeFile(join(target, 'index.ts'), kind === 'shard'
    ? `import type { NodeDefinition, ShardRouteDefinition } from 'lattis/runtime';\n\nexport const nodes: NodeDefinition[] = [];\n// Add route metadata to lattis.manifest.json whenever you add a route here.\nexport const routes: ShardRouteDefinition[] = [];\n`
    : `import type { NodeDefinition } from 'lattis/runtime';\n\nexport const nodes: NodeDefinition[] = [];\n`, { flag: 'wx' });
  await writeFile(join(target, 'README.md'), `# ${name}\n\nDocument the contract, permissions, dependencies, migrations and license before publication.\n`, { flag: 'wx' });
  project.trustedModules.push(entry);
  await writeFile(join(root, 'lattis.config.json'), `${JSON.stringify(project, null, 2)}\n`);
  output({ created: target, kind, name, registered: entry });
}

async function scaffoldExtension(name: string, requestedPath: string): Promise<void> {
  const config=await readProject(root),path=relativePath(requestedPath.replace(/^\.\//,''));
  if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(name) || !name.startsWith(`@${config.localPublisher}/`) || !path.startsWith('extensions/') || !path.endsWith('.json')) throw new Error('Use a local publisher and extensions/*.json');
  if (config.extensions.includes(path) || config.extensions.includes(`./${path}`)) throw new Error('Extension is already registered');
  const prefix=name.slice(1).replace('/','.');
  const core=await json(fileURLToPath(new URL('../package.json',import.meta.url))) as { version:string };
  const definition=parseExtension({schemaVersion:1,execution:'declarative-v1',name,version:'0.1.0',coreCompatibility:`^${core.version}`,description:'',license:'UNLICENSED',capabilities:{invoke:[]},
    nodes:[{name:`${prefix}.describe`,kind:'query',action:'module.read',resourceType:'module',resource:{kind:'all'},input:[],output:[{name:'message',label:'Message',type:'text',required:true,maxLength:100}],steps:[],result:{op:'literal',value:{message:'Describe this extension before release.'}}}],
    ui:{views:[{id:'describe',title:'New extension',description:'Development scaffold; requires review before production.',node:`${prefix}.describe`}]}});
  // Resolve every parent through the same no-symlink policy as remote edits.
  const { remoteWorkspace }=await import('./remote-workspace.js');
  const workspace=await remoteWorkspace(root);
  const parent = path.slice(0, path.lastIndexOf('/'));
  await workspace.mkdir(parent);
  await workspace.write(path,`${JSON.stringify(definition,null,2)}\n`,null);
  config.extensions.push(path);
  await writeFile(join(root,'lattis.config.json'),`${JSON.stringify(config,null,2)}\n`);
  output({created:path,execution:'declarative-v1',status:'development-awaiting-review'});
}

async function migrationNew(id: string, phase: 'expand' | 'backfill' | 'contract', packageDirectory?: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !['expand', 'backfill', 'contract'].includes(phase)) throw new Error('Invalid migration ID or phase');
  const project = await readProject(root);
  if (project.migrations.some((item) => item.id === id)) throw new Error('Migration ID already exists');
  let manifest: Manifest | undefined;
  let manifestPath: string | undefined;
  let base = root;
  if (packageDirectory) {
    base = await realpath(resolve(packageDirectory));
    if (!base.startsWith(root + sep)) throw new Error('Package must be inside the project');
    manifestPath = join(base, 'lattis.manifest.json');
    manifest = await json(manifestPath) as Manifest;
    if (manifest.kind !== 'shard') throw new Error('Package migrations require a Shard');
    if (!project.trustedModules.includes(`./${relative(root, join(base, 'index.ts')).split(sep).join('/')}`)) throw new Error('Shard is not registered in this project');
  }
  await mkdir(join(base, 'migrations'), { recursive: true });
  const path = `./${relative(root, join(base, 'migrations', `${id}.sql`)).split(sep).join('/')}`;
  const mariadbPath = `./${relative(root, join(base, 'migrations', `${id}.mariadb.sql`)).split(sep).join('/')}`;
  await writeFile(join(root, path), '-- LATTIS_MIGRATION_PLACEHOLDER: replace this line with SQL before applying.\n', { flag: 'wx' });
  await writeFile(join(root, mariadbPath), '-- LATTIS_MIGRATION_PLACEHOLDER: replace this line with MariaDB SQL before applying.\n', { flag: 'wx' });
  project.migrations.push({ id, path, mariadbPath, phase });
  if (manifest && manifestPath) {
    const packagePath = `migrations/${id}.sql`;
    manifest.files.push(packagePath);
    manifest.files.push(`migrations/${id}.mariadb.sql`);
    manifest.migrations.push({ id, path: packagePath, mariadbPath: `migrations/${id}.mariadb.sql`, phase });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  await writeFile(join(root, 'lattis.config.json'), `${JSON.stringify(project, null, 2)}\n`);
  output({ created: [path, mariadbPath], id, phase, package: manifest?.name ?? null });
}

async function createOwner(name = 'Owner'): Promise<void> {
  const email = appConfig().ownerEmail;
  const executable = join(root, 'node_modules', '.bin', 'auth');
  const config = fileURLToPath(new URL('./auth-cli.ts', import.meta.url));
  const child = spawn(executable, ['create-admin', '--config', config, '--email', email, '--name', name, '--role', 'admin'], { cwd: root, env: process.env, stdio: 'inherit', shell: false });
  const code = await new Promise<number>((resolve, reject) => { child.on('error', reject); child.on('exit', (value) => resolve(value ?? 1)); });
  if (code !== 0) throw new Error(`Admin creation failed with exit code ${code}`);
}

async function vendorCore(): Promise<void> {
  const coreRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (root === coreRoot) throw new Error('Run this command from an application project');
  const core = await json(join(coreRoot, 'package.json')) as { name: string; version: string };
  const lockPath = join(root, 'lattis.lock');
  const lock = await json(lockPath) as Lock;
  if (lock.core !== core.version) throw new Error('Core version differs from lattis.lock');
  const appPackagePath = join(root, 'package.json');
  const appPackage = await json(appPackagePath) as { dependencies?: Record<string, string> };
  if (!appPackage.dependencies?.lattis) throw new Error('Application has no Lattis dependency');
  const vendor = join(root, 'vendor');
  const filename = `${core.name}-${core.version}.tgz`;
  await mkdir(vendor, { recursive: true });
  try { await access(join(vendor, filename)); throw new Error('Core artifact already exists; bump the version before replacing a release artifact'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const child = spawn('npm', ['pack', coreRoot, '--ignore-scripts', '--pack-destination', vendor], { cwd: root, env: { ...process.env, npm_config_ignore_scripts: 'true' }, stdio: 'inherit', shell: false });
  const code = await new Promise<number>((resolve, reject) => { child.on('error', reject); child.on('exit', (value) => resolve(value ?? 1)); });
  if (code !== 0) throw new Error(`Core packaging failed with exit code ${code}`);
  await access(join(vendor, filename));
  appPackage.dependencies.lattis = `file:./vendor/${filename}`;
  await writeFile(appPackagePath, `${JSON.stringify(appPackage, null, 2)}\n`);
  output({ core: core.version, artifact: join(vendor, filename), dependency: appPackage.dependencies.lattis, next: 'Run npm install --ignore-scripts in this application to update package-lock.json' });
}

async function publish(directory: string, visibility: 'public' | 'private'): Promise<void> {
  const { artifact, manifest, digest: sha } = await pack(directory);
  const privateKey = await readFile(join(keys, 'publisher-private.pem'), 'utf8');
  const signature = sign(null, Buffer.from(sha), privateKey).toString('base64');
  const response = await request('/v1/packages/publish', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': digest(Buffer.from(`${sha}:${visibility}`)) }, body: JSON.stringify({ artifact: artifact.toString('base64'), visibility, signature }) });
  output({ published: await response.json(), manifest: `${manifest.name}@${manifest.version}` });
}

async function offer(name: string, model: 'free' | 'one-time' | 'subscription', amountMinor?: string, currency?: string): Promise<void> {
  const body = model === 'free' ? { model } : { model, amountMinor: Number(need(amountMinor, 'amountMinor')), currency: need(currency, 'currency') };
  const response = await request(`/v1/packages/${encodeURIComponent(name)}/offers`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': digest(Buffer.from(JSON.stringify({ name, body }))) }, body: JSON.stringify(body) });
  output(await response.json());
}

async function grant(name: string, subject: string, expiresAt?: string): Promise<void> {
  const body = { subject, expiresAt: expiresAt ?? null };
  const response = await request(`/v1/packages/${encodeURIComponent(name)}/entitlements`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': digest(Buffer.from(JSON.stringify({ name, body }))) }, body: JSON.stringify(body) });
  output(await response.json());
}

async function revoke(name: string, version: string, reason: string): Promise<void> {
  const response = await request(`/v1/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': digest(Buffer.from(JSON.stringify({ name, version, reason }))) }, body: JSON.stringify({ reason }) });
  output(await response.json());
}

async function install(name: string, range: string): Promise<void> { output(await installCandidate(root, name, range)); }

async function main(): Promise<void> {
  if (!['serve-app', 'serve-admin', 'mcp-remote'].includes(command ?? '')) prohibitProductionMutation();
  switch (command) {
    case 'init': { output({initialized:await initializeProject(args[0]??'my-app',resolve(fileURLToPath(new URL('..',import.meta.url)))),next:'Run lattis configure in the application, or use lattis install for guided setup'});return; }
    case 'install': { const options=installerArguments(args);await installApplication(options.target,resolve(fileURLToPath(new URL('..',import.meta.url))),options);return; }
    case 'configure': { const options=installerArguments(args);await configureProject(options.targetProvided?options.target:root,options.configFile);return; }
    case 'keygen': return keygen();
    case 'geode:trust-owner': return trustOwner();
    case 'geode:trust': return trustPublisher(need(args[0], 'publisher'), need(args[1], 'fingerprint'));
    case 'db:app': { const db = appDatabase(appMigrationDatabaseUrl()); try { await migrateApp(db); output({ migrated: 'app', dialect: db.dialect }); } finally { await db.end(); } return; }
    case 'db:upgrade-migrations': { const db=appDatabase(appMigrationDatabaseUrl()); try { await migrateMigrationProtocol(db); output({upgraded:'migration-protocol-v1',dialect:db.dialect}); } finally { await db.end(); } return; }
    case 'db:admin': { const db = appDatabase(appMigrationDatabaseUrl()); try { await migrateAdmin(db); output({ migrated: 'admin', dialect: db.dialect }); } finally { await db.end(); } return; }
    case 'db:immudb': await migrateImmuDb(); output({ migrated: 'immudb-audit' }); return;
    case 'db:auth': { const db = appDatabase(appMigrationDatabaseUrl()); try { const auth = createAuth(db); const migrations = await getMigrations(auth.options); await migrations.runMigrations(); output({ migrated: 'auth' }); } finally { await db.end(); } return; }
    case 'db:project': { const phase = need(args[0], 'phase') as 'expand' | 'backfill' | 'contract'; if (!['expand', 'backfill', 'contract'].includes(phase)) throw new Error('Phase must be expand, backfill or contract'); const db = appDatabase(appMigrationDatabaseUrl()); try { output(await migrateProject(db, root, phase)); } finally { await db.end(); } return; }
    case 'app:audit-export': return auditLedgerCommand('export');
    case 'app:audit-status': return auditLedgerCommand('status');
    case 'app:audit-verify': return auditLedgerCommand('verify');
    case 'video:package': { const { packageClearCmaf } = await import('./video-packager.js'); const db = appDatabase(appConfig().databaseUrl); try { output(await packageClearCmaf(db, need(args[0], 'video ID'))); } finally { await db.end(); } return; }
    case 'app:service-token': return appServiceToken(need(args[0], 'name'), need(args[1], 'scopes'), args[2]);
    case 'app:owner': return createOwner(args[0]);
    case 'app:tokens': return appTokens();
    case 'app:revoke-token': return revokeAppToken(need(args[0], 'token id'));
    case 'node:new': return scaffold('node', need(args[0], 'name'), need(args[1], 'directory'));
    case 'shard:new': return scaffold('shard', need(args[0], 'name'), need(args[1], 'directory'));
    case 'migration:new': return migrationNew(need(args[0], 'id'), need(args[1], 'phase') as 'expand' | 'backfill' | 'contract', args[2]);
    case 'geode:publish': return publish(need(args[0], 'directory'), args[1] === 'public' ? 'public' : 'private');
    case 'geode:offer': return offer(need(args[0], 'package'), need(args[1], 'model') as 'free' | 'one-time' | 'subscription', args[2], args[3]);
    case 'geode:grant': return grant(need(args[0], 'package'), need(args[1], 'subject'), args[2]);
    case 'geode:revoke': return revoke(need(args[0], 'package'), need(args[1], 'version'), need(args[2], 'reason'));
    case 'geode:search': { const response = await request(`/v1/packages?q=${encodeURIComponent(args.join(' '))}`); output(await response.json()); return; }
    case 'geode:install': return install(need(args[0], 'package'), args[1] ?? '*');
    case 'extension:new': return scaffoldExtension(need(args[0],'@local-publisher/name'),need(args[1],'extensions/name.json'));
    case 'release:prepare': { output(await prepareRelease(root, need(args[0], 'fully assembled release directory'), need(args[1], 'platform target descriptor'), args[2])); return; }
    case 'release:review-template': { output(await reviewTemplate(need(args[0], 'assembled release directory'), need(args[1], 'edge configuration digest'), need(args[2], 'new review output file'))); return; }
    case 'release:sign': { output(await signRelease(need(args[0], 'descriptor'), need(args[1], 'offline owner private key'))); return; }
    case 'release:bundle': { output(await bundleRelease(need(args[0], 'assembled release directory'), need(args[1], 'descriptor'), need(args[2], 'output file'))); return; }
    case 'release:platform': { output(await platformCandidate(need(args[0], 'assembled platform directory'), need(args[1], 'version'), need(args[2], 'output file'))); return; }
    case 'release:vendor-core': return vendorCore();
    case 'serve-app': { await import('./app-server.js'); return; }
    case 'serve-admin': { await import('./admin-server.js'); return; }
    case 'mcp-local': { await import('./local-mcp.js'); return; }
    case 'mcp-remote': { await import('./remote-mcp.js'); return; }
    default: throw new Error('Commands: install [directory] [--config-file FILE] [--skip-dependencies], configure [directory] [--config-file FILE], init, serve-app, serve-admin, mcp-local, mcp-remote, keygen, geode:trust-owner, geode:trust, db:app, db:upgrade-migrations, db:admin, db:auth, db:project, db:immudb, app:owner, app:service-token, app:tokens, app:revoke-token, app:audit-export, app:audit-status, app:audit-verify, video:package, extension:new, node:new, shard:new, migration:new, geode:publish, geode:offer, geode:grant, geode:revoke, geode:search, geode:install, release:vendor-core, release:review-template, release:prepare, release:sign, release:bundle, release:platform');
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; });
