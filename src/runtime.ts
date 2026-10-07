import { productionRelease } from './production-release.js';
import { canonicalJson, digest } from './manifest.js';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppClient } from './app-db.js';
import type { AppDialect } from './app-db.js';
import type { Principal } from './authorization.js';
import { manifestSchema } from './manifest.js';
import { projectFile, readProject } from './project.js';
import type { z } from 'zod';

export type SecretAccess = { get: (name: string) => Promise<string> };
export type NodeContext = { db: AppClient; principal: Principal; secrets: SecretAccess; invoke: (name: string, input: unknown) => Promise<unknown> };
export type RouteContext = { db: AppClient; principal: Principal | null; secrets: SecretAccess; invoke: (name: string, input: unknown) => Promise<unknown> };
export type NodeDefinition = {
  name: string;
  packageName: string;
  declaredSecrets?: string[];
  kind: 'command' | 'query';
  action: string;
  resourceType: string;
  resourceId: (input: unknown) => string;
  input: z.ZodType;
  output: z.ZodType;
  handler: (context: NodeContext, input: unknown) => Promise<unknown>;
};

export type ShardRouteDefinition = {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  access: { kind: 'public' } | { kind: 'permission'; action: string; resourceType: string; resourceId?: (input: unknown) => string };
  declaredSecrets?: string[];
  input: z.ZodType;
  output: z.ZodType;
  handler: (context: RouteContext, input: unknown) => Promise<unknown>;
};
export type LoadedShardRoute = ShardRouteDefinition & { packageName: string; packageVersion: string; url: string };

function routePath(packageName: string, path: string): string {
  if (path !== '/' && !/^\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9_]*)(?:\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9_]*))*$/.test(path)) throw new Error(`Invalid Shard route path: ${path}`);
  const [publisher, shard] = packageName.slice(1).split('/');
  return `/api/shards/${publisher}/${shard}${path === '/' ? '' : path}`;
}

export async function loadLocalModules(dialect: AppDialect = 'postgres'): Promise<{ nodes: NodeDefinition[]; routes: LoadedShardRoute[] }> {
  const release = await productionRelease();
  const config = await readProject();
  if (release && (digest(Buffer.from(canonicalJson(config))) !== release.configurationDigest || canonicalJson(config.trustedModules.map((p) => p.replace(/^\.\//, ''))) !== canonicalJson(release.trustedModules))) throw new Error('Runtime project configuration differs from the authorized release');
  const nodes: NodeDefinition[] = [];
  const routes: LoadedShardRoute[] = [];
  for (const modulePath of config.trustedModules) {
    if (!modulePath.startsWith('./packages/local/')) throw new Error('Only locally reviewed application modules may execute in phase 1');
    const entry = await projectFile(process.cwd(), modulePath, '.ts');
    const manifest = manifestSchema.parse(JSON.parse(await readFile(join(dirname(entry), 'lattis.manifest.json'), 'utf8')));
    if (manifest.name.split('/')[0] !== `@${config.localPublisher}`) throw new Error('Foreign publisher code cannot execute in Core in phase 1');
    if (!manifest.databaseDialects.includes(dialect)) throw new Error(`Trusted module ${manifest.name} does not declare ${dialect} support`);
    const module = await import(pathToFileURL(entry).href) as { nodes?: NodeDefinition[]; routes?: ShardRouteDefinition[] };
    if (!Array.isArray(module.nodes)) throw new Error(`Trusted module has no nodes: ${modulePath}`);
    for (const node of module.nodes) {
      if (!node || node.packageName !== manifest.name || !node.name || node.name.startsWith('route:') || !['command', 'query'].includes(node.kind) || !node.action || !node.resourceType || typeof node.resourceId !== 'function' || typeof node.input?.parse !== 'function' || typeof node.output?.safeParse !== 'function' || typeof node.handler !== 'function') throw new Error(`Invalid Node in ${modulePath}`);
      if (node.declaredSecrets?.some((secret) => !manifest.secrets.includes(secret))) throw new Error(`Undeclared Node secret in ${modulePath}`);
      nodes.push(node);
    }
    const declared = manifest.routes;
    const actual = module.routes ?? [];
    if (!Array.isArray(actual) || (manifest.kind !== 'shard' && actual.length) || actual.length !== declared.length) throw new Error(`Shard routes differ from manifest: ${modulePath}`);
    const byName = new Map(declared.map((route) => [route.name, route]));
    if (byName.size !== declared.length) throw new Error(`Duplicate route name in manifest: ${modulePath}`);
    for (const route of actual) {
      const metadata = route && byName.get(route.name);
      if (!metadata || metadata.method !== route.method || metadata.path !== route.path || metadata.access.kind !== route.access?.kind || typeof route.input?.parse !== 'function' || typeof route.output?.safeParse !== 'function' || typeof route.handler !== 'function') throw new Error(`Shard route differs from manifest: ${modulePath}`);
      if (route.access.kind === 'public') {
        if (route.method !== 'GET') throw new Error(`Public Shard route must use GET: ${route.name}`);
      } else if (metadata.access.kind !== 'permission' || metadata.access.action !== route.access.action || metadata.access.resourceType !== route.access.resourceType) {
        throw new Error(`Shard route permission differs from manifest: ${route.name}`);
      }
      if (route.declaredSecrets?.some((secret) => !manifest.secrets.includes(secret))) throw new Error(`Undeclared route secret: ${route.name}`);
      routes.push({ ...route, packageName: manifest.name, packageVersion: manifest.version, url: routePath(manifest.name, route.path) });
    }
  }
  if (new Set(nodes.map((node) => node.name)).size !== nodes.length) throw new Error('Duplicate local node names');
  if (new Set(routes.map((route) => `${route.method} ${route.url}`)).size !== routes.length) throw new Error('Duplicate Shard route paths');
  if (new Set(routes.map((route) => `${route.packageName}:${route.name}`)).size !== routes.length) throw new Error('Duplicate Shard route names');
  return { nodes, routes };
}
