import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { jsonValue, type AppClient, type AppDatabase } from './app-db.js';
import type { Principal } from './authorization.js';

const key = z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/);
const slug = z.string().min(1).max(191).regex(/^[a-z0-9][a-z0-9._~-]*$/);
const field = z.object({ name: key, type: z.enum(['text','richtext','number','boolean','date','object','array','reference','media','json']), required: z.boolean().default(false), public: z.boolean().default(false) }).strict();
const contentType = z.object({ key, label: z.string().min(1).max(191), fields: z.array(field).max(200) }).strict();
const contentInput = z.object({ type: key, slug, title: z.string().max(1000).default(''), body: z.string().default(''), excerpt: z.string().default(''), status: z.enum(['draft','published','archived']).default('draft'), publishedAt: z.iso.datetime().optional(), data: z.record(z.string(), z.unknown()).default({}) }).strict();
const link = z.object({ relation: key, targetKind: z.enum(['content','node','shard','media','external']), targetRef: z.string().min(1).max(191), position: z.number().int().min(0).default(0) }).strict();
const term = z.object({ taxonomy: key, slug, label: z.string().min(1).max(191), parentId: z.uuid().nullable().optional() }).strict();
const media = z.object({ storageRef: z.string().min(1).max(2048), mimeType: z.string().min(1).max(191), altText: z.string().default(''), metadata: z.record(z.string(), z.unknown()).default({}) }).strict();
export type ContentInput = z.infer<typeof contentInput>;
type TypeDefinition = z.infer<typeof contentType>;
export type ContentLink = z.infer<typeof link>;
type ContentRow = { id: string; type_key: string; slug: string; title: string; body: string; excerpt: string; status: string; data: unknown; revision: number; published_at: Date | string | null; created_at: Date | string; updated_at: Date | string };

function normalized(row: ContentRow) { return { id: row.id, type: row.type_key, slug: row.slug, title: row.title, body: row.body, excerpt: row.excerpt, status: row.status, data: jsonValue(row.data) as Record<string, unknown>, revision: row.revision, publishedAt: row.published_at, createdAt: row.created_at, updatedAt: row.updated_at }; }
function validateData(input: ContentInput, definition: TypeDefinition): void {
  const fields = new Map(definition.fields.map((item) => [item.name, item]));
  for (const item of definition.fields) if (item.required && (input.data[item.name] === undefined || input.data[item.name] === null)) throw new ContentError(400, `Missing required field: ${item.name}`);
  for (const [name, value] of Object.entries(input.data)) {
    const spec = fields.get(name);
    if (!spec) throw new ContentError(400, `Unknown field: ${name}`);
    if (value === null) continue;
    const valid = spec.type === 'json' || (['text','richtext','reference','media'].includes(spec.type) && typeof value === 'string') || (spec.type === 'date' && typeof value === 'string' && z.iso.datetime().safeParse(value).success) || (spec.type === 'number' && typeof value === 'number' && Number.isFinite(value)) || (spec.type === 'boolean' && typeof value === 'boolean') || (spec.type === 'array' && Array.isArray(value)) || (spec.type === 'object' && typeof value === 'object' && !Array.isArray(value));
    if (!valid) throw new ContentError(400, `Invalid field: ${name}`);
  }
}
export class ContentError extends Error { constructor(public status: number, message: string) { super(message); } }

export class ContentStore {
  constructor(readonly db: AppDatabase, readonly nodeNames: Set<string>, readonly shardNames: Set<string>) {}

