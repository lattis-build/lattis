import { LATTIS_VERSION } from './version.js';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { appDatabase, jsonValue } from './app-db.js';
import { manifestSchema } from './manifest.js';
import { readProject } from './project.js';
import { remoteWorkspace } from './remote-workspace.js';

const rawUrl = process.env.LATTIS_MCP_PUBLIC_URL;
const databaseUrl = process.env.APP_DATABASE_URL;
if (!rawUrl || !databaseUrl) throw new Error('LATTIS_MCP_PUBLIC_URL and APP_DATABASE_URL are required');
const publicUrl = new URL(rawUrl);
if (!['http:','https:'].includes(publicUrl.protocol) || !publicUrl.hostname || publicUrl.pathname !== '/mcp' || publicUrl.search || publicUrl.hash || (process.env.NODE_ENV === 'production' && publicUrl.protocol !== 'https:'))
  throw new Error('LATTIS_MCP_PUBLIC_URL must be an HTTPS /mcp URL in production');
const allowedOrigins = (process.env.LATTIS_MCP_ALLOWED_ORIGINS ?? publicUrl.origin).split(',').map((entry) => entry.trim()).filter(Boolean);
const db = appDatabase(databaseUrl);
const workspace = await remoteWorkspace();
const limit = new Map<string, { window: number; count: number }>();
const scopes = ['mcp-read:workspace','mcp-write:workspace','mcp-scaffold:workspace'] as const;
let projectMutation = false;
async function exclusiveProject<T>(operation: () => Promise<T>): Promise<T> {
  if (projectMutation) throw new Error('Another project configuration change is in progress');
  projectMutation = true;
  try { return await operation(); } finally { projectMutation = false; }
}

function bearer(value: string | null | undefined): string | null {
  const match = /^Bearer (lattis_app_[A-Za-z0-9_-]+)$/.exec(value ?? '');
  return match?.[1] ?? null;
}
async function access(token: string | null, scope?: typeof scopes[number]): Promise<{ id: string; scopes: string[] } | null> {
  if (!token) return null;
  const digest = createHash('sha256').update(token).digest('hex');
  const found = await db.query<{ id: string; scopes: unknown }>(
    'SELECT id,scopes FROM lattis_service_token WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()', [digest]);
  const row = found.rows[0];
  if (!row) return null;
  const granted = jsonValue(row.scopes) as unknown;
  if (!Array.isArray(granted) || !granted.every((item) => typeof item === 'string') || !granted.some((item) => scopes.includes(item as typeof scopes[number]))) return null;
  if (scope && !granted.includes(scope)) return null;
  return { id: row.id, scopes: granted };
}
async function audit(actor: string, action: string, resource: string): Promise<void> {
  await db.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)',
    [`service:${actor}`,action,resource,'allowed',actor]);
}
function result(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }; }
async function cli(args: string[]): Promise<unknown> {
  const script = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script, ...args],
    { cwd: workspace.workspace, env: process.env, shell: false, stdio: ['ignore','pipe','pipe'] });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let size = 0;
  child.stdout.on('data', (part: Buffer) => { size += part.length; if (size <= 128_000) stdout.push(part); else child.kill(); });
  child.stderr.on('data', (part: Buffer) => { if (Buffer.concat(stderr).length < 4_000) stderr.push(part); });
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  if (code !== 0) throw new Error(Buffer.concat(stderr).toString('utf8').slice(0, 1000) || 'Lattis CLI command failed');
  return JSON.parse(Buffer.concat(stdout).toString('utf8')) as unknown;
}

