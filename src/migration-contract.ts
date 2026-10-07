import { z } from 'zod';
import { contentSchemas } from './content.js';

export const migrationSourceSchema = z.object({
  system: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  instance: z.string().min(1).max(191).regex(/^[^\u0000-\u001f\u007f]+$/),
}).strict();
export const migrationIdSchema = z.union([
  z.string().min(1).max(191).regex(/^[^\u0000-\u001f\u007f]+$/),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
]).transform(String);
export const migrationCursorSchema = z.object({
  source: migrationSourceSchema,
  importKey: z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/),
  expectedCursor: z.string().max(191).nullable(),
  nextCursor: z.string().min(1).max(191),
}).strict();
export const migrationCursorQuerySchema = z.object({
  system: migrationSourceSchema.shape.system,
  instance: migrationSourceSchema.shape.instance,
  importKey: migrationCursorSchema.shape.importKey,
}).strict();
const target = z.discriminatedUnion('kind',[
  z.object({ kind: z.literal('content'), type: contentSchemas.key, id: migrationIdSchema }).strict(),
  z.object({ kind: z.literal('media'), id: migrationIdSchema }).strict(),
]);
export const migrationContentBatchSchema = migrationCursorSchema.extend({
  schemaVersion: z.literal(1),
  types: z.array(contentSchemas.contentType).max(100).default([]),
  terms: z.array(contentSchemas.term.omit({parentId:true}).extend({id:migrationIdSchema,parentId:migrationIdSchema.nullable().optional()})).max(500).default([]),
  media: z.array(contentSchemas.media.extend({
    id:migrationIdSchema,
    storageRef:z.url().max(2048).refine(value=>{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;},'Use an HTTP media reference or the separate file upload API'),
  })).max(500).default([]),
  items: z.array(contentSchemas.contentInput.extend({
    id: migrationIdSchema,
    authorId: migrationIdSchema.nullable().optional(),
    terms: z.array(z.object({taxonomy:contentSchemas.key,id:migrationIdSchema}).strict()).max(500).optional(),
    links: z.array(z.object({relation:contentSchemas.key,target,position:z.number().int().nonnegative().default(0)}).strict()).max(500).optional(),
  })).max(100),
}).strict().refine(value=>value.items.length+value.types.length+value.terms.length+value.media.length>0,'An empty batch cannot advance the cursor');
export const importedCredentialSchema = z.object({
  algorithm: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  hash: z.string().min(1).max(8192),
  parameters: z.record(z.string().max(80),z.union([z.string().max(2048),z.number().finite(),z.boolean()])).refine(value=>Object.keys(value).length<=32,'At most 32 credential parameters').default({}),
}).strict().refine(value=>Buffer.byteLength(JSON.stringify(value))<=16384,'Credential envelope is too large');
export const migrationUserBatchSchema = migrationCursorSchema.extend({
  schemaVersion:z.literal(1),
  authMode:z.enum(['verified-email','password']).default('verified-email'),
  users:z.array(z.object({
    id:migrationIdSchema,email:z.email().max(191).transform(value=>value.toLowerCase()),
    displayName:z.string().min(1).max(191),roles:z.array(z.string().min(1).max(80)).max(20).default([]),
    credential:importedCredentialSchema.optional(),
  }).strict()).min(1).max(100),
}).strict();
export type MigrationSource = z.infer<typeof migrationSourceSchema>;
export type MigrationContentBatch = z.infer<typeof migrationContentBatchSchema>;
export type ImportedCredential = z.infer<typeof importedCredentialSchema>;
