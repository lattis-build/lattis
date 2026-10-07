import { createHash } from 'node:crypto';
import { canonicalJson } from './manifest.js';
import { ContentError } from './content.js';
import type { AppClient } from './app-db.js';
import type { MigrationSource } from './migration-contract.js';

export function migrationDigest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function migrationLock(source: MigrationSource): string { return `migration:${migrationDigest(source)}`; }
export function migrationStream(channel: 'content'|'users', key: string): string { return `v1:${channel}:${key}`; }
export async function beforeBatch(client: AppClient, source: MigrationSource, key: string, expected: string|null, next: string|null, digest: string): Promise<{exists:boolean;replay:boolean}> {
  const row=(await client.query<{cursor_value:string|null;batch_digest:string}>('SELECT cursor_value,batch_digest FROM lattis_import_cursor WHERE source_system=$1 AND source_site=$2 AND import_key=$3',[source.system,source.instance,key])).rows[0];
  if(row && row.batch_digest===digest) return {exists:true,replay:true};
  if((row?.cursor_value??null)!==expected) throw new ContentError(409,'Migration cursor changed; reload it before sending this batch');
  if(expected===next) throw new ContentError(400,'A new batch must advance the cursor; use a distinct non-null checkpoint for each batch, including the last');
  return {exists:!!row,replay:false};
}
export async function advanceBatch(client:AppClient,source:MigrationSource,key:string,next:string|null,digest:string,exists:boolean):Promise<void> {
  if(exists) await client.query('UPDATE lattis_import_cursor SET cursor_value=$1,batch_digest=$2,updated_at=$3 WHERE source_system=$4 AND source_site=$5 AND import_key=$6',[next,digest,new Date(),source.system,source.instance,key]);
  else await client.query('INSERT INTO lattis_import_cursor (source_system,source_site,import_key,cursor_value,batch_digest) VALUES ($1,$2,$3,$4,$5)',[source.system,source.instance,key,next,digest]);
}
export function uniqueMigrationIds(ids:string[],label:string):void { if(new Set(ids).size!==ids.length) throw new ContentError(400,`Duplicate ${label} in migration batch`); }
