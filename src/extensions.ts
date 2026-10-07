import semver from 'semver';
import { insideFile, relativePath } from './security-files.js';
import { readProject } from './project.js';
import { parseExtension, inputSchema, type Extension } from './extension-contract.js';
import { evaluateExpression } from './extension-client.js';
import { LATTIS_VERSION } from './version.js';
import { digest } from './manifest.js';
import type { NodeDefinition } from './runtime.js';

export async function readExtensions(root = process.cwd()): Promise<Array<{ path: string; digest: string; definition: Extension }>> {
  const config = await readProject(root);
  const result: Array<{ path: string; digest: string; definition: Extension }> = [];
  for (const entry of config.extensions) {
    const path = relativePath(entry.replace(/^\.\//, ''));
    if (!path.startsWith('extensions/') || !path.endsWith('.json')) throw new Error('Declarative extensions belong in extensions/*.json');
    const bytes = await insideFile(root, path, 100000);
    const definition = parseExtension(JSON.parse(bytes.toString('utf8')));
    if (!definition.name.startsWith(`@${config.localPublisher}/`)) throw new Error('Downloaded or foreign extensions remain unavailable for execution in phase 1');
    if (!semver.satisfies(LATTIS_VERSION, definition.coreCompatibility, { includePrerelease: true })) throw new Error('Extension is incompatible with Core');
    result.push({ path, digest: digest(bytes), definition });
  }
  if (new Set(result.map((entry) => entry.definition.name)).size !== result.length) throw new Error('Duplicate extension package');
  return result;
}

export async function extensionNodes(): Promise<NodeDefinition[]> {
  return (await readExtensions()).flatMap(({ definition }) => definition.nodes.map((node): NodeDefinition => ({
    name: node.name, packageName: definition.name, kind: node.kind, action: node.action, resourceType: node.resourceType,
    resourceId: (input) => node.resource.kind === 'all' ? '*' : String((input as Record<string, unknown>)[node.resource.field]),
    input: inputSchema(node.input), output: inputSchema(node.output), declaredSecrets: [],
    handler: async (context, input) => {
      const results: Record<string, unknown> = Object.create(null);
      const started = Date.now();
      for (const step of node.steps) {
        if (Date.now() - started > 10000) throw new Error('Extension execution deadline exceeded');
        if (!definition.capabilities.invoke.includes(step.invoke)) throw new Error('Extension capability denied');
        const parameters = await evaluateExpression(step.input, input, results);
        results[step.saveAs] = await context.invoke(step.invoke, parameters);
        if (Buffer.byteLength(JSON.stringify(results)) > 131072) throw new Error('Extension result budget exceeded');
      }
      return evaluateExpression(node.result, input, results);
    },
  })));
}

export async function requireExtensionGraph(nodes: NodeDefinition[]): Promise<void> {
  const graph = new Map<string, string[]>();
  for (const { definition } of await readExtensions()) {
    for (const node of definition.nodes) {
      const targets = node.steps.map((step) => step.invoke);
      for (const targetName of targets) {
        const target = nodes.find((entry) => entry.name === targetName);
        if (!target || (node.kind === 'query' && target.kind === 'command')) throw new Error('Extension references an unavailable or mutating Node from a query');
      }
      graph.set(node.name, targets);
    }
  }
  const visited = new Set<string>();
  function visit(name: string, path: Set<string>) {
    if (path.size >= 8) throw new Error('Declarative extension graph exceeds invocation depth');
    if (path.has(name)) throw new Error('Declarative extension invocation cycle');
    if (visited.has(name)) return;
    const next = new Set(path).add(name);
    for (const target of graph.get(name) ?? []) visit(target, next);
    visited.add(name);
  }
  for (const name of graph.keys()) visit(name, new Set());
}
