import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createHash } from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import { readFile } from 'node:fs/promises';
import { appConfig } from './config.js';
import { createAuth } from './auth.js';
import { appDatabase, insertIgnore, jsonValue } from './app-db.js';
import { ContentStore, registerContentRoutes } from './content.js';
import { contentNodes } from './content-nodes.js';
import { videoNodes } from './video-nodes.js';
import { registerWordPressImport } from './wordpress-import.js';
import { registerUserImport } from './user-import.js';
import { WordPressPasswordBridge } from './wordpress-password.js';
import { registerMediaTransfer } from './media-transfer.js';
import { purgeOldVideoPlayback, registerVideoTransfer } from './video-transfer.js';
import { optionalImmuDbAuditBridge } from './immudb-audit.js';
import { authorize, bootstrapOwner, type Principal } from './authorization.js';
import { loadLocalModules, type NodeDefinition } from './runtime.js';
import { DatabaseVaultSecrets, DevelopmentEnvSecrets, ExternalSecretProvider, SecretReferences } from './secrets.js';
import { ZodError, type ZodType } from 'zod';

import { requireRuntimeComponent } from './production-release.js';
await requireRuntimeComponent('app');

const config = appConfig();
const coreVersion = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const db = appDatabase(config.databaseUrl);
const auditLedger = optionalImmuDbAuditBridge(db);
const auth = createAuth(db);
const wordpressPasswords = new WordPressPasswordBridge(db, auth);
const app = Fastify({ logger: true, bodyLimit: 1_000_000, trustProxy: config.trustedProxies.length ? config.trustedProxies : false });
let draining = false;
await app.register(cors, { origin: [config.baseUrl, ...config.trustedOrigins], credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['content-type', 'idempotency-key', 'authorization', 'x-requested-with', 'range'], exposedHeaders: ['accept-ranges', 'content-range', 'content-length'] });
const { nodes, routes } = await loadLocalModules(db.dialect);
const nodeNames = new Set(nodes.map((node) => node.name));
const content = new ContentStore(db, nodeNames, new Set(routes.map((route) => route.packageName)));
for (const node of contentNodes(content)) { if (nodeNames.has(node.name)) throw new Error(`Reserved Node name: ${node.name}`); nodeNames.add(node.name); nodes.push(node); }
for (const node of videoNodes()) { if (nodeNames.has(node.name)) throw new Error(`Reserved Node name: ${node.name}`); nodeNames.add(node.name); nodes.push(node); }
const secretProviders = { env: new DevelopmentEnvSecrets(), ...(process.env.LATTIS_SECRET_PROVIDER_URL && process.env.LATTIS_SECRET_PROVIDER_TOKEN ? { external: new ExternalSecretProvider(process.env.LATTIS_SECRET_PROVIDER_URL, process.env.LATTIS_SECRET_PROVIDER_TOKEN) } : {}), ...(process.env.LATTIS_VAULT_KEY ? { vault: new DatabaseVaultSecrets(db,process.env.LATTIS_VAULT_KEY) } : {}) };
const secrets = new SecretReferences(db, secretProviders);
async function appAudit(actor: string, action: string, resource: string, result: string, correlationId: string): Promise<void> {
  await db.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [actor,action,resource,result,correlationId]);
}
function parsedOutput(schema: ZodType, value: unknown): unknown {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error('Invalid output from trusted module', { cause: result.error });
  return result.data;
}
type Client = Awaited<ReturnType<typeof db.connect>>;
async function invokeLocal(name: string, rawInput: unknown, who: Principal | null, client: Client, rootKey: string | null, path: string[], correlationId: string): Promise<unknown> {
  const target = nodes.find((entry) => entry.name === name);
  if (!target) throw new Error(`Node not found: ${name}`);
  if (path.includes(name) || path.length >= 8) throw new Error('Node invocation cycle or depth limit');
  const input = target.input.parse(rawInput);
  const decision = await authorize(db, who, target.action, target.resourceType, target.resourceId(input));
  if (!decision.allowed) {
    await appAudit(who?.id ?? 'anonymous', 'node.invoke', name, 'denied', correlationId);
    throw new Error('Node invocation forbidden');
  }
  if (target.kind === 'command' && !rootKey) throw new Error('Command invocation requires a transactional command or route');
  const nestedPath = [...path,name];
  const context = nodeContext(target, who!, client, rootKey, nestedPath, correlationId);
  if (target.kind === 'query') return parsedOutput(target.output, await target.handler(context,input));
  const key = createHash('sha256').update(JSON.stringify({ rootKey, nestedPath })).digest('hex');
  await client.lock(`nested:${name}:${who!.id}:${key}`);
  const inputDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const prior = await client.query('SELECT request_digest,response FROM lattis_node_receipt WHERE node_name=$1 AND principal_id=$2 AND idempotency_key=$3', [name,who!.id,key]);
  if (prior.rows[0]) {
    if (prior.rows[0].request_digest !== inputDigest) throw new Error('Nested idempotency conflict');
    return jsonValue(prior.rows[0].response);
  }
  const result = parsedOutput(target.output, await target.handler(context,input));
  if (JSON.stringify(result) === undefined) throw new Error('Node output must be JSON serializable');
  await client.query('INSERT INTO lattis_node_receipt (node_name,principal_id,idempotency_key,request_digest,response) VALUES ($1,$2,$3,$4,$5)', [name,who!.id,key,inputDigest,JSON.stringify(result)]);
  return result;
}
function nodeContext(node: NodeDefinition, who: Principal, client: Client, rootKey: string | null, path: string[], correlationId: string) {
  return { db: client, principal: who, secrets: { get: (secretName: string) => {
    if (!node.declaredSecrets?.includes(secretName)) throw new Error('Secret not declared by Node');
    return secrets.resolveForPackage(secretName, node.packageName);
  } }, invoke: (name: string, input: unknown) => invokeLocal(name,input,who,client,rootKey,path,correlationId) };
}
app.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: 'Invalid input', issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) });
  request.log.error(error);
  return reply.code(500).send({ error: 'Internal error' });
});

