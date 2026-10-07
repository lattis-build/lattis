import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ContentError, ContentStore, type ContentInput, type ContentLink } from './content.js';
import type { Principal } from './authorization.js';
import { canonicalJson } from './manifest.js';

const sourceId = z.union([z.string().min(1).max(191), z.number().int().nonnegative()]).transform(String);
const optionalMediaId = z.union([z.literal(0).transform(() => null),sourceId]).nullable().optional();
const rendered = z.union([z.string(), z.object({ rendered: z.string() })]).transform((value) => typeof value === 'string' ? value : value.rendered);
const item = z.object({
  id: sourceId,
  type: z.string().min(1).max(80),
  slug: z.string().min(1),
  title: rendered.default(''),
  content: rendered.default(''),
  excerpt: rendered.default(''),
  status: z.string().min(1),
  authorId: sourceId.optional(),
  author: sourceId.optional(),
  dateGmt: z.iso.datetime().nullable().optional(),
  date_gmt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z)?$/).transform((value) => value.endsWith('Z') ? value : `${value}Z`).nullable().optional(),
  acf: z.record(z.string(), z.unknown()).default({}),
  terms: z.record(z.string(), z.array(sourceId)).default({}),
  featuredMedia: optionalMediaId,
  featured_media: optionalMediaId,
  embeddedMedia: z.array(z.uuid()).max(100).default([]),
  relations: z.array(z.object({ relation: z.string().min(1), targetType: z.string().min(1), targetId: sourceId })).default([]),
}).strict();
const batch = z.object({
  site: z.string().url().max(191),
  importKey: z.string().min(1).max(191),
  expectedCursor: z.string().max(191).nullable(),
  nextCursor: z.string().max(191).nullable(),
  types: z.array(z.object({ type: z.string().min(1).max(80), label: z.string().min(1).max(191), publicFields: z.array(z.string()).default([]) })).max(100).default([]),
  terms: z.array(z.object({ id: sourceId, taxonomy: z.string(), slug: z.string(), label: z.string() })).max(500).default([]),
  media: z.array(z.object({ id: sourceId, storageRef: z.string().min(1), mimeType: z.string().min(1), altText: z.string().default(''), metadata: z.record(z.string(), z.unknown()).default({}) })).max(500).default([]),
  items: z.array(item).min(1).max(100),
}).strict();

function normalizedKey(value: string): string {
  const key = value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9_.-]+/g,'-').replace(/^[^a-z]+/,'x-').slice(0,80);
  return key || 'x';
}
function normalizedSlug(value: string, id: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9._~-]+/g,'-').replace(/^[^a-z0-9]+|-+$/g,'').slice(0,180) || `post-${id}`;
}
function sourceDigest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function status(value: string): ContentInput['status'] { return value === 'publish' ? 'published' : value === 'trash' ? 'archived' : 'draft'; }
type ParsedBatch = z.infer<typeof batch>;

async function ensureTypes(store: ContentStore, payload: ParsedBatch): Promise<void> {
  const specs = new Map(payload.types.map((type) => [type.type, type]));
  const typeKeys = payload.items.map((entry) => [entry.type,normalizedKey(entry.type)] as const);
  if (new Set(typeKeys.map(([,normalized]) => normalized)).size !== new Set(typeKeys.map(([original]) => original)).size) throw new ContentError(400,'WordPress post types collide after normalization');
  for (const typeName of new Set(payload.items.map((entry) => entry.type))) {
    const typeKey = normalizedKey(typeName);
    const entries = payload.items.filter((entry) => entry.type === typeName);
    const sourceNames = new Map<string,string>();
    for (const entry of entries) for (const name of Object.keys(entry.acf)) {
      const normalized = `acf.${normalizedKey(name).slice(0,76)}`;
      const previous = sourceNames.get(normalized);
      if (previous && previous !== name) throw new ContentError(400,'ACF field names collide after normalization');
      sourceNames.set(normalized,name);
    }
    const spec = specs.get(typeName);
    const names = new Set(entries.flatMap((entry) => Object.keys(entry.acf).map((name) => `acf.${normalizedKey(name).slice(0,76)}`)));
    const current = await store.type(typeKey);
    const fields = current?.fields ?? [];
    const missing = [...names].filter((name) => !fields.some((field) => field.name === name));
    if (!current) {
      await store.createType({ key: typeKey, label: spec?.label ?? typeName, fields: [...names].map((name) => ({ name, type: 'json', required: false, public: spec?.publicFields.includes(name.slice(4)) ?? false })) });
    } else if (missing.length) {
      const expanded = [...fields, ...missing.map((name) => ({ name, type: 'json' as const, required: false, public: spec?.publicFields.includes(name.slice(4)) ?? false }))];
      await store.db.query('UPDATE lattis_content_type SET fields=$1,updated_at=$2 WHERE type_key=$3', [JSON.stringify(expanded),new Date(),typeKey]);
    }
  }
}

