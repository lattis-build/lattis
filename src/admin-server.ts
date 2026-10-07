import { registryOrigin, registryRequest } from './registry-client.js';
import { boundedResponse } from './security-files.js';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fromNodeHeaders } from 'better-auth/node';
import { z, ZodError } from 'zod';
import { appConfig } from './config.js';
import { createAuth } from './auth.js';
import { appDatabase, insertIgnore, jsonValue } from './app-db.js';
import { authorize, bootstrapOwner, type Principal } from './authorization.js';
import { ContentError, ContentStore, contentSchemas } from './content.js';
import { contentNodes } from './content-nodes.js';
import { videoNodes } from './video-nodes.js';
import { manifestSchema } from './manifest.js';
import { projectFile, readProject } from './project.js';
import { DatabaseVaultSecrets } from './secrets.js';
import { extensionNodes, readExtensions, requireExtensionGraph } from './extensions.js';
import { controlledExecutor, NodeExecutionError } from './node-executor.js';
import { httpLogger, registerHttpPolicy } from './http-policy.js';

import { requireRuntimeComponent } from './production-release.js';
await requireRuntimeComponent('admin');

const core = appConfig();
const configuredUrl = process.env.LATTIS_ADMIN_BASE_URL;
const vaultKey = process.env.LATTIS_VAULT_KEY;
if (!configuredUrl || !vaultKey) throw new Error('LATTIS_ADMIN_BASE_URL and LATTIS_VAULT_KEY are required');
const base = new URL(configuredUrl);
if (!['http:','https:'].includes(base.protocol) || !base.hostname || base.pathname !== '/' || base.search || base.hash || (process.env.NODE_ENV === 'production' && base.protocol !== 'https:'))
  throw new Error('LATTIS_ADMIN_BASE_URL must be an HTTPS origin in production');
const geodeUrl = new URL(registryOrigin());
const db = appDatabase(core.databaseUrl);
const vault = new DatabaseVaultSecrets(db,vaultKey);
const auth = createAuth(db,{ baseUrl:base.origin,signupOpen:false,trustedOrigins:[base.origin] });
const controlledNames = new Set<string>();
const content = new ContentStore(db,controlledNames,new Set());
const app = Fastify({ logger:httpLogger,bodyLimit:100_000,trustProxy:core.trustedProxies.length ? core.trustedProxies : false });
registerHttpPolicy(app, base.origin);
const controlledNodes = [...contentNodes(content), ...videoNodes(), ...await extensionNodes()];
for (const node of controlledNodes) controlledNames.add(node.name);
if (new Set(controlledNodes.map((node) => node.name)).size !== controlledNodes.length) throw new Error('Duplicate controlled Node');
await requireExtensionGraph(controlledNodes);
const executeControlled = controlledExecutor(db, controlledNodes);