function sameOrigin(request: { headers: Record<string, unknown> }, reply: { code: (n: number) => { send: (v: unknown) => unknown } }): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== 'string') return true;
  if (origin === config.baseUrl || config.trustedOrigins.includes(origin)) return true;
  reply.code(403).send({ error: 'Origin forbidden' });
  return false;
}

async function principal(request: { headers: Record<string, unknown> }): Promise<Principal | null> {
  const bearer = request.headers.authorization;
  if (bearer !== undefined) {
    if (typeof bearer !== 'string' || !/^Bearer lattis_app_[A-Za-z0-9_-]+$/.test(bearer)) return null;
    const token = bearer.slice(7);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const found = await db.query('SELECT id,scopes FROM lattis_service_token WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()', [tokenHash]);
    return found.rows[0] ? { kind: 'service', id: found.rows[0].id, scopes: jsonValue(found.rows[0].scopes) as string[] } : null;
  }
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers as Parameters<typeof fromNodeHeaders>[0]) });
  if (!session) return null;
  const legacyProof = session.user.emailVerified ? false : (await db.query('SELECT 1 FROM lattis_import_user WHERE claimed_user_id=$1 AND password_claimed_at IS NOT NULL LIMIT 1', [session.user.id])).rowCount > 0;
  const value: Extract<Principal, { kind: 'user' }> = { kind: 'user', id: session.user.id, email: session.user.email, emailVerified: session.user.emailVerified, legacyPasswordAuthenticated: legacyProof };
  await bootstrapOwner(db, value, config.ownerEmail);
  return value;
}

async function requirePermission(request: { headers: Record<string, unknown>; id?: string }, reply: { code: (n: number) => { send: (v: unknown) => unknown } }, action: string, resourceType: string, resourceId = '*') {
  const who = await principal(request);
  const decision = await authorize(db, who, action, resourceType, resourceId);
  if (!decision.allowed) {
    reply.code(who ? 403 : 401).send({ error: decision.reason });
    return null;
  }
  return who!;
}

app.route({ method: ['GET', 'POST'], url: '/api/auth/*', async handler(request, reply) {
  if (request.method !== 'GET' && !sameOrigin(request, reply)) return;
  const url = new URL(request.url, config.baseUrl);
  const headers = fromNodeHeaders(request.headers);
  if (url.pathname.startsWith('/api/auth/admin/')) {
    const session = await auth.api.getSession({ headers });
    if (!session?.user.emailVerified) return reply.code(403).send({ error: 'Verified admin session required' });
  }
  const authRequest = () => new Request(url, { method: request.method, headers, ...(request.body ? { body: JSON.stringify(request.body) } : {}) });
  let response = await auth.handler(authRequest());
  if (request.method === 'POST' && url.pathname === '/api/auth/sign-in/email') {
    const credentials = request.body as { email?: unknown; password?: unknown } | null;
    if (credentials && typeof credentials.email === 'string' && typeof credentials.password === 'string') {
      const email = credentials.email.toLowerCase();
      if (response.status === 401 && await wordpressPasswords.provisionAfterFailedSignIn(email, credentials.password)) response = await auth.handler(authRequest());
      if (response.ok) {
        const body = await response.clone().json() as { user?: { id?: string } };
        if (body.user?.id) await wordpressPasswords.claimAfterSignIn(body.user.id, email, credentials.password, request.id);
      }
    }
  }
  reply.code(response.status);
  for (const [key, value] of response.headers) if (key !== 'set-cookie') reply.header(key, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) reply.header('set-cookie', cookies);
  return reply.send(response.body ? await response.text() : null);
} });