async function ensureReferences(store: ContentStore, payload: ParsedBatch): Promise<void> {
  for (const term of payload.terms) {
    const taxonomy = normalizedKey(term.taxonomy);
    const existing = await store.db.query<{ id: string }>('SELECT id FROM lattis_taxonomy_term WHERE source_system=$1 AND source_site=$2 AND taxonomy=$3 AND external_id=$4', ['wordpress',payload.site,taxonomy,term.id]);
    if (existing.rows[0]) {
      await store.db.query('UPDATE lattis_taxonomy_term SET slug=$1,label=$2 WHERE id=$3', [normalizedSlug(term.slug,term.id),term.label,existing.rows[0].id]);
    } else {
      await store.createTerm({ taxonomy,slug: normalizedSlug(term.slug,term.id),label: term.label }, { system: 'wordpress',site: payload.site,id: term.id });
    }
  }
  for (const medium of payload.media) {
    const existing = await store.db.query<{ id: string; storage_ref: string }>('SELECT id,storage_ref FROM lattis_media WHERE source_system=$1 AND source_site=$2 AND external_id=$3', ['wordpress',payload.site,medium.id]);
    if (existing.rows[0]) {
      if (!existing.rows[0].storage_ref.startsWith('local:')) await store.db.query('UPDATE lattis_media SET storage_ref=$1,mime_type=$2,alt_text=$3,metadata=$4 WHERE id=$5', [medium.storageRef,medium.mimeType,medium.altText,JSON.stringify(medium.metadata),existing.rows[0].id]);
    } else {
      await store.createMedia({ storageRef: medium.storageRef,mimeType: medium.mimeType,altText: medium.altText,metadata: medium.metadata }, { system: 'wordpress',site: payload.site,id: medium.id });
    }
  }
}