app.addHook('onRequest',async (request,reply) => {
  if (request.headers.host !== base.host) { reply.code(404).send({ error:'Not found' }); return; }
  reply.header('cache-control','no-store').header('x-content-type-options','nosniff')
    .header('referrer-policy','no-referrer').header('x-frame-options','DENY')
    .header('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
});
app.setErrorHandler((error,request,reply) => {
  if (error instanceof NodeExecutionError) return reply.code(error.status).send({ error:error.message });
  if (error instanceof ZodError) return reply.code(400).send({ error:'Invalid input',issues:error.issues.map((issue) => ({ path:issue.path,message:issue.message })) });
  if (error instanceof ContentError) return reply.code(error.status).send({ error:error.message });
  if (error instanceof Error && error.message === 'Secret version conflict') return reply.code(409).send({ error:error.message });
  if ((error as { code?: string }).code === '23505' || (error as { code?: string }).code === 'ER_DUP_ENTRY') return reply.code(409).send({ error:'Already exists' });
  if (request.url.startsWith('/api/admin/secrets') || request.url.startsWith('/api/auth/'))
    request.log.error({ code:(error as { code?: string }).code ?? 'ADMIN_SECRET_ERROR' },'Protected admin operation failed');
  else request.log.error(error);
  return reply.code(500).send({ error:'Internal error' });
});
function sameOrigin(request: FastifyRequest,reply: FastifyReply): boolean {
  if (request.headers.origin !== base.origin || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) {
    reply.code(403).send({ error:'Origin forbidden' }); return false;
  }
  return true;
}
async function session(request: FastifyRequest): Promise<Extract<Principal,{ kind:'user' }> | null> {
  const value = await auth.api.getSession({ headers:fromNodeHeaders(request.headers) });
  if (!value?.user.emailVerified) return null;
  const who: Extract<Principal,{ kind:'user' }> = {
    kind:'user',id:value.user.id,email:value.user.email,emailVerified:true,legacyPasswordAuthenticated:false,
  };
  await bootstrapOwner(db,who,core.ownerEmail);
  return who;
}
async function permitted(request: FastifyRequest,reply: FastifyReply,action: string,resourceType: string,resourceId = '*') {
  const who = await session(request);
  if (!who) { reply.code(401).send({ error:'Verified sign-in required' }); return null; }
  if (who.email.toLowerCase() !== core.ownerEmail) { reply.code(403).send({ error:'Instance owner required' }); return null; }
  if (!(await authorize(db,who,'panel.access','panel')).allowed || !(await authorize(db,who,action,resourceType,resourceId)).allowed) {
    reply.code(403).send({ error:'Forbidden' }); return null;
  }
  return who;
}
async function ownerOnly(request: FastifyRequest,reply: FastifyReply,action: string,resourceType: string,resourceId = '*') {
  const who = await permitted(request,reply,action,resourceType,resourceId);
  if (!who) return null;
  if (who.email.toLowerCase() !== core.ownerEmail) { reply.code(403).send({ error:'Instance owner required' }); return null; }
  return who;
}
async function audit(who: Principal,action: string,resource: string,request: FastifyRequest) {
  await db.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)',
    [who.id,action,resource,'allowed',request.id]);
}
const secretCreate = z.object({ name:z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),allowedPackage:z.string().regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/),value:z.string().min(1).max(16_000) }).strict();
const secretRotate = z.object({ expectedVersion:z.number().int().positive(),value:z.string().min(1).max(16_000) }).strict();
const tokenCreate = z.object({ name:z.string().regex(/^[a-z0-9-]{1,50}$/),expiresDays:z.number().int().min(1).max(365),scopes:z.array(z.enum(['mcp-read:workspace','mcp-write:workspace','mcp-scaffold:workspace'])).min(1).max(3) }).strict();