app.get('/health/live', async () => ({ status: 'live' }));
app.get('/health/ready', async (_request, reply) => {
  if (draining) return reply.code(503).send({ status: 'draining' });
  try { await db.query('SELECT 1 FROM lattis_role LIMIT 1'); return { status: 'ready' }; }
  catch { return reply.code(503).send({ status: 'not-ready' }); }
});
app.get('/version', async () => ({ core: coreVersion, contract: 1 }));
app.get('/lattis-video-player.js', async (_request, reply) => {
  const source = await readFile(new URL('../web/lattis-video-player.js', import.meta.url), 'utf8');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('cache-control', 'public, max-age=3600');
  return reply.type('application/javascript; charset=utf-8').send(source);
});
app.get('/openapi.json', async () => {
  const document = JSON.parse(await readFile(new URL('../openapi/app.json', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
  for (const route of routes) {
    const path = route.url.replace(/:([a-zA-Z][a-zA-Z0-9_]*)/g, '{$1}');
    document.paths[path] ??= {};
    document.paths[path][route.method.toLowerCase()] = {
      summary: `Shard route ${route.packageName}:${route.name}`,
      parameters: [...route.url.matchAll(/:([a-zA-Z][a-zA-Z0-9_]*)/g)].map((match) => ({ name: match[1], in: 'path', required: true, schema: { type: 'string' } })),
      ...(route.method === 'GET' ? {} : { requestBody: { content: { 'application/json': { schema: {} } } } }),
      responses: { '200': { description: 'Result' }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthenticated' }, '403': { description: 'Forbidden' }, '409': { description: 'Idempotency conflict' } },
      'x-lattis-access': route.access.kind === 'public' ? { kind: 'public' } : { kind: 'permission', action: route.access.action, resourceType: route.access.resourceType },
    };
  }
  return document;
});

app.get('/api/me', async (request, reply) => {
  const who = await principal(request);
  return who ?? reply.code(401).send({ error: 'unauthorized' });
});

app.post('/api/policies/check', async (request, reply) => {
  if (!sameOrigin(request, reply)) return;
  const who = await principal(request);
  const body = request.body as { action?: string; resourceType?: string; resourceId?: string };
  if (!body?.action || !body.resourceType) return reply.code(400).send({ error: 'action and resourceType required' });
  return authorize(db, who, body.action, body.resourceType, body.resourceId);
});

app.post('/api/roles/grants', async (request, reply) => {
  if (!sameOrigin(request, reply)) return;
  const who = await requirePermission(request, reply, 'role.manage', 'role');
  if (!who) return;
  const body = request.body as { roleId?: string; action?: string; resourceType?: string };
  if (!body?.roleId || !body.action || !body.resourceType) return reply.code(400).send({ error: 'Invalid grant' });
  await insertIgnore(db, db.dialect, 'lattis_role', ['id','description'], [body.roleId,'']);
  await insertIgnore(db, db.dialect, 'lattis_role_grant', ['role_id','action','resource_type'], [body.roleId, body.action, body.resourceType]);
  await appAudit( who.id, 'role.grant', body.roleId, 'allowed', request.id);
  return reply.code(201).send({ ok: true });
});

app.post('/api/roles/assignments', async (request, reply) => {
  if (!sameOrigin(request, reply)) return;
  const who = await requirePermission(request, reply, 'role.manage', 'role');
  if (!who) return;
  const body = request.body as { userId?: string; roleId?: string; resourceId?: string };
  if (!body?.userId || !body.roleId) return reply.code(400).send({ error: 'Invalid assignment' });
  if (body.roleId === 'owner') return reply.code(403).send({ error: 'Owner role is bootstrap-only' });
  const target = await db.query(db.dialect === 'postgres' ? 'SELECT 1 FROM "user" WHERE id=$1' : 'SELECT 1 FROM `user` WHERE id=$1', [body.userId]);
  if (!target.rowCount) return reply.code(404).send({ error: 'User not found' });
  await insertIgnore(db, db.dialect, 'lattis_user_role', ['user_id','role_id','resource_id'], [body.userId, body.roleId, body.resourceId ?? '*']);
  await appAudit( who.id, 'role.assign', body.userId, 'allowed', request.id);
  return reply.code(201).send({ ok: true });
});

app.delete('/api/roles/assignments', async (request, reply) => {
  if (!sameOrigin(request, reply)) return;
  const who = await requirePermission(request, reply, 'role.manage', 'role');
  if (!who) return;
  const body = request.body as { userId?: string; roleId?: string; resourceId?: string };
  if (!body?.userId || !body.roleId || body.roleId === 'owner') return reply.code(400).send({ error: 'Invalid assignment' });
  await db.query('DELETE FROM lattis_user_role WHERE user_id=$1 AND role_id=$2 AND resource_id=$3', [body.userId, body.roleId, body.resourceId ?? '*']);
  await appAudit( who.id, 'role.unassign', body.userId, 'allowed', request.id);
  return { ok: true };
});

app.get('/api/modules', async (request, reply) => {
  const who = await requirePermission(request, reply, 'module.read', 'module');
  if (!who) return;
  const lock = JSON.parse(await readFile('lattis.lock', 'utf8')) as { packages: Record<string, { version: string; digest: string; kind: string }> };
  const project = JSON.parse(await readFile('lattis.config.json', 'utf8')) as { trustedModules: string[] };
  return [
    ...Object.entries(lock.packages).map(([name, data]) => ({ name, ...data, state: 'pinned' })),
    ...project.trustedModules.map((path) => ({ path, state: 'trusted-local' })),
  ];
});

app.post('/api/secrets/references', async (request, reply) => {
  if (!sameOrigin(request, reply)) return;
  const who = await requirePermission(request, reply, 'secret.manage', 'secret');
  if (!who) return;
  const body = request.body as { name?: string; provider?: string; locator?: string; allowedPackage?: string };
  if (!body?.name || !body.provider || !body.locator || !body.allowedPackage || !['env', 'external'].includes(body.provider)) return reply.code(400).send({ error: 'Invalid reference' });
  if (process.env.NODE_ENV === 'production' && body.provider === 'env') return reply.code(400).send({ error: 'Environment secrets are development-only' });
  await db.query('INSERT INTO lattis_secret_ref (name,provider,locator,allowed_package) VALUES ($1,$2,$3,$4)', [body.name, body.provider, body.locator, body.allowedPackage]);
  await appAudit( who.id, 'secret.reference.create', body.name, 'allowed', request.id);
  return reply.code(201).send({ name: body.name, provider: body.provider, allowedPackage: body.allowedPackage });
});

app.get('/api/nodes', async (request, reply) => {
  const who = await requirePermission(request, reply, 'node.list', 'node');
  if (!who) return;
  return nodes.map(({ name, packageName, kind, action, resourceType }) => ({ name, packageName, kind, action, resourceType }));
});

app.post('/api/nodes/:name/execute', async (request, reply) => {
  if (!sameOrigin(request, reply)) return;
  const name = (request.params as { name: string }).name;
  const node = nodes.find((n) => n.name === name);
  if (!node) return reply.code(404).send({ error: 'Node not found' });
  const input = node.input.parse(request.body);
  const who = await requirePermission(request, reply, node.action, node.resourceType, node.resourceId(input));
  if (!who) return;
  if (node.kind === 'command') {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length > 128) return reply.code(400).send({ error: 'Idempotency-Key required' });
    const inputDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const client = await db.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.lock(`${name}:${who.id}:${key}`);
      const prior = await client.query('SELECT request_digest,response FROM lattis_node_receipt WHERE node_name=$1 AND principal_id=$2 AND idempotency_key=$3', [name, who.id, key]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== inputDigest) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Idempotency key reused with different input' }); }
        await client.query('COMMIT');
        committed = true;
        return jsonValue(prior.rows[0].response);
      }
      const result = parsedOutput(node.output, await node.handler(nodeContext(node,who,client,key,[name],request.id), input));
      if (JSON.stringify(result) === undefined) throw new Error('Node output must be JSON serializable');
      await client.query('INSERT INTO lattis_node_receipt (node_name,principal_id,idempotency_key,request_digest,response) VALUES ($1,$2,$3,$4,$5)', [name, who.id, key, inputDigest, JSON.stringify(result)]);
      await client.query('COMMIT');
      committed = true;
      await appAudit( who.id, 'node.execute', name, 'allowed', request.id);
      return result;
    } catch (error) { if (!committed) await client.query('ROLLBACK'); throw error; }
    finally { await client.release(); }
  }
  const client = await db.connect();
  try { return parsedOutput(node.output, await node.handler(nodeContext(node,who,client,null,[name],request.id), input)); }
  finally { await client.release(); }
});

for (const route of routes) {
  app.route({ method: route.method, url: route.url, async handler(request, reply) {
    if (route.method !== 'GET' && !sameOrigin(request, reply)) return;
    const input = route.input.parse({ params: request.params ?? {}, query: request.query ?? {}, body: request.body });
    const who = route.access.kind === 'public'
      ? null
      : await requirePermission(request, reply, route.access.action, route.access.resourceType, route.access.resourceId?.(input) ?? '*');
    if (route.access.kind === 'permission' && !who) return;
    const context = (client: Client, rootKey: string | null) => ({
      db: client,
      principal: who,
      secrets: { get: (name: string) => {
        if (!route.declaredSecrets?.includes(name)) throw new Error('Secret not declared by Shard route');
        return secrets.resolveForPackage(name, route.packageName);
      } },
      invoke: (name: string, input: unknown) => invokeLocal(name,input,who,client,rootKey,[`route:${route.packageName}:${route.name}`],request.id),
    });
    if (route.method === 'GET') {
      const client = await db.connect();
      try { return parsedOutput(route.output, await route.handler(context(client,null), input)); }
      finally { await client.release(); }
    }
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !key || key.length > 128) return reply.code(400).send({ error: 'Idempotency-Key required' });
    const receiptName = `route:${route.packageName}@${route.packageVersion}:${route.name}`;
    const inputDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const client = await db.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.lock(`${receiptName}:${who!.id}:${key}`);
      const prior = await client.query('SELECT request_digest,response FROM lattis_node_receipt WHERE node_name=$1 AND principal_id=$2 AND idempotency_key=$3', [receiptName, who!.id, key]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== inputDigest) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Idempotency key reused with different input' }); }
        await client.query('COMMIT');
        committed = true;
        return jsonValue(prior.rows[0].response);
      }
      const result = parsedOutput(route.output, await route.handler(context(client,key), input));
      if (JSON.stringify(result) === undefined) throw new Error('Shard route output must be JSON serializable');
      await client.query('INSERT INTO lattis_node_receipt (node_name,principal_id,idempotency_key,request_digest,response) VALUES ($1,$2,$3,$4,$5)', [receiptName, who!.id, key, inputDigest, JSON.stringify(result)]);
      await client.query('COMMIT');
      committed = true;
      await appAudit( who!.id, 'shard.route.execute', receiptName, 'allowed', request.id);
      return result;
    } catch (error) { if (!committed) await client.query('ROLLBACK'); throw error; }
    finally { await client.release(); }
  } });
}

