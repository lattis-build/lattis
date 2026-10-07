import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { canonicalJson } from './manifest.js';
import { ContentError, ContentStore } from './content.js';
import type { Principal } from './authorization.js';
import { encryptWordPressHash, passwordMigrationConfigured, supportedWordPressHash } from './wordpress-password.js';

const sourceId = z.union([z.string().min(1).max(191),z.number().int().nonnegative()]).transform(String);
const user = z.object({
  id: sourceId,
  email: z.email().max(191).transform((value) => value.toLowerCase()),
  displayName: z.string().min(1).max(191),
  roles: z.array(z.string().min(1).max(80)).max(20).default([]),
  passwordHash: z.string().max(128).optional(),
}).strict();
const batch = z.object({
  site: z.url().max(191),
  importKey: z.string().min(1).max(191),
  expectedCursor: z.string().max(191).nullable(),
  nextCursor: z.string().max(191).nullable(),
  authMode: z.enum(['verified-email','password']).optional(),
  users: z.array(user).min(1).max(100),
}).strict();
type Permission = (request: FastifyRequest, reply: FastifyReply, action: string, resourceType: string, resourceId?: string) => Promise<Principal | null>;
type Identity = (request: FastifyRequest) => Promise<Principal | null>;

export function registerUserImport(app: FastifyInstance, store: ContentStore, permission: Permission, identity: Identity, sameOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean): void {
  app.get('/api/imports/wordpress/users/cursor', async (request,reply) => {
    if (!await permission(request,reply,'user.import','user')) return;
    const query = z.object({ site: z.url(),importKey: z.string().min(1) }).parse(request.query);
    const row = (await store.db.query<{ cursor_value: string | null }>('SELECT cursor_value FROM lattis_import_cursor WHERE source_system=$1 AND source_site=$2 AND import_key=$3', ['wordpress-users',query.site,query.importKey])).rows[0];
    return { cursor: row?.cursor_value ?? null };
  });
  app.post('/api/imports/wordpress/users/batches', async (request,reply) => {
    if (!sameOrigin(request,reply)) return;
    const who = await permission(request,reply,'user.import','user'); if (!who) return;
    const input = batch.parse(request.body);
    const passwordMode = input.authMode === 'password';
    if (input.users.some((entry) => entry.passwordHash !== undefined && (!passwordMode || !supportedWordPressHash(entry.passwordHash)))) throw new ContentError(400,'Unsupported password hash or invalid user import mode');
    if (passwordMode && input.users.some((entry) => entry.passwordHash !== undefined)) {
      try { passwordMigrationConfigured(); }
      catch { throw new ContentError(503,'WordPress password migration is not configured in Core'); }
    }
    const client = await store.db.connect();
    const lock = `wordpress-users:${input.site}`;
    try {
      await client.lock(lock);
      await client.query('BEGIN');
      const previous = await client.query<{ cursor_value: string | null; batch_digest: string }>('SELECT cursor_value,batch_digest FROM lattis_import_cursor WHERE source_system=$1 AND source_site=$2 AND import_key=$3', ['wordpress-users',input.site,input.importKey]);
      const cursor = previous.rows[0]?.cursor_value ?? null;
      const digest = createHash('sha256').update(canonicalJson(input)).digest('hex');
      if (previous.rowCount && cursor === input.nextCursor) {
        if (previous.rows[0].batch_digest !== digest) throw new ContentError(409,'A different user batch already advanced this cursor');
        await client.query('COMMIT');
        return { imported: 0,skipped: input.users.length,cursor };
      }
      if (cursor !== input.expectedCursor) throw new ContentError(409,'User import cursor changed; reload it before sending this batch');
      for (const entry of input.users) {
        const encrypted = passwordMode && entry.passwordHash ? encryptWordPressHash(input.site,entry.id,entry.email,entry.passwordHash) : null;
        const entryMode = encrypted ? 'password' : 'verified-email';
        const existing = await client.query<{ id: string; email: string; claimed_user_id: string | null }>('SELECT id,email,claimed_user_id FROM lattis_import_user WHERE source_site=$1 AND external_id=$2', [input.site,entry.id]);
        if (encrypted && !existing.rows[0]?.claimed_user_id) {
          const userTable = store.db.dialect === 'postgres' ? '"user"' : '`user`';
          const account = await client.query(`SELECT id FROM ${userTable} WHERE email=$1`, [entry.email]);
          if (account.rowCount) throw new ContentError(409,'A Lattis account already uses an imported WordPress email; use verified-email linking for this identity');
        }
        if (existing.rows[0]) {
          if (existing.rows[0].claimed_user_id && existing.rows[0].email !== entry.email) throw new ContentError(409,'Claimed identity email changed in WordPress');
          const changed = await client.query('UPDATE lattis_import_user SET email=$1,display_name=$2,source_roles=$3,legacy_password_ciphertext=$4,auth_mode=CASE WHEN claimed_user_id IS NULL THEN $5 ELSE auth_mode END,updated_at=$6 WHERE id=$7 AND (claimed_user_id IS NULL OR email=$1)', [entry.email,entry.displayName,JSON.stringify(entry.roles),existing.rows[0].claimed_user_id ? null : encrypted,entryMode,new Date(),existing.rows[0].id]);
          if (!changed.rowCount) {
            const current = (await client.query<{ email: string; claimed_user_id: string | null }>('SELECT email,claimed_user_id FROM lattis_import_user WHERE id=$1', [existing.rows[0].id])).rows[0];
            if (current?.claimed_user_id && current.email !== entry.email) throw new ContentError(409,'Claimed identity email changed in WordPress');
          }
        } else {
          await client.query('INSERT INTO lattis_import_user (id,source_site,external_id,email,display_name,source_roles,auth_mode,legacy_password_ciphertext) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(),input.site,entry.id,entry.email,entry.displayName,JSON.stringify(entry.roles),entryMode,encrypted]);
        }
      }
      if (previous.rowCount) await client.query('UPDATE lattis_import_cursor SET cursor_value=$1,batch_digest=$2,updated_at=$3 WHERE source_system=$4 AND source_site=$5 AND import_key=$6', [input.nextCursor,digest,new Date(),'wordpress-users',input.site,input.importKey]);
      else await client.query('INSERT INTO lattis_import_cursor (source_system,source_site,import_key,cursor_value,batch_digest) VALUES ($1,$2,$3,$4,$5)', ['wordpress-users',input.site,input.importKey,input.nextCursor,digest]);
      await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [who.id,'user.import.wordpress',input.site,'allowed',request.id]);
      await client.query('COMMIT');
      return { imported: input.users.length,skipped: 0,cursor: input.nextCursor };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { await client.unlock(lock).finally(() => client.release()); }
  });
  app.get('/api/me/imported-identities', async (request,reply) => {
    const who = await identity(request);
    if (!who || who.kind !== 'user' || !who.emailVerified) return reply.code(401).send({ error: 'Verified user required' });
    return (await store.db.query('SELECT source_site,external_id,display_name,claimed_user_id FROM lattis_import_user WHERE email=$1 AND auth_mode=$2 ORDER BY source_site,external_id', [who.email.toLowerCase(),'verified-email'])).rows.map((row) => ({ sourceSite: row.source_site,externalId: row.external_id,displayName: row.display_name,claimed: row.claimed_user_id === who.id }));
  });
  app.post('/api/me/imported-identities/claim', async (request,reply) => {
    if (!sameOrigin(request,reply)) return;
    const who = await identity(request);
    if (!who || who.kind !== 'user' || !who.emailVerified) return reply.code(401).send({ error: 'Verified user required' });
    const client = await store.db.connect();
    const lock = `wordpress-user-claim:${who.email.toLowerCase()}`;
    try {
      await client.lock(lock);
      await client.query('BEGIN');
      const conflict = await client.query('SELECT id FROM lattis_import_user WHERE email=$1 AND auth_mode=$3 AND claimed_user_id IS NOT NULL AND claimed_user_id<>$2', [who.email.toLowerCase(),who.id,'verified-email']);
      if (conflict.rowCount) throw new ContentError(409,'Imported identity is already claimed');
      const changed = await client.query('UPDATE lattis_import_user SET claimed_user_id=$1,legacy_password_ciphertext=NULL,updated_at=$2 WHERE email=$3 AND auth_mode=$4 AND claimed_user_id IS NULL', [who.id,new Date(),who.email.toLowerCase(),'verified-email']);
      await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [who.id,'user.import.claim','self','allowed',request.id]);
      await client.query('COMMIT');
      return { claimed: changed.rowCount };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { await client.unlock(lock).finally(() => client.release()); }
  });
}