app.route({ method:['GET','POST'],url:'/api/auth/*',async handler(request,reply) {
  if (request.url.startsWith('/api/auth/admin/')) return reply.code(404).send({ error:'Not found' });
  if (request.method === 'POST' && !sameOrigin(request,reply)) return;
  const url = new URL(request.url,base.origin);
  const headers = fromNodeHeaders(request.headers);
  const response = await auth.handler(new Request(url,{ method:request.method,headers,...(request.body ? { body:JSON.stringify(request.body) } : {}) }));
  reply.code(response.status);
  for (const [key,value] of response.headers) if (key !== 'set-cookie') reply.header(key,value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) reply.header('set-cookie',cookies);
  return reply.send(response.body ? await response.text() : null);
} });
app.get('/',async (_request,reply) => reply.type('text/html; charset=utf-8').send(await readFile(new URL('../web/admin/index.html',import.meta.url),'utf8')));
app.get('/admin.css',async (_request,reply) => reply.type('text/css; charset=utf-8').send(await readFile(new URL('../web/admin/admin.css',import.meta.url),'utf8')));
app.get('/admin.js',async (_request,reply) => reply.type('application/javascript; charset=utf-8').send(await readFile(new URL('../web/admin/admin.js',import.meta.url),'utf8')));
app.get('/api/admin/session',async (request,reply) => {
  const who = await permitted(request,reply,'panel.access','panel');
  return who ? { id:who.id,email:who.email } : undefined;
});
app.get('/api/admin/overview',async (request,reply) => {
  if (!await permitted(request,reply,'panel.access','panel')) return;
  const [types,entries,media,users] = await Promise.all([
    db.query('SELECT count(*) AS count FROM lattis_content_type'),db.query('SELECT count(*) AS count FROM lattis_content'),
    db.query('SELECT count(*) AS count FROM lattis_media'),db.query(db.dialect === 'postgres' ? 'SELECT count(*) AS count FROM "user"' : 'SELECT count(*) AS count FROM `user`'),
  ]);
  return { contentTypes:Number(types.rows[0]?.count ?? 0),entries:Number(entries.rows[0]?.count ?? 0),media:Number(media.rows[0]?.count ?? 0),users:Number(users.rows[0]?.count ?? 0) };
});
app.get('/api/admin/settings',async (request,reply) => {
  if (!await ownerOnly(request,reply,'secret.manage','secret')) return;
  const [rows,pending] = await Promise.all([
    db.query<{ name:string;provider:string;locator:string;allowed_package:string;version:number|null }>(
      'SELECT r.name,r.provider,r.locator,r.allowed_package,s.version FROM lattis_secret_ref r LEFT JOIN lattis_admin_secret s ON s.name=r.name ORDER BY r.name'),
    db.query<{ setting_value:string }>('SELECT setting_value FROM lattis_admin_setting WHERE setting_key=$1',['pending_admin_url']),
  ]);
  return { adminUrl:base.origin,appUrl:core.baseUrl,mcpUrl:process.env.LATTIS_MCP_PUBLIC_URL ?? null,
    geodeUrl:geodeUrl?.origin ?? null,mailWebhookConfigured:!!process.env.LATTIS_MAIL_WEBHOOK_URL,
    smtpTransportAvailable:false,pendingAdminUrl:pending.rows[0]?.setting_value ?? null,
    secrets:rows.rows.map((row) => ({ name:row.name,provider:row.provider,allowedPackage:row.allowed_package,version:row.version })) };
});
app.put('/api/admin/settings/admin-url',async (request,reply) => {
  if (!sameOrigin(request,reply)) return;
  const who = await ownerOnly(request,reply,'secret.manage','secret'); if (!who) return;
  const input = z.object({ url:z.url().max(255) }).strict().parse(request.body);
  const target = new URL(input.url);
  if (!['http:','https:'].includes(target.protocol) || !target.hostname || target.pathname !== '/' || target.search || target.hash || (process.env.NODE_ENV === 'production' && target.protocol !== 'https:'))
    return reply.code(400).send({ error:'Admin URL must be an HTTPS origin in production' });
  const sql = db.dialect === 'postgres'
    ? 'INSERT INTO lattis_admin_setting (setting_key,setting_value) VALUES ($1,$2) ON CONFLICT (setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=$3'
    : 'INSERT INTO lattis_admin_setting (setting_key,setting_value) VALUES ($1,$2) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=$3';
  await db.query(sql,['pending_admin_url',target.origin,new Date()]);
  await audit(who,'admin.url.propose',target.origin,request);
  return { pendingAdminUrl:target.origin,requiresReverseProxyAndRestart:true };
});
app.post('/api/admin/secrets',async (request,reply) => {
  if (!sameOrigin(request,reply)) return;
  const who = await ownerOnly(request,reply,'secret.manage','secret'); if (!who) return;
  const input = secretCreate.parse(request.body);
  await vault.create(input.name,input.allowedPackage,input.value,who.id,request.id);
  return reply.code(201).send({ name:input.name,allowedPackage:input.allowedPackage,version:1 });
});
app.put('/api/admin/secrets/:name',async (request,reply) => {
  if (!sameOrigin(request,reply)) return;
  const name = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).parse((request.params as { name:string }).name);
  const who = await ownerOnly(request,reply,'secret.manage','secret',name); if (!who) return;
  const input = secretRotate.parse(request.body);
  return { name,version:await vault.rotate(name,input.expectedVersion,input.value,who.id,request.id) };
});
app.get('/api/admin/tokens',async (request,reply) => {
  if (!await ownerOnly(request,reply,'token.manage','token')) return;
  const rows = await db.query<{ id:string;name:string;scopes:unknown;expires_at:unknown;revoked_at:unknown }>('SELECT id,name,scopes,expires_at,revoked_at FROM lattis_service_token ORDER BY expires_at DESC LIMIT 100');
  return rows.rows.map((row) => ({ id:row.id,name:row.name,scopes:jsonValue(row.scopes),expiresAt:row.expires_at,revokedAt:row.revoked_at }));
});
app.post('/api/admin/tokens',async (request,reply) => {
  if (!sameOrigin(request,reply)) return;
  const who = await ownerOnly(request,reply,'token.manage','token'); if (!who) return;
  const input = tokenCreate.parse(request.body);
  const id = randomUUID(), secret = `lattis_app_${randomBytes(32).toString('base64url')}`;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO lattis_service_token (id,name,token_hash,scopes,expires_at) VALUES ($1,$2,$3,$4,$5)',
      [id,input.name,createHash('sha256').update(secret).digest('hex'),db.dialect === 'mariadb' ? JSON.stringify(input.scopes) : input.scopes,new Date(Date.now() + input.expiresDays*86_400_000)]);
    await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)',[who.id,'token.create',id,'allowed',request.id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { await client.release(); }
  return reply.code(201).send({ id,token:secret,scopes:input.scopes });
});
app.delete('/api/admin/tokens/:id',async (request,reply) => {
  if (!sameOrigin(request,reply)) return;
  const id = z.uuid().parse((request.params as { id:string }).id);
  const who = await ownerOnly(request,reply,'token.manage','token',id); if (!who) return;
  const changed = await db.query('UPDATE lattis_service_token SET revoked_at=$1 WHERE id=$2 AND revoked_at IS NULL',[new Date(),id]);
  if (!changed.rowCount) return reply.code(404).send({ error:'Active token not found' });
  await audit(who,'token.revoke',id,request);
  return { revoked:id };
});
app.get('/api/admin/content-types',async (request,reply) => {
  if (!await permitted(request,reply,'content.type.read','content')) return;
  return content.listTypes();
});
app.post('/api/admin/content-types',async (request,reply) => {
  if (!sameOrigin(request,reply)) return;
  const who = await permitted(request,reply,'content.type.manage','content'); if (!who) return;
  const created = await content.createType(request.body); await audit(who,'content.type.create',created.key,request);
  return reply.code(201).send(created);
});
app.get('/api/admin/content',async (request,reply) => {
  if (!await permitted(request,reply,'content.read','content')) return;
  const query = z.object({ type:contentSchemas.key.optional(),limit:z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
  return content.list(query.type,false,query.limit);
});
app.get('/api/admin/content/:id',async (request,reply) => {
  const id = z.uuid().parse((request.params as { id:string }).id);
  if (!await permitted(request,reply,'content.read','content',id)) return;
  return await content.get(id) ?? reply.code(404).send({ error:'Not found' });
});
app.post('/api/admin/content',async (request,reply) => {
  if (!sameOrigin(request,reply)) return;
  const who = await permitted(request,reply,'content.write','content'); if (!who) return;
  const created = await content.create(request.body); await audit(who,'content.create',created!.id,request);
  return reply.code(201).send(created);
});
app.put('/api/admin/content/:id',async (request,reply) => {
  if (!sameOrigin(request,reply)) return;
  const id = z.uuid().parse((request.params as { id:string }).id);
  const who = await permitted(request,reply,'content.write','content',id); if (!who) return;
  const input = z.object({ expectedRevision:z.number().int().positive(),content:contentSchemas.contentInput }).strict().parse(request.body);
  const updated = await content.update(id,input.content,input.expectedRevision); await audit(who,'content.update',id,request);
  return updated;
});
app.get('/api/admin/users',async (request,reply) => {
  if (!await permitted(request,reply,'user.read','user')) return;
  const rows = await db.query<{ id:string;name:string;email:string;emailVerified:boolean;createdAt:unknown }>(db.dialect === 'postgres'
    ? 'SELECT id,name,email,"emailVerified","createdAt" FROM "user" ORDER BY "createdAt" DESC LIMIT 100'
    : 'SELECT id,name,email,emailVerified,createdAt FROM `user` ORDER BY createdAt DESC LIMIT 100');
  return rows.rows;
});
app.get('/api/admin/roles',async (request,reply) => {
  if (!await ownerOnly(request,reply,'role.manage','role')) return;
  const [roles,assignments] = await Promise.all([
    db.query('SELECT id,description FROM lattis_role ORDER BY id'),
    db.query('SELECT user_id,role_id,resource_id FROM lattis_user_role ORDER BY user_id,role_id LIMIT 500'),
  ]);
  return { roles:roles.rows,assignments:assignments.rows };
});
app.post('/api/admin/roles',async (request,reply) => {
  if (!sameOrigin(request,reply)) return;
  const who = await ownerOnly(request,reply,'role.manage','role'); if (!who) return;
  const input = z.object({ id:z.string().regex(/^[a-z][a-z0-9_-]{1,49}$/),description:z.string().max(255).default(''),
    grants:z.array(z.object({ action:z.string().regex(/^[a-z*][a-z0-9.*-]{0,99}$/),resourceType:z.string().regex(/^[a-z*][a-z0-9.*-]{0,99}$/) }).strict()).min(1).max(50) }).strict().parse(request.body);
  if (input.id === 'owner') return reply.code(403).send({ error:'Owner role is bootstrap-only' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO lattis_role (id,description) VALUES ($1,$2)',[input.id,input.description]);
    for (const grant of input.grants) await insertIgnore(client,db.dialect,'lattis_role_grant',['role_id','action','resource_type'],[input.id,grant.action,grant.resourceType]);
    await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)',[who.id,'role.create',input.id,'allowed',request.id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { await client.release(); }
  return reply.code(201).send({ id:input.id,description:input.description,grants:input.grants });
});
app.post('/api/admin/users/:id/roles',async (request,reply) => {
  if (!sameOrigin(request,reply)) return;
  const id = z.string().min(1).max(191).parse((request.params as { id:string }).id);
  const who = await ownerOnly(request,reply,'role.manage','role'); if (!who) return;
  const input = z.object({ roleId:z.string().min(1).max(191),resourceId:z.string().min(1).max(191).default('*') }).strict().parse(request.body);
  if (input.roleId === 'owner') return reply.code(403).send({ error:'Owner role is bootstrap-only' });
  const target = await db.query(db.dialect === 'postgres' ? 'SELECT 1 FROM "user" WHERE id=$1' : 'SELECT 1 FROM `user` WHERE id=$1',[id]);
  if (!target.rowCount) return reply.code(404).send({ error:'User not found' });
  await insertIgnore(db,db.dialect,'lattis_user_role',['user_id','role_id','resource_id'],[id,input.roleId,input.resourceId]);
  await audit(who,'role.assign',id,request);
  return reply.code(201).send({ userId:id,...input });
});
app.delete('/api/admin/users/:id/roles/:roleId',async (request,reply) => {
  if (!sameOrigin(request,reply)) return;
  const params = z.object({ id:z.string().min(1).max(191),roleId:z.string().min(1).max(191) }).parse(request.params);
  const who = await ownerOnly(request,reply,'role.manage','role'); if (!who) return;
  if (params.roleId === 'owner') return reply.code(403).send({ error:'Owner role is bootstrap-only' });
  const changed = await db.query('DELETE FROM lattis_user_role WHERE user_id=$1 AND role_id=$2 AND resource_id=$3',[params.id,params.roleId,'*']);
  if (!changed.rowCount) return reply.code(404).send({ error:'Assignment not found' });
  await audit(who,'role.unassign',params.id,request);
  return { removed:true };
});
app.get('/api/admin/modules',async (request,reply) => {
  if (!await permitted(request,reply,'module.read','module')) return;
  const project = await readProject();
  const modules: Array<{ name:string;kind:string;version:string;path:string;nodes:Array<{ name:string;kind:string }>;
    routes:Array<{ name:string;path:string }>;dependencies:string[];connections:Array<{ from:string;to:string;kind:string }> }> = [];
  for (const path of project.trustedModules) {
    const file = await projectFile(process.cwd(),path,'.ts');
    const manifest = manifestSchema.parse(JSON.parse(await readFile(join(dirname(file),'lattis.manifest.json'),'utf8')));
    modules.push({ name:manifest.name,kind:manifest.kind,version:manifest.version,path,
      nodes:manifest.nodes.map((node) => ({ name:node.name,kind:node.kind })),
      routes:manifest.routes.map((route) => ({ name:route.name,path:route.path })),
      dependencies:Object.keys(manifest.dependencies),connections:manifest.connections ?? [] });
  }
  for (const { path, definition } of await readExtensions()) modules.push({ name:definition.name,kind:'declarative',version:definition.version,path,
    nodes:definition.nodes.map(({ name,kind }) => ({ name,kind })),routes:[],dependencies:[],
    connections:definition.nodes.flatMap((node) => node.steps.map((step) => ({ from:node.name,to:step.invoke,kind:'invokes' }))) });
  modules.unshift(...(['@lattis/content','@lattis/video'] as const).map((packageName) => ({
    name:packageName,kind:'core',version:'built-in',path:'Core',
    nodes:(packageName === '@lattis/content' ? contentNodes(content) : videoNodes()).map((item) => ({ name:item.name,kind:item.kind })),
    routes:[],dependencies:[],connections:[],
  })));
  const vertices = modules.flatMap((module) => [
    { id:module.name,label:module.name,kind:module.kind },
    ...module.nodes.map((node) => ({ id:node.name,label:node.name,kind:'node' })),
    ...module.routes.map((route) => ({ id:`${module.name}:${route.name}`,label:route.name,kind:'shard-route' })),
  ]);
  const edges = modules.flatMap((module) => [
    ...module.nodes.map((node) => ({ from:module.name,to:node.name,kind:'contains' })),
    ...module.routes.map((route) => ({ from:module.name,to:`${module.name}:${route.name}`,kind:'contains' })),
    ...module.dependencies.map((dependency) => ({ from:module.name,to:dependency,kind:'depends-on' })),
    ...module.connections,
  ]);
  const known = new Set(vertices.map((vertex) => vertex.id));
  for (const endpoint of edges.flatMap((edge) => [edge.from,edge.to])) {
    if (!known.has(endpoint)) { known.add(endpoint); vertices.push({ id:endpoint,label:endpoint,kind:endpoint.startsWith('process:') ? 'process' : endpoint.startsWith('external:') ? 'external' : 'reference' }); }
  }
  return { modules,graph:{ vertices,edges } };
});

app.get('/api/admin/extensions', async (request, reply) => {
  if (!await permitted(request,reply,'module.read','module')) return;
  return (await readExtensions()).map(({ definition }) => ({ name:definition.name,version:definition.version,
    views:definition.ui.views.map((view) => { const target=definition.nodes.find((node) => node.name===view.node)!; return { ...view,kind:target.kind,fields:target.input }; }) }));
});
app.post('/api/admin/extensions/execute', async (request, reply) => {
  if (!sameOrigin(request,reply)) return;
  const who=await permitted(request,reply,'panel.access','panel'); if (!who) return;
  const body=z.object({ package:z.string().max(150),view:z.string().max(100),input:z.record(z.string(),z.unknown()) }).strict().parse(request.body);
  const extension=(await readExtensions()).find(({ definition }) => definition.name===body.package)?.definition;
  const target=extension?.ui.views.find((view) => view.id===body.view);
  if (!target) return reply.code(404).send({ error:'Extension view not found' });
  const key=request.headers['idempotency-key'];
  return executeControlled(target.node,body.input,who,typeof key==='string' ? key : undefined,request.id);
});
app.get('/api/admin/security', async (request, reply) => {
  if (!await permitted(request,reply,'module.read','module')) return;
  return { version:(await import('./version.js')).LATTIS_VERSION, production:process.env.NODE_ENV==='production',
    extensionExecution:'declarative-v1',downloadedExecution:false,customPanelScripts:false,
    releaseProfile:'controlled-v1',verification:'not-established-by-this-endpoint',
    waf:'external-service-requires-operator-evidence',review:'required-before-production-activation' };
});
app.get('/api/admin/geode',async (request,reply) => {
  if (!await permitted(request,reply,'module.read','module')) return;
  if (!geodeUrl) return { available:false,packages:[] };
  const query = z.object({ q:z.string().max(100).default('') }).parse(request.query);
  const target = new URL('/v1/packages',geodeUrl); target.searchParams.set('q',query.q); target.searchParams.set('limit','40');
  const response = await registryRequest(target.pathname + target.search);
  if (!response.ok) return reply.code(502).send({ error:'Geode unavailable' });
  const bytes = await boundedResponse(response, 1_000_000);
  return { available:true,packages:JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown };
});
app.get('/api/admin/media',async (request,reply) => {
  if (!await permitted(request,reply,'content.media.read','content')) return;
  const rows = await db.query('SELECT id,mime_type,alt_text,metadata,created_at FROM lattis_media ORDER BY created_at DESC LIMIT 100');
  return rows.rows.map((row) => ({ id:row.id,mimeType:row.mime_type,altText:row.alt_text,metadata:jsonValue(row.metadata),createdAt:row.created_at }));
});
app.get('/api/admin/sales',async (request,reply) => {
  if (!await permitted(request,reply,'commerce.sale.read','sale')) return;
  try {
    const rows = await db.query('SELECT sale_id,currency,total_minor,status,fulfillment_status,created_at FROM lattis_commerce_sale ORDER BY created_at DESC LIMIT 100');
    return { available:true,sales:rows.rows };
  } catch (error) {
    if (['42P01','ER_NO_SUCH_TABLE'].includes((error as { code?: string }).code ?? '')) return { available:false,sales:[] };
    throw error;
  }
});

await app.listen({ host:process.env.LATTIS_ADMIN_HOST ?? '127.0.0.1',port:Number(process.env.LATTIS_ADMIN_PORT ?? 4300) });
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,() => { void app.close(); void db.end(); });
