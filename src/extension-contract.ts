import semver from 'semver';
import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/);
const ownKey = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/).refine((v) => !['constructor', 'prototype', '__proto__'].includes(v));
const referencePath = z.array(ownKey).max(12);
export type Expression =
  | { op: 'literal'; value: unknown }
  | { op: 'input'; path: string[] }
  | { op: 'result'; name: string; path: string[] }
  | { op: 'object'; fields: Record<string, Expression> }
  | { op: 'array'; items: Expression[] };
export const expressionSchema: z.ZodType<Expression> = z.lazy(() => z.discriminatedUnion('op', [
  z.object({ op: z.literal('literal'), value: z.unknown() }).strict(),
  z.object({ op: z.literal('input'), path: referencePath }).strict(),
  z.object({ op: z.literal('result'), name: ownKey, path: referencePath }).strict(),
  z.object({ op: z.literal('object'), fields: z.record(ownKey, expressionSchema) }).strict(),
  z.object({ op: z.literal('array'), items: z.array(expressionSchema).max(100) }).strict(),
]));
export const fieldSchema = z.object({
  name: ownKey, label: z.string().min(1).max(100),
  type: z.enum(['text', 'textarea', 'integer', 'boolean']), required: z.boolean(),
  maxLength: z.number().int().min(1).max(16000).optional(),
}).strict();
export const extensionSchema = z.object({
  schemaVersion: z.literal(1), execution: z.literal('declarative-v1'),
  name: z.string().regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/),
  version: z.string().refine((v) => !!semver.valid(v)),
  coreCompatibility: z.string().refine((v) => !!semver.validRange(v)),
  description: z.string().max(1000), license: z.string().min(1).max(100),
  capabilities: z.object({ invoke: z.array(identifier).max(32) }).strict(),
  nodes: z.array(z.object({
    name: identifier, kind: z.enum(['command', 'query']),
    action: identifier, resourceType: identifier,
    resource: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('all') }).strict(),
      z.object({ kind: z.literal('input'), field: ownKey }).strict(),
    ]),
    input: z.array(fieldSchema).max(32),
    output: z.array(fieldSchema).max(32),
    steps: z.array(z.object({ saveAs: ownKey, invoke: identifier, input: expressionSchema }).strict()).max(16),
    result: expressionSchema,
  }).strict()).min(1).max(32),
  ui: z.object({ views: z.array(z.object({
    id: identifier, title: z.string().min(1).max(100), description: z.string().max(500),
    node: identifier,
  }).strict()).max(16) }).strict(),
}).strict();
export type Extension = z.infer<typeof extensionSchema>;

export function parseExtension(value: unknown): Extension {
  // Bound JSON before the recursive schema sees it, including literal payloads.
  const visit = (item: unknown, depth = 0): number => {
    if (depth > 24) throw new Error('Extension nesting exceeds limit');
    if (!item || typeof item !== 'object') return 1;
    let size = 1;
    for (const [key, child] of Object.entries(item)) {
      if (['constructor', 'prototype', '__proto__'].includes(key)) throw new Error('Reserved extension key');
      size += visit(child, depth + 1);
      if (size > 4096) throw new Error('Extension complexity exceeds limit');
    }
    return size;
  };
  visit(value);
  const extension = extensionSchema.parse(value);
  const prefix = extension.name.slice(1).replace('/', '.');
  const names = new Set(extension.nodes.map((node) => node.name));
  if (names.size !== extension.nodes.length || extension.nodes.some((node) => !node.name.startsWith(`${prefix}.`))) throw new Error('Extension Nodes must have unique names in their package namespace');
  if (new Set(extension.capabilities.invoke).size !== extension.capabilities.invoke.length) throw new Error('Duplicate capability');
  for (const node of extension.nodes) {
    if (new Set(node.input.map((field) => field.name)).size !== node.input.length || new Set(node.output.map((field) => field.name)).size !== node.output.length || new Set(node.steps.map((step) => step.saveAs)).size !== node.steps.length) throw new Error('Duplicate input, output or step name');
    const resource = node.resource;
    if (resource.kind === 'input' && !node.input.some((field) => field.name === resource.field && field.type === 'text' && field.required)) throw new Error('Resource must reference a required text field');
    if (node.steps.some((step) => !extension.capabilities.invoke.includes(step.invoke))) throw new Error('Invocation capability not declared');
  }
  if (new Set(extension.ui.views.map((view) => view.id)).size !== extension.ui.views.length || extension.ui.views.some((view) => !names.has(view.node))) throw new Error('Invalid UI view target');
  return extension;
}

export function inputSchema(fields: Extension['nodes'][number]['input']): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    let schema: z.ZodType = field.type === 'boolean' ? z.boolean()
      : field.type === 'integer' ? z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
      : z.string().max(field.maxLength ?? 4000);
    if (field.required && (field.type === 'text' || field.type === 'textarea')) schema = (schema as z.ZodString).min(1);
    if (!field.required) schema = schema.optional();
    shape[field.name] = schema;
  }
  return z.object(shape).strict();
}