async function importItem(store: ContentStore, site: string, entry: ParsedBatch['items'][number]): Promise<'created' | 'updated' | 'skipped'> {
  const typeKey = normalizedKey(entry.type);
  const digest = sourceDigest(entry);
  const client = await store.db.connect();
  const lock = `wordpress:${site}:${entry.type}:${entry.id}`;
  try {
    await client.lock(lock);
    await client.query('BEGIN');
    const prior = await client.query<{ content_id: string; source_digest: string }>('SELECT content_id,source_digest FROM lattis_content_source WHERE source_system=$1 AND source_site=$2 AND source_kind=$3 AND external_id=$4', ['wordpress',site,entry.type,entry.id]);
    if (prior.rows[0]?.source_digest === digest) { await client.query('COMMIT'); return 'skipped'; }
    const acf = Object.fromEntries(Object.entries(entry.acf).map(([name,value]) => [`acf.${normalizedKey(name).slice(0,76)}`,value]));
    if (new Set(Object.keys(acf)).size !== Object.keys(entry.acf).length) throw new ContentError(400,'ACF field names collide after normalization');
    const publishedAt = entry.dateGmt ?? entry.date_gmt;
    let contentSlug = normalizedSlug(entry.slug,entry.id);
    const collision = await client.query<{ id: string }>('SELECT id FROM lattis_content WHERE type_key=$1 AND slug=$2', [typeKey,contentSlug]);
    if (collision.rows[0] && collision.rows[0].id !== prior.rows[0]?.content_id) contentSlug = `${contentSlug.slice(0,160)}-${normalizedSlug(entry.id,entry.id).slice(0,20)}`;
    const content: ContentInput = { type: typeKey,slug: contentSlug,title: entry.title,body: entry.content,excerpt: entry.excerpt,status: status(entry.status),...(publishedAt ? { publishedAt } : {}),data: acf };
    let outcome: 'created' | 'updated';
    if (prior.rows[0]) {
      const current = await store.get(prior.rows[0].content_id,client);
      if (!current) throw new ContentError(409,'Source map points to missing content');
      await store.update(current.id,content,current.revision,client);
      await client.query('UPDATE lattis_content_source SET source_digest=$1,imported_at=$2 WHERE source_system=$3 AND source_site=$4 AND source_kind=$5 AND external_id=$6', [digest,new Date(),'wordpress',site,entry.type,entry.id]);
      outcome = 'updated';
    } else {
      const id = randomUUID();
      await store.create(content,client,id);
      await client.query('INSERT INTO lattis_content_source (source_system,source_site,source_kind,external_id,content_id,source_digest) VALUES ($1,$2,$3,$4,$5,$6)', ['wordpress',site,entry.type,entry.id,id,digest]);
      outcome = 'created';
    }
    await client.query('COMMIT');
    return outcome;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { await client.unlock(lock).finally(() => client.release()); }
}

async function resolveAssociations(store: ContentStore, site: string, entry: ParsedBatch['items'][number]): Promise<void> {
  const source = await store.db.query<{ content_id: string }>('SELECT content_id FROM lattis_content_source WHERE source_system=$1 AND source_site=$2 AND source_kind=$3 AND external_id=$4', ['wordpress',site,entry.type,entry.id]);
  const contentId = source.rows[0]?.content_id;
  if (!contentId) throw new ContentError(409,'Content source missing');
  const termIds: string[] = [];
  for (const [taxonomyName, ids] of Object.entries(entry.terms)) for (const id of ids) {
    const result = await store.db.query<{ id: string }>('SELECT id FROM lattis_taxonomy_term WHERE source_system=$1 AND source_site=$2 AND taxonomy=$3 AND external_id=$4', ['wordpress',site,normalizedKey(taxonomyName),id]);
    if (!result.rows[0]) throw new ContentError(409,`Import taxonomy term first: ${taxonomyName}/${id}`);
    termIds.push(result.rows[0].id);
  }
  const links: ContentLink[] = [];
  const featuredMedia = entry.featuredMedia ?? entry.featured_media;
  if (featuredMedia) {
    const result = await store.db.query<{ id: string }>('SELECT id FROM lattis_media WHERE source_system=$1 AND source_site=$2 AND external_id=$3', ['wordpress',site,featuredMedia]);
    if (!result.rows[0]) throw new ContentError(409,`Import media first: ${featuredMedia}`);
    links.push({ relation: 'featured-media',targetKind: 'media',targetRef: result.rows[0].id,position: 0 });
  }
  for (const mediaId of new Set(entry.embeddedMedia)) {
    const result = await store.db.query<{ id: string }>('SELECT id FROM lattis_media WHERE id=$1 AND source_system=$2 AND source_site=$3 AND content_sha256 IS NOT NULL', [mediaId,'wordpress',site]);
    if (!result.rows[0]) throw new ContentError(409,`Import embedded media first: ${mediaId}`);
    links.push({ relation: 'embedded-media',targetKind: 'media',targetRef: mediaId,position: links.length });
  }
  for (const relation of entry.relations) {
    const result = await store.db.query<{ content_id: string }>('SELECT content_id FROM lattis_content_source WHERE source_system=$1 AND source_site=$2 AND source_kind=$3 AND external_id=$4', ['wordpress',site,relation.targetType,relation.targetId]);
    if (!result.rows[0]) throw new ContentError(409,`Import related content first: ${relation.targetType}/${relation.targetId}`);
    links.push({ relation: normalizedKey(relation.relation),targetKind: 'content',targetRef: result.rows[0].content_id,position: links.length });
  }
  const client = await store.db.connect();
  try {
    await client.query('BEGIN');
    await store.setTerms(contentId,termIds,client);
    await store.setLinks(contentId,links,client);
    const authorId = entry.authorId ?? entry.author;
    await client.query('DELETE FROM lattis_content_author WHERE content_id=$1', [contentId]);
    if (authorId) {
      const author = await client.query<{ id: string }>('SELECT id FROM lattis_import_user WHERE source_site=$1 AND external_id=$2', [site,authorId]);
      if (!author.rows[0]) throw new ContentError(409,`Import author first: ${authorId}`);
      await client.query('INSERT INTO lattis_content_author (content_id,import_user_id) VALUES ($1,$2)', [contentId,author.rows[0].id]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { await client.release(); }
}

type Permission = (request: FastifyRequest, reply: FastifyReply, action: string, resourceType: string, resourceId?: string) => Promise<Principal | null>;
export function registerWordPressImport(app: FastifyInstance, store: ContentStore, permission: Permission, sameOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean): void {
  app.get('/api/imports/wordpress/cursor', async (request, reply) => {
    if (!await permission(request,reply,'content.import','content')) return;
    const query = z.object({ site: z.string().url(), importKey: z.string().min(1) }).parse(request.query);
    const row = (await store.db.query<{ cursor_value: string | null }>('SELECT cursor_value FROM lattis_import_cursor WHERE source_system=$1 AND source_site=$2 AND import_key=$3', ['wordpress',query.site,query.importKey])).rows[0];
    return { cursor: row?.cursor_value ?? null };
  });
  app.post('/api/imports/wordpress/batches', { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    if (!sameOrigin(request,reply)) return;
    const who = await permission(request,reply,'content.import','content'); if (!who) return;
    const input = batch.parse(request.body);
    const lockClient = await store.db.connect();
    const lock = `wordpress-batch:${input.site}`;
    try {
      await lockClient.lock(lock);
      const before = await store.db.query<{ cursor_value: string | null; batch_digest: string }>('SELECT cursor_value,batch_digest FROM lattis_import_cursor WHERE source_system=$1 AND source_site=$2 AND import_key=$3', ['wordpress',input.site,input.importKey]);
      const currentCursor = before.rows[0]?.cursor_value ?? null;
      const batchDigest = sourceDigest(input);
      if (currentCursor === input.nextCursor && before.rowCount) {
        if (before.rows[0].batch_digest !== batchDigest) throw new ContentError(409,'A different batch already advanced this cursor');
        return { created: 0,updated: 0,skipped: input.items.length,cursor: currentCursor };
      }
      if (currentCursor !== input.expectedCursor) throw new ContentError(409,'Import cursor changed; reload it before sending this batch');
      await ensureTypes(store,input);
      await ensureReferences(store,input);
      const results = { created: 0, updated: 0, skipped: 0 };
      for (const entry of input.items) results[await importItem(store,input.site,entry)]++;
      for (const entry of input.items) await resolveAssociations(store,input.site,entry);
      if (before.rowCount) await store.db.query('UPDATE lattis_import_cursor SET cursor_value=$1,batch_digest=$2,updated_at=$3 WHERE source_system=$4 AND source_site=$5 AND import_key=$6', [input.nextCursor,batchDigest,new Date(),'wordpress',input.site,input.importKey]);
      else await store.db.query('INSERT INTO lattis_import_cursor (source_system,source_site,import_key,cursor_value,batch_digest) VALUES ($1,$2,$3,$4,$5)', ['wordpress',input.site,input.importKey,input.nextCursor,batchDigest]);
      await store.audit(who.id,'content.import.wordpress',`${input.site}:${input.importKey}`,request.id);
      return { ...results, cursor: input.nextCursor };
    } finally { await lockClient.unlock(lock).finally(() => lockClient.release()); }
  });
}