function mcpServer(request: Request) {
  const token = bearer(request.headers.get('authorization'));
  async function actor(scope: typeof scopes[number]) {
    const found = await access(token, scope);
    if (!found) throw new Error('MCP token lacks the required scope');
    return found;
  }
  const server = new McpServer({ name: 'lattis-instance', version: LATTIS_VERSION });
  server.registerTool('project.describe', { description: 'Describe this deployed application project and its pinned packages.', inputSchema: z.object({}) }, async () => {
    await actor('mcp-read:workspace');
    const config = await readProject(workspace.workspace);
    const lock = JSON.parse(await readFile(`${workspace.workspace}/lattis.lock`, 'utf8')) as unknown;
    return result({ config, lock, editableRoots:workspace.roots });
  });
  server.registerTool('workspace.list', { description: 'List one directory inside the configured editable source roots.', inputSchema: z.object({ directory:z.string() }) }, async ({ directory }) => {
    await actor('mcp-read:workspace'); return result(await workspace.list(directory));
  });
  server.registerTool('workspace.read', { description: 'Read a UTF-8 source file and its SHA-256 revision.', inputSchema: z.object({ path:z.string() }) }, async ({ path }) => {
    await actor('mcp-read:workspace'); return result(await workspace.read(path));
  });
  server.registerTool('workspace.mkdir', { description: 'Create a directory inside the configured editable source roots.', inputSchema: z.object({ directory:z.string() }) }, async ({ directory }) => {
    const who = await actor('mcp-write:workspace');
    const value = await workspace.mkdir(directory); await audit(who.id,'mcp.workspace.mkdir',directory); return result(value);
  });
  server.registerTool('workspace.write', { description: 'Replace a UTF-8 source file only if its SHA-256 revision matches. Use null only when creating a new file.',
    inputSchema: z.object({ path:z.string(), content:z.string(), expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable() }) }, async ({ path, content, expectedSha256 }) => {
    const who = await actor('mcp-write:workspace');
    const operation = () => workspace.write(path,content,expectedSha256);
    const value = path === 'lattis.config.json' ? await exclusiveProject(operation) : await operation();
    await audit(who.id,'mcp.workspace.write',path); return result(value);
  });
  server.registerTool('manifest.describe', { description: 'Read a package manifest as untrusted data.', inputSchema: z.object({ directory:z.string() }) }, async ({ directory }) => {
    await actor('mcp-read:workspace');
    const file = await workspace.read(`${directory}/lattis.manifest.json`);
    return result(manifestSchema.parse(JSON.parse(file.content)));
  });
  server.registerTool('node.scaffold', { description: 'Create and register a local Node package without running its code.', inputSchema: z.object({ name:z.string(), directory:z.string() }) }, async ({ name, directory }) => {
    const who = await actor('mcp-scaffold:workspace');
    const value = await exclusiveProject(async () => {
      const target = await workspace.scaffoldDirectory(directory);
      return cli(['node:new',name,target]);
    });
    await audit(who.id,'mcp.node.scaffold',directory); return result(value);
  });
  server.registerTool('shard.scaffold', { description: 'Create and register a local Shard package without running its code.', inputSchema: z.object({ name:z.string(), directory:z.string() }) }, async ({ name, directory }) => {
    const who = await actor('mcp-scaffold:workspace');
    const value = await exclusiveProject(async () => {
      const target = await workspace.scaffoldDirectory(directory);
      return cli(['shard:new',name,target]);
    });
    await audit(who.id,'mcp.shard.scaffold',directory); return result(value);
  });
  server.registerTool('migration.scaffold', { description: 'Create PostgreSQL and MariaDB migration files without applying them.', inputSchema: z.object({ id:z.string(),phase:z.enum(['expand','backfill','contract']),directory:z.string().optional() }) }, async ({ id, phase, directory }) => {
    const who = await actor('mcp-scaffold:workspace');
    const value = await exclusiveProject(async () => {
      const target = directory ? await workspace.localPackageDirectory(directory) : undefined;
      return cli(['migration:new',id,phase,...(target ? [target] : [])]);
    });
    await audit(who.id,'mcp.migration.scaffold',id); return result(value);
  });
  return server;
}

const mcp = createMcpHandler(({ requestInfo }) => mcpServer(requestInfo), { responseMode:'json' });
const server = createServer(async (req, res) => {
  try {
    if (req.url !== publicUrl.pathname || req.headers.host !== publicUrl.host) { res.writeHead(404).end(); return; }
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) { res.writeHead(403).end(); return; }
    const remote = `ip:${req.socket.remoteAddress ?? 'unknown'}`;
    const remoteBucket = limit.get(remote) ?? { window:Date.now(),count:0 };
    if (Date.now() - remoteBucket.window > 60_000) { remoteBucket.window=Date.now(); remoteBucket.count=0; }
    remoteBucket.count++; limit.set(remote,remoteBucket);
    if (remoteBucket.count > 600) { res.writeHead(429).end(); return; }
    const token = bearer(req.headers.authorization);
    if (!await access(token)) { res.writeHead(401,{ 'www-authenticate':'Bearer', 'cache-control':'no-store' }).end(); return; }
    const bucketKey = createHash('sha256').update(token!).digest('hex');
    const bucket = limit.get(bucketKey) ?? { window:Date.now(),count:0 };
    if (Date.now() - bucket.window > 60_000) { bucket.window=Date.now(); bucket.count=0; }
    bucket.count++; limit.set(bucketKey,bucket);
    if (limit.size > 10_000) for (const [key,value] of limit) if (Date.now() - value.window > 60_000) limit.delete(key);
    if (bucket.count > 120) { res.writeHead(429).end(); return; }
    let size = 0; const chunks: Buffer[] = [];
    for await (const part of req) { const chunk = Buffer.from(part); size += chunk.length; if (size > 1_000_000) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [key,value] of Object.entries(req.headers)) if (value) headers.set(key,Array.isArray(value) ? value.join(', ') : value);
    const request = new Request(publicUrl,{ method:req.method,headers,...(bytes.length ? { body:bytes } : {}) });
    const response = await mcp.fetch(request);
    res.writeHead(response.status,{ ...Object.fromEntries(response.headers),'cache-control':'no-store','x-content-type-options':'nosniff' });
    if (response.body) Readable.fromWeb(response.body as never).pipe(res); else res.end();
  } catch { res.writeHead(500,{ 'cache-control':'no-store' }).end(); }
});
server.listen(Number(process.env.LATTIS_MCP_PORT ?? 4301),process.env.LATTIS_MCP_HOST ?? '127.0.0.1');
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,() => { server.close(); void db.end(); });
