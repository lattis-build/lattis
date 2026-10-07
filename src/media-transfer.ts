import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ContentError, ContentStore } from './content.js';
import type { Principal } from './authorization.js';
import { jsonValue } from './app-db.js';
import { migrationSourceSchema, migrationIdSchema } from './migration-contract.js';
import { migrationLock } from './migration-store.js';

const maxBytes = 12 * 1024 * 1024;
const upload = z.object({
  source: migrationSourceSchema,
  id: migrationIdSchema,
  mimeType: z.enum(['image/jpeg','image/png','image/gif','image/webp','application/pdf']),
  altText: z.string().max(1000).default(''),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytesBase64: z.string().min(4).max(Math.ceil(maxBytes * 4 / 3) + 8).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  metadata: z.object({ sourceFile: z.string().max(255).optional(),sourceUrls: z.array(z.url().max(2048)).max(30).default([]) }).strict().default({ sourceUrls: [] }),
}).strict();
type Permission = (request: FastifyRequest, reply: FastifyReply, action: string, resourceType: string, resourceId?: string) => Promise<Principal | null>;

function detectedMime(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (bytes.subarray(0,6).toString('ascii') === 'GIF87a' || bytes.subarray(0,6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.subarray(8,12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.subarray(0,5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}

async function storageDirectory(): Promise<string> {
  const configured = process.env.LATTIS_MEDIA_DIR;
  if (process.env.NODE_ENV === 'production' && !configured) throw new Error('LATTIS_MEDIA_DIR is required in production');
  const directory = resolve(configured ?? '.lattis/media');
  await mkdir(directory,{ recursive: true,mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || await realpath(directory) !== directory) throw new Error('Media directory must be private and contain no symlinked path');
  return directory;
}

export function registerMediaTransfer(app: FastifyInstance, store: ContentStore, permission: Permission, sameOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean): void {
  app.get('/api/migrations/media/map', async (request,reply) => {
    if (!await permission(request,reply,'content.import','content')) return;
    const query = z.object({ system:migrationSourceSchema.shape.system,instance:migrationSourceSchema.shape.instance, after:z.uuid().optional() }).strict().parse(request.query);
    const rows = await store.db.query<{ id: string; external_id:string; metadata: unknown }>('SELECT id,external_id,metadata FROM lattis_media WHERE source_system=$1 AND source_site=$2 AND content_sha256 IS NOT NULL AND ($3 IS NULL OR id>$3) ORDER BY id LIMIT 100', [query.system,query.instance,query.after ?? null]);
    return { items: rows.rows.map((row) => {
      const metadata = jsonValue(row.metadata) as { sourceUrls?: unknown };
      return { id: row.id,externalId:row.external_id,sourceUrls: Array.isArray(metadata?.sourceUrls) ? metadata.sourceUrls.filter((url): url is string => typeof url === 'string') : [] };
    }), next: rows.rows.length === 100 ? rows.rows[99].id : null };
  });
  app.post('/api/migrations/media',{ bodyLimit: 18 * 1024 * 1024 }, async (request,reply) => {
    if (!sameOrigin(request,reply)) return;
    const who = await permission(request,reply,'content.import','content'); if (!who) return;
    const input = upload.parse(request.body);
    const bytes = Buffer.from(input.bytesBase64,'base64');
    if (!bytes.length || bytes.length > maxBytes || detectedMime(bytes) !== input.mimeType) throw new ContentError(400,'Invalid media bytes or MIME type');
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== input.sha256) throw new ContentError(400,'Media checksum mismatch');
    const directory = await storageDirectory();
    const client = await store.db.connect();
    const lock = migrationLock(input.source);
    let path: string | undefined;
    let transaction = false;
    try {
      await client.lock(lock);
      const existing = await client.query<{ id: string; content_sha256: string | null; storage_ref: string }>('SELECT id,content_sha256,storage_ref FROM lattis_media WHERE source_system=$1 AND source_site=$2 AND external_id=$3', [input.source.system,input.source.instance,input.id]);
      if (existing.rows[0]) {
        if (existing.rows[0].content_sha256) {
          if (existing.rows[0].content_sha256 !== hash) throw new ContentError(409,'Media source already exists with different bytes');
          return { id: existing.rows[0].id,sha256: hash,skipped: true };
        }
        if (existing.rows[0].storage_ref.startsWith('local:')) throw new ContentError(409,'Media source is already stored locally');
      }
      const id = existing.rows[0]?.id ?? randomUUID();
      path = join(directory,id);
      const file = await open(path,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
      try { await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
      await client.query('BEGIN');
      transaction = true;
      if (existing.rows[0]) await client.query('UPDATE lattis_media SET storage_ref=$1,mime_type=$2,alt_text=$3,metadata=$4,content_sha256=$5,byte_count=$6 WHERE id=$7', [`local:${id}`,input.mimeType,input.altText,JSON.stringify(input.metadata),hash,bytes.length,id]);
      else await client.query('INSERT INTO lattis_media (id,storage_ref,mime_type,alt_text,metadata,content_sha256,byte_count,source_system,source_site,external_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id,`local:${id}`,input.mimeType,input.altText,JSON.stringify(input.metadata),hash,bytes.length,input.source.system,input.source.instance,input.id]);
      await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [who.id,'content.media.import',id,'allowed',request.id]);
      await client.query('COMMIT');
      transaction = false;
      path = undefined;
      return reply.code(201).send({ id,sha256: hash,skipped: false });
    } catch (error) { if (transaction) await client.query('ROLLBACK').catch(() => {}); if (path) await unlink(path).catch(() => {}); throw error; }
    finally { await client.unlock(lock).finally(() => client.release()); }
  });
  app.get('/api/media/:id/file', async (request,reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const publicLink = await store.db.query('SELECT 1 FROM lattis_content_link l JOIN lattis_content c ON c.id=l.source_id WHERE l.target_kind=$1 AND l.target_ref=$2 AND c.status=$3 LIMIT 1', ['media',id,'published']);
    if (!publicLink.rowCount && !await permission(request,reply,'content.media.read','content',id)) return;
    const row = (await store.db.query<{ storage_ref: string; mime_type: string; byte_count: number | null; content_sha256: string | null }>('SELECT storage_ref,mime_type,byte_count,content_sha256 FROM lattis_media WHERE id=$1', [id])).rows[0];
    if (!row || !/^local:[0-9a-f-]{36}$/.test(row.storage_ref)) return reply.code(404).send({ error: 'Media file not found' });
    const directory = await storageDirectory();
    let file: FileHandle;
    try { file = await open(join(directory,row.storage_ref.slice(6)),constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'Media file not found' }); throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxBytes || (row.byte_count !== null && info.size !== Number(row.byte_count))) throw new ContentError(500,'Media storage mismatch');
      const bytes = await file.readFile();
      if (!row.content_sha256 || createHash('sha256').update(bytes).digest('hex') !== row.content_sha256 || detectedMime(bytes) !== row.mime_type) throw new ContentError(500,'Media storage mismatch');
      reply.header('x-content-type-options','nosniff');
      reply.header('cache-control','no-store');
      reply.header('content-security-policy',"default-src 'none'; sandbox");
      reply.header('content-disposition',row.mime_type.startsWith('image/') ? 'inline' : 'attachment');
      return reply.type(row.mime_type).send(bytes);
    } finally { await file.close(); }
  });
}
