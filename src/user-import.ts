import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ContentError, ContentStore } from './content.js';
import type { Principal } from './authorization.js';
import { encryptImportedCredential, credentialMigrationConfigured } from './imported-credentials.js';
import { migrationUserBatchSchema, migrationCursorQuerySchema } from './migration-contract.js';
import { beforeBatch, advanceBatch, migrationDigest, migrationLock, migrationStream, uniqueMigrationIds } from './migration-store.js';

type Permission = (request: FastifyRequest, reply: FastifyReply, action: string, resourceType: string, resourceId?: string) => Promise<Principal | null>;
type Identity = (request: FastifyRequest) => Promise<Principal | null>;

export function registerUserImport(app: FastifyInstance, store: ContentStore, permission: Permission, identity: Identity, sameOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean): void {
  app.get('/api/migrations/users/cursor', async (request,reply) => {
    if (!await permission(request,reply,'user.import','user')) return;
    const query = migrationCursorQuerySchema.parse(request.query);
    const row = (await store.db.query<{ cursor_value: string | null }>('SELECT cursor_value FROM lattis_import_cursor WHERE source_system=$1 AND source_site=$2 AND import_key=$3', [query.system,query.instance,migrationStream('users',query.importKey)])).rows[0];
    return { schemaVersion:1,cursor: row?.cursor_value ?? null };
  });
  app.post('/api/migrations/users/batches', {bodyLimit:2*1024*1024}, async (request,reply) => {
    if (!sameOrigin(request,reply)) return;
    const who = await permission(request,reply,'user.import','user'); if (!who) return;
    const input = migrationUserBatchSchema.parse(request.body);
    uniqueMigrationIds(input.users.map(entry=>entry.id),'user');
    const passwordMode=input.authMode==='password';
    for(const entry of input.users) if(entry.credential) {
      if(!passwordMode) throw new ContentError(400,'Credentials require the explicit password migration mode');
      try { credentialMigrationConfigured(entry.credential.algorithm); }
      catch { throw new ContentError(503,'An accepted credential verifier and encryption key must be configured by the operator'); }
    }
    const client = await store.db.connect();
    const lock=migrationLock(input.source),key=migrationStream('users',input.importKey),digest=migrationDigest(input);
    try {
      await client.lock(lock);
      await client.query('BEGIN');
      const previous=await beforeBatch(client,input.source,key,input.expectedCursor,input.nextCursor,digest);
      if(previous.replay){await client.query('COMMIT');return {imported:0,skipped:input.users.length,cursor:input.nextCursor};}
      for (const entry of input.users) {
        const encrypted = passwordMode && entry.credential ? encryptImportedCredential(input.source,entry.id,entry.email,entry.credential) : null;
        const entryMode = encrypted ? 'password' : 'verified-email';
        const existing = await client.query<{ id: string; email: string; claimed_user_id: string | null }>('SELECT id,email,claimed_user_id FROM lattis_import_user WHERE source_system=$1 AND source_site=$2 AND external_id=$3', [input.source.system,input.source.instance,entry.id]);
        if (encrypted && !existing.rows[0]?.claimed_user_id) {
          const userTable = store.db.dialect === 'postgres' ? '"user"' : '`user`';
          const account = await client.query(`SELECT id FROM ${userTable} WHERE email=$1`, [entry.email]);
          if (account.rowCount) throw new ContentError(409,'A Lattis account already uses an imported email; use verified-email linking for this identity');
        }
        if (existing.rows[0]) {
          if (existing.rows[0].claimed_user_id && existing.rows[0].email !== entry.email) throw new ContentError(409,'Claimed identity email changed at the source');
          const changed = await client.query('UPDATE lattis_import_user SET email=$1,display_name=$2,source_roles=$3,legacy_password_ciphertext=CASE WHEN claimed_user_id IS NULL THEN $4 ELSE NULL END,auth_mode=CASE WHEN claimed_user_id IS NULL THEN $5 ELSE auth_mode END,updated_at=$6 WHERE id=$7 AND (claimed_user_id IS NULL OR email=$1)', [entry.email,entry.displayName,JSON.stringify(entry.roles),existing.rows[0].claimed_user_id ? null : encrypted,entryMode,new Date(),existing.rows[0].id]);
          if (!changed.rowCount) {
            const current = (await client.query<{ email: string; claimed_user_id: string | null }>('SELECT email,claimed_user_id FROM lattis_import_user WHERE id=$1', [existing.rows[0].id])).rows[0];
            if (current?.claimed_user_id && current.email !== entry.email) throw new ContentError(409,'Claimed identity email changed at the source');
          }
        } else {
          await client.query('INSERT INTO lattis_import_user (id,source_system,source_site,external_id,email,display_name,source_roles,auth_mode,legacy_password_ciphertext) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(),input.source.system,input.source.instance,entry.id,entry.email,entry.displayName,JSON.stringify(entry.roles),entryMode,encrypted]);
        }
      }
      await advanceBatch(client,input.source,key,input.nextCursor,digest,previous.exists);
      await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [who.id,'user.import',`${input.source.system}:${input.source.instance}`,'allowed',request.id]);
      await client.query('COMMIT');
      return { imported: input.users.length,skipped: 0,cursor: input.nextCursor };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { await client.unlock(lock).finally(() => client.release()); }
  });
  app.get('/api/me/imported-identities', async (request,reply) => {
    const who = await identity(request);
    if (!who || who.kind !== 'user' || !who.emailVerified) return reply.code(401).send({ error: 'Verified user required' });
    return (await store.db.query('SELECT source_system,source_site,external_id,display_name,claimed_user_id FROM lattis_import_user WHERE email=$1 AND auth_mode=$2 ORDER BY source_system,source_site,external_id', [who.email.toLowerCase(),'verified-email'])).rows.map((row) => ({ source: { system:row.source_system, instance:row.source_site },externalId: row.external_id,displayName: row.display_name,claimed: row.claimed_user_id === who.id }));
  });
  app.post('/api/me/imported-identities/claim', async (request,reply) => {
    if (!sameOrigin(request,reply)) return;
    const who = await identity(request);
    if (!who || who.kind !== 'user' || !who.emailVerified) return reply.code(401).send({ error: 'Verified user required' });
    const client = await store.db.connect();
    const lock = `imported-user-claim:${who.email.toLowerCase()}`;
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