registerContentRoutes(app, content, requirePermission, sameOrigin);
registerWordPressImport(app, content, requirePermission, sameOrigin);
registerUserImport(app, content, requirePermission, principal, sameOrigin);
registerMediaTransfer(app, content, requirePermission, sameOrigin);
registerVideoTransfer(app, db, requirePermission, sameOrigin);

await purgeOldVideoPlayback(db);
await app.listen({ host: config.host, port: config.port });
const videoRetentionTimer = setInterval(() => {
  void purgeOldVideoPlayback(db).catch((error: unknown) => app.log.warn({ err: error }, 'video playback retention cleanup is delayed'));
}, 86_400_000);
videoRetentionTimer.unref();
let auditRun: Promise<void> | undefined;
function exportAudit(): void {
  if (!auditLedger || auditRun || draining) return;
  auditRun = auditLedger.exportBatch().then(() => {}).catch((error: unknown) => {
    app.log.warn({ err: error }, 'immudb audit export is delayed');
  }).finally(() => { auditRun = undefined; });
}
exportAudit();
const auditTimer = auditLedger ? setInterval(exportAudit,15_000) : undefined;
auditTimer?.unref();
async function stop(): Promise<void> {
  if (draining) return;
  draining = true;
  try { clearInterval(videoRetentionTimer); if (auditTimer) clearInterval(auditTimer); await app.close(); await auditRun; await auditLedger?.close(); await db.end(); }
  catch (error) { app.log.error(error); process.exitCode = 1; }
}
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
