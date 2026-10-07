import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ContentError, ContentStore, type ContentInput, type ContentLink } from './content.js';
import type { AppClient } from './app-db.js';
import type { Principal } from './authorization.js';
import { canonicalJson } from './manifest.js';
import { migrationContentBatchSchema, migrationCursorQuerySchema, type MigrationContentBatch, type MigrationSource } from './migration-contract.js';
import { migrationDigest, migrationLock, migrationStream, beforeBatch, advanceBatch, uniqueMigrationIds } from './migration-store.js';

type Permission = (request:FastifyRequest,reply:FastifyReply,action:string,resourceType:string,resourceId?:string)=>Promise<Principal|null>;
async function references(store:ContentStore,client:AppClient,input:MigrationContentBatch):Promise<void> {
  const {source}=input;
  uniqueMigrationIds(input.types.map(type=>type.key),'content type');
  uniqueMigrationIds(input.terms.map(term=>`${term.taxonomy}\n${term.id}`),'term');
  uniqueMigrationIds(input.media.map(medium=>medium.id),'media');
  for(const type of input.types) {
    const current=await store.type(type.key,client);
    if(!current) await store.createType(type,client);
    else if(canonicalJson(current)!==canonicalJson(type)) throw new ContentError(409,`Content type differs: ${type.key}; change its schema explicitly before migration`);
  }
  for(const term of input.terms) {
    const row=(await client.query<{id:string}>('SELECT id FROM lattis_taxonomy_term WHERE source_system=$1 AND source_site=$2 AND taxonomy=$3 AND external_id=$4',[source.system,source.instance,term.taxonomy,term.id])).rows[0];
    if(row) await client.query('UPDATE lattis_taxonomy_term SET slug=$1,label=$2 WHERE id=$3',[term.slug,term.label,row.id]);
    else await store.createTerm({taxonomy:term.taxonomy,slug:term.slug,label:term.label},{system:source.system,site:source.instance,id:term.id},client);
  }
  for(const term of input.terms) if(term.parentId!==undefined) {
    const parent=term.parentId===null?null:(await client.query<{id:string}>('SELECT id FROM lattis_taxonomy_term WHERE source_system=$1 AND source_site=$2 AND taxonomy=$3 AND external_id=$4',[source.system,source.instance,term.taxonomy,term.parentId])).rows[0]?.id;
    if(parent===undefined) throw new ContentError(409,`Import parent term first: ${term.parentId}`);
    if(term.parentId===term.id) throw new ContentError(400,'Term cannot be its own parent');
    await client.query('UPDATE lattis_taxonomy_term SET parent_id=$1 WHERE source_system=$2 AND source_site=$3 AND taxonomy=$4 AND external_id=$5',[parent,source.system,source.instance,term.taxonomy,term.id]);
  }
  for(const medium of input.media) {
    const row=(await client.query<{id:string;storage_ref:string}>('SELECT id,storage_ref FROM lattis_media WHERE source_system=$1 AND source_site=$2 AND external_id=$3',[source.system,source.instance,medium.id])).rows[0];
    if(row) { if(!row.storage_ref.startsWith('local:')) await client.query('UPDATE lattis_media SET storage_ref=$1,mime_type=$2,alt_text=$3,metadata=$4 WHERE id=$5',[medium.storageRef,medium.mimeType,medium.altText,JSON.stringify(medium.metadata),row.id]); }
    else { const {id,...data}=medium;await store.createMedia(data,{system:source.system,site:source.instance,id},client); }
  }
}
async function importItem(store:ContentStore,client:AppClient,source:MigrationSource,entry:MigrationContentBatch['items'][number]):Promise<'created'|'updated'|'skipped'> {
  const digest=migrationDigest(entry);
  const prior=(await client.query<{content_id:string;source_digest:string}>('SELECT content_id,source_digest FROM lattis_content_source WHERE source_system=$1 AND source_site=$2 AND source_kind=$3 AND external_id=$4',[source.system,source.instance,entry.type,entry.id])).rows[0];
  if(prior?.source_digest===digest) return 'skipped';
  const {id:externalId,authorId,terms,links,...content}=entry;
  const value:ContentInput=content;
  if(prior) {
    const current=await store.get(prior.content_id,client);
    if(!current) throw new ContentError(409,'Source map points to missing content');
    await store.update(current.id,value,current.revision,client);
    await client.query('UPDATE lattis_content_source SET source_digest=$1,imported_at=$2 WHERE source_system=$3 AND source_site=$4 AND source_kind=$5 AND external_id=$6',[digest,new Date(),source.system,source.instance,entry.type,externalId]);
    return 'updated';
  }
  const id=randomUUID();
  await store.create(value,client,id);
  await client.query('INSERT INTO lattis_content_source (source_system,source_site,source_kind,external_id,content_id,source_digest) VALUES ($1,$2,$3,$4,$5,$6)',[source.system,source.instance,entry.type,externalId,id,digest]);
  return 'created';
}
async function associations(store:ContentStore,client:AppClient,source:MigrationSource,entry:MigrationContentBatch['items'][number]):Promise<void> {
  const id=(await client.query<{content_id:string}>('SELECT content_id FROM lattis_content_source WHERE source_system=$1 AND source_site=$2 AND source_kind=$3 AND external_id=$4',[source.system,source.instance,entry.type,entry.id])).rows[0]?.content_id;
  if(!id) throw new ContentError(409,'Content source missing');
  if(entry.terms!==undefined) {
    const ids:string[]=[];
    for(const term of entry.terms) {
      const target=(await client.query<{id:string}>('SELECT id FROM lattis_taxonomy_term WHERE source_system=$1 AND source_site=$2 AND taxonomy=$3 AND external_id=$4',[source.system,source.instance,term.taxonomy,term.id])).rows[0]?.id;
      if(!target) throw new ContentError(409,`Import term first: ${term.taxonomy}/${term.id}`); ids.push(target);
    }
    await store.setTerms(id,ids,client);
  }
  if(entry.links!==undefined) {
    const links:ContentLink[]=[];
    for(const link of entry.links) {
      const target=link.target.kind==='content'?(await client.query<{ref:string}>('SELECT content_id AS ref FROM lattis_content_source WHERE source_system=$1 AND source_site=$2 AND source_kind=$3 AND external_id=$4',[source.system,source.instance,link.target.type,link.target.id])).rows[0]?.ref:(await client.query<{ref:string}>('SELECT id AS ref FROM lattis_media WHERE source_system=$1 AND source_site=$2 AND external_id=$3',[source.system,source.instance,link.target.id])).rows[0]?.ref;
      if(!target) throw new ContentError(409,`Import link target first: ${link.target.id}`);
      links.push({relation:link.relation,targetKind:link.target.kind,targetRef:target,position:link.position});
    }
    await store.setLinks(id,links,client);
  }
  if(entry.authorId!==undefined) {
    await client.query('DELETE FROM lattis_content_author WHERE content_id=$1',[id]);
    if(entry.authorId!==null) {
      const author=(await client.query<{id:string}>('SELECT id FROM lattis_import_user WHERE source_system=$1 AND source_site=$2 AND external_id=$3',[source.system,source.instance,entry.authorId])).rows[0];
      if(!author) throw new ContentError(409,`Import author first: ${entry.authorId}`);
      await client.query('INSERT INTO lattis_content_author (content_id,import_user_id) VALUES ($1,$2)',[id,author.id]);
    }
  }
}
export function registerContentImport(app:FastifyInstance,store:ContentStore,permission:Permission,sameOrigin:(request:FastifyRequest,reply:FastifyReply)=>boolean):void {
  app.get('/api/migrations/content/cursor',async(request,reply)=>{
    if(!await permission(request,reply,'content.import','content')) return;
    const q=migrationCursorQuerySchema.parse(request.query);
    const row=(await store.db.query<{cursor_value:string|null}>('SELECT cursor_value FROM lattis_import_cursor WHERE source_system=$1 AND source_site=$2 AND import_key=$3',[q.system,q.instance,migrationStream('content',q.importKey)])).rows[0];
    return {schemaVersion:1,cursor:row?.cursor_value??null};
  });
  app.post('/api/migrations/content/batches',{bodyLimit:8*1024*1024},async(request,reply)=>{
    if(!sameOrigin(request,reply)) return;
    const who=await permission(request,reply,'content.import','content');if(!who)return;
    const input=migrationContentBatchSchema.parse(request.body),{source}=input;
    uniqueMigrationIds(input.items.map(entry=>`${entry.type}\n${entry.id}`),'content');
    const client=await store.db.connect(),lock=migrationLock(source),key=migrationStream('content',input.importKey),digest=migrationDigest(input);
    try {
      await client.lock(lock);await client.query('BEGIN');
      const previous=await beforeBatch(client,source,key,input.expectedCursor,input.nextCursor,digest);
      if(previous.replay){await client.query('COMMIT');return {created:0,updated:0,skipped:input.items.length,cursor:input.nextCursor};}
      await references(store,client,input);
      const result={created:0,updated:0,skipped:0};
      for(const entry of input.items)result[await importItem(store,client,source,entry)]++;
      for(const entry of input.items)await associations(store,client,source,entry);
      await advanceBatch(client,source,key,input.nextCursor,digest,previous.exists);
      await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)',[who.id,'content.import',`${source.system}:${source.instance}:${input.importKey}`,'allowed',request.id]);
      await client.query('COMMIT');return {...result,cursor:input.nextCursor};
    } catch(error){await client.query('ROLLBACK');throw error;}
    finally{await client.unlock(lock).finally(()=>client.release());}
  });
}