  async audit(actor: string, action: string, resource: string, correlationId: string): Promise<void> {
    await this.db.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [actor,action,resource,'allowed',correlationId]);
  }

  async type(keyValue: string, client: AppDatabase | AppClient = this.db): Promise<TypeDefinition | null> {
    const result = await client.query<{ type_key: string; label: string; fields: unknown }>('SELECT type_key,label,fields FROM lattis_content_type WHERE type_key=$1', [keyValue]);
    return result.rows[0] ? contentType.parse({ key: result.rows[0].type_key, label: result.rows[0].label, fields: jsonValue(result.rows[0].fields) }) : null;
  }
  async createType(value: unknown, client: AppDatabase | AppClient = this.db): Promise<TypeDefinition> {
    const input = contentType.parse(value);
    if (new Set(input.fields.map((item) => item.name)).size !== input.fields.length) throw new ContentError(400, 'Duplicate fields');
    const exists = await this.type(input.key, client);
    if (exists) throw new ContentError(409, 'Content type already exists');
    await client.query('INSERT INTO lattis_content_type (type_key,label,fields) VALUES ($1,$2,$3)', [input.key,input.label,JSON.stringify(input.fields)]);
    return input;
  }
  async listTypes(): Promise<TypeDefinition[]> {
    const rows = await this.db.query<{ type_key: string; label: string; fields: unknown }>('SELECT type_key,label,fields FROM lattis_content_type ORDER BY type_key');
    return rows.rows.map((row) => contentType.parse({ key: row.type_key, label: row.label, fields: jsonValue(row.fields) }));
  }
  async get(id: string, client: AppDatabase | AppClient = this.db) {
    const rows = await client.query<ContentRow>('SELECT * FROM lattis_content WHERE id=$1', [id]);
    return rows.rows[0] ? normalized(rows.rows[0]) : null;
  }
  async create(value: unknown, client: AppDatabase | AppClient = this.db, id = randomUUID()) {
    const input = contentInput.parse(value);
    const definition = await this.type(input.type, client);
    if (!definition) throw new ContentError(400, 'Unknown content type');
    validateData(input, definition);
    await client.query('INSERT INTO lattis_content (id,type_key,slug,title,body,excerpt,status,data,published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id,input.type,input.slug,input.title,input.body,input.excerpt,input.status,JSON.stringify(input.data),input.status === 'published' ? input.publishedAt ? new Date(input.publishedAt) : new Date() : null]);
    return this.get(id, client);
  }
  async update(id: string, value: unknown, expectedRevision: number, client: AppDatabase | AppClient = this.db) {
    const input = contentInput.parse(value);
    const current = await this.get(id, client);
    if (!current) throw new ContentError(404, 'Content not found');
    if (current.type !== input.type) throw new ContentError(400, 'Content type cannot change');
    const definition = await this.type(input.type, client);
    if (!definition) throw new ContentError(400, 'Unknown content type');
    validateData(input, definition);
    const changed = await client.query('UPDATE lattis_content SET slug=$1,title=$2,body=$3,excerpt=$4,status=$5,data=$6,published_at=$7,revision=revision+1,updated_at=$8 WHERE id=$9 AND revision=$10', [input.slug,input.title,input.body,input.excerpt,input.status,JSON.stringify(input.data),input.status === 'published' ? input.publishedAt ? new Date(input.publishedAt) : current.publishedAt ?? new Date() : null,new Date(),id,expectedRevision]);
    if (!changed.rowCount) throw new ContentError(409, 'Revision conflict');
    return this.get(id, client);
  }
  async list(type: string | undefined, published: boolean, limit: number, after?: string) {
    const rows = await this.db.query<ContentRow>(`SELECT * FROM lattis_content WHERE ($1 IS NULL OR type_key=$1) AND ($2=0 OR status='published') AND ($3 IS NULL OR id>$3) ORDER BY id LIMIT $4`, [type ?? null,published ? 1 : 0,after ?? null,limit]);
    return rows.rows.map(normalized);
  }
  async publicContent(content: NonNullable<Awaited<ReturnType<ContentStore['get']>>>) {
    const definition = await this.type(content.type);
    const visible = new Set(definition?.fields.filter((item) => item.public).map((item) => item.name) ?? []);
    return { ...content, data: Object.fromEntries(Object.entries(content.data).filter(([name]) => visible.has(name))) };
  }
  async links(id: string, client: AppDatabase | AppClient = this.db) {
    return (await client.query<{ relation: string; target_kind: string; target_ref: string; position: number }>('SELECT relation,target_kind,target_ref,position FROM lattis_content_link WHERE source_id=$1 ORDER BY relation,position,id', [id])).rows.map((row) => ({ relation: row.relation, targetKind: row.target_kind, targetRef: row.target_ref, position: row.position }));
  }
  async terms(id: string, client: AppDatabase | AppClient = this.db) {
    return (await client.query('SELECT t.id,t.taxonomy,t.slug,t.label,t.parent_id FROM lattis_taxonomy_term t JOIN lattis_content_term ct ON ct.term_id=t.id WHERE ct.content_id=$1 ORDER BY t.taxonomy,t.slug', [id])).rows;
  }
  async sources(id: string, client: AppDatabase | AppClient = this.db) {
    return (await client.query('SELECT source_system,source_site,source_kind,external_id,source_digest,imported_at FROM lattis_content_source WHERE content_id=$1 ORDER BY source_system,source_site,source_kind,external_id', [id])).rows;
  }
  async author(id: string, client: AppDatabase | AppClient = this.db) {
    return (await client.query('SELECT u.source_system,u.source_site,u.external_id,u.display_name,u.claimed_user_id FROM lattis_content_author a JOIN lattis_import_user u ON u.id=a.import_user_id WHERE a.content_id=$1', [id])).rows[0] ?? null;
  }
  async publicLinks(id: string) {
    const links = await this.links(id);
    const visible: typeof links = [];
    for (const item of links) {
      if (item.targetKind === 'content') {
        const target = await this.get(item.targetRef);
        if (target?.status === 'published') visible.push(item);
      } else if (item.targetKind === 'media') visible.push(item);
    }
    return visible;
  }
  async setLinks(id: string, value: unknown, client: AppDatabase | AppClient = this.db) {
    const links = z.array(link).max(500).parse(value);
    if (!await this.get(id, client)) throw new ContentError(404, 'Content not found');
    for (const item of links) {
      if (item.targetKind === 'content' && !await this.get(item.targetRef, client)) throw new ContentError(400, 'Content link target not found');
      if (item.targetKind === 'media' && !(await client.query('SELECT id FROM lattis_media WHERE id=$1', [item.targetRef])).rowCount) throw new ContentError(400, 'Media link target not found');
      if (item.targetKind === 'node' && !this.nodeNames.has(item.targetRef)) throw new ContentError(400, 'Node link target not registered');
      if (item.targetKind === 'shard' && !this.shardNames.has(item.targetRef)) throw new ContentError(400, 'Shard link target not registered');
    }
    const own = client === this.db ? await this.db.connect() : null;
    const conn = own ?? client;
    try {
      if (own) await conn.query('BEGIN');
      await conn.query('DELETE FROM lattis_content_link WHERE source_id=$1', [id]);
      for (const item of links) await conn.query('INSERT INTO lattis_content_link (id,source_id,relation,target_kind,target_ref,position) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(),id,item.relation,item.targetKind,item.targetRef,item.position]);
      if (own) await conn.query('COMMIT');
    } catch (error) { if (own) await conn.query('ROLLBACK'); throw error; }
    finally { if (own) await own.release(); }
    return links;
  }
  async createTerm(value: unknown, source?: { system: string; site: string; id: string }, client: AppDatabase | AppClient = this.db) {
    const input = term.parse(value);
    const id = randomUUID();
    await client.query('INSERT INTO lattis_taxonomy_term (id,taxonomy,slug,label,parent_id,source_system,source_site,external_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id,input.taxonomy,input.slug,input.label,input.parentId ?? null,source?.system ?? null,source?.site ?? null,source?.id ?? null]);
    return { id, ...input };
  }
  async createMedia(value: unknown, source?: { system: string; site: string; id: string }, client: AppDatabase | AppClient = this.db) {
    const input = media.parse(value);
    const id = randomUUID();
    await client.query('INSERT INTO lattis_media (id,storage_ref,mime_type,alt_text,metadata,source_system,source_site,external_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id,input.storageRef,input.mimeType,input.altText,JSON.stringify(input.metadata),source?.system ?? null,source?.site ?? null,source?.id ?? null]);
    return { id, ...input };
  }
  async setTerms(id: string, termIds: string[], client: AppDatabase | AppClient = this.db) {
    if (!await this.get(id, client)) throw new ContentError(404, 'Content not found');
    for (const termId of termIds) if (!(await client.query('SELECT id FROM lattis_taxonomy_term WHERE id=$1', [termId])).rowCount) throw new ContentError(400, 'Term not found');
    const own = client === this.db ? await this.db.connect() : null;
    const conn = own ?? client;
    try {
      if (own) await conn.query('BEGIN');
      await conn.query('DELETE FROM lattis_content_term WHERE content_id=$1', [id]);
      for (const termId of new Set(termIds)) await conn.query('INSERT INTO lattis_content_term (content_id,term_id) VALUES ($1,$2)', [id,termId]);
      if (own) await conn.query('COMMIT');
    } catch (error) { if (own) await conn.query('ROLLBACK'); throw error; }
    finally { if (own) await own.release(); }
  }
}

type Permission = (request: FastifyRequest, reply: FastifyReply, action: string, resourceType: string, resourceId?: string) => Promise<Principal | null>;
export function registerContentRoutes(app: FastifyInstance, store: ContentStore, permission: Permission, sameOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ContentError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid input', issues: error.issues });
    if ((error as { code?: string }).code === '23505' || (error as { code?: string }).code === 'ER_DUP_ENTRY') return reply.code(409).send({ error: 'Unique constraint conflict' });
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal error' });
  });
  app.get('/api/content-types', async (request, reply) => {
    const who = await permission(request,reply,'content.type.read','content'); if (!who) return;
    return store.listTypes();
  });
  app.post('/api/content-types', async (request, reply) => {
    if (!sameOrigin(request,reply)) return;
    const who = await permission(request,reply,'content.type.manage','content'); if (!who) return;
    const result = await store.createType(request.body);
    await store.audit(who.id,'content.type.create',result.key,request.id);
    return reply.code(201).send(result);
  });
  app.get('/api/content', async (request, reply) => {
    const query = z.object({ type: key.optional(), limit: z.coerce.number().int().min(1).max(100).default(20), after: z.uuid().optional() }).parse(request.query);
    const rows = await store.list(query.type,true,query.limit,query.after);
    return Promise.all(rows.map((row) => store.publicContent(row)));
  });
  app.get('/api/content/:id', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const item = await store.get(id);
    if (!item || item.status !== 'published') return reply.code(404).send({ error: 'Content not found' });
    return { ...await store.publicContent(item), links: await store.publicLinks(id), terms: await store.terms(id) };
  });
  app.get('/api/manage/content', async (request, reply) => {
    if (!await permission(request,reply,'content.read','content')) return;
    const query = z.object({ type: key.optional(), limit: z.coerce.number().int().min(1).max(100).default(20), after: z.uuid().optional() }).parse(request.query);
    return store.list(query.type,false,query.limit,query.after);
  });
  app.get('/api/manage/content/:id', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    if (!await permission(request,reply,'content.read','content',id)) return;
    const item = await store.get(id);
    return item ? { ...item, links: await store.links(id), terms: await store.terms(id), sources: await store.sources(id), author: await store.author(id) } : reply.code(404).send({ error: 'Content not found' });
  });
  app.post('/api/manage/content', async (request, reply) => {
    if (!sameOrigin(request,reply)) return;
    const who = await permission(request,reply,'content.write','content'); if (!who) return;
    const result = await store.create(request.body);
    await store.audit(who.id,'content.create',result!.id,request.id);
    return reply.code(201).send(result);
  });
  app.put('/api/manage/content/:id', async (request, reply) => {
    if (!sameOrigin(request,reply)) return;
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const who = await permission(request,reply,'content.write','content',id); if (!who) return;
    const body = z.object({ expectedRevision: z.number().int().positive(), content: contentInput }).strict().parse(request.body);
    const result = await store.update(id,body.content,body.expectedRevision);
    await store.audit(who.id,'content.update',id,request.id);
    return result;
  });
  app.put('/api/manage/content/:id/links', async (request, reply) => {
    if (!sameOrigin(request,reply)) return;
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const who = await permission(request,reply,'content.write','content',id); if (!who) return;
    const result = await store.setLinks(id,request.body);
    await store.audit(who.id,'content.links.replace',id,request.id);
    return result;
  });
  app.post('/api/taxonomy-terms', async (request, reply) => {
    if (!sameOrigin(request,reply)) return;
    const who = await permission(request,reply,'content.taxonomy.manage','content'); if (!who) return;
    const result = await store.createTerm(request.body);
    await store.audit(who.id,'content.term.create',result.id,request.id);
    return reply.code(201).send(result);
  });
  app.get('/api/taxonomy-terms', async (request, reply) => {
    if (!await permission(request,reply,'content.taxonomy.read','content')) return;
    const query = z.object({ taxonomy: key.optional() }).parse(request.query);
    return (await store.db.query('SELECT id,taxonomy,slug,label,parent_id FROM lattis_taxonomy_term WHERE ($1 IS NULL OR taxonomy=$1) ORDER BY taxonomy,slug', [query.taxonomy ?? null])).rows;
  });
  app.put('/api/manage/content/:id/terms', async (request, reply) => {
    if (!sameOrigin(request,reply)) return;
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const who = await permission(request,reply,'content.write','content',id); if (!who) return;
    const ids = z.array(z.uuid()).max(500).parse(request.body);
    await store.setTerms(id,ids);
    await store.audit(who.id,'content.terms.replace',id,request.id);
    return { termIds: ids };
  });
  app.post('/api/media', async (request, reply) => {
    if (!sameOrigin(request,reply)) return;
    const who = await permission(request,reply,'content.media.manage','content'); if (!who) return;
    const result = await store.createMedia(request.body);
    await store.audit(who.id,'content.media.create',result.id,request.id);
    return reply.code(201).send(result);
  });
  app.get('/api/media/:id', async (request, reply) => {
    if (!await permission(request,reply,'content.media.read','content')) return;
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const row = (await store.db.query('SELECT id,storage_ref,mime_type,alt_text,metadata FROM lattis_media WHERE id=$1', [id])).rows[0];
    return row ? { ...row, metadata: jsonValue(row.metadata) } : reply.code(404).send({ error: 'Media not found' });
  });
}

export const contentSchemas = { contentType, contentInput, link, term, media, key };
