import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AppClient, AppDatabase } from './app-db.js';
import type { createAuth } from './auth.js';
import { importedCredentialSchema, type ImportedCredential, type MigrationSource } from './migration-contract.js';
import { boundedResponse } from './security-files.js';

function importKey():Buffer {
  const value=process.env.LATTIS_IMPORT_KEY;
  if(!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('LATTIS_IMPORT_KEY must be 32 random bytes encoded as base64');
  return Buffer.from(value,'base64');
}
function verifierConfiguration() {
  const url=new URL(process.env.LATTIS_IMPORT_VERIFIER_URL??'');
  const developmentLoopback=process.env.NODE_ENV!=='production' && url.protocol==='http:' && ['127.0.0.1','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:'&&!developmentLoopback)||url.username||url.password||url.hash) throw new Error('Configure a protected HTTPS credential verifier');
  const token=process.env.LATTIS_IMPORT_VERIFIER_TOKEN;
  if(!token || token.length<32 || /[\r\n]/.test(token)) throw new Error('Configure a credential verifier token of at least 32 characters');
  const algorithms=(process.env.LATTIS_IMPORT_ALGORITHMS??'').split(',').map(value=>value.trim()).filter(Boolean);
  if(!algorithms.length || algorithms.some(algorithm=>!/^[a-z][a-z0-9_.-]{0,79}$/.test(algorithm))) throw new Error('Configure the accepted imported credential algorithms');
  return {url,token,algorithms};
}
export function credentialMigrationConfigured(algorithm:string):void {
  importKey();if(!verifierConfiguration().algorithms.includes(algorithm)) throw new Error('Credential algorithm is not allowed by the operator');
}
function aad(source:MigrationSource,id:string,email:string):Buffer { return Buffer.from(JSON.stringify([source.system,source.instance,id,email])); }
export function encryptImportedCredential(source:MigrationSource,id:string,email:string,value:ImportedCredential):string {
  const credential=importedCredentialSchema.parse(value);credentialMigrationConfigured(credential.algorithm);
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',importKey(),iv);
  cipher.setAAD(aad(source,id,email));
  const body=Buffer.concat([cipher.update(JSON.stringify(credential),'utf8'),cipher.final()]);
  return `v2:${Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64')}`;
}
function decrypt(row:PendingUser):ImportedCredential {
  const encrypted=row.legacy_password_ciphertext;
  if(!encrypted.startsWith('v2:')) throw new Error('Reimport legacy credentials through the current migration contract');
  const bytes=Buffer.from(encrypted.slice(3),'base64');
  if(bytes.length<29 || bytes.length>32000) throw new Error('Invalid credential envelope');
  const cipher=createDecipheriv('aes-256-gcm',importKey(),bytes.subarray(0,12));
  cipher.setAAD(aad({system:row.source_system,instance:row.source_site},row.external_id,row.email));cipher.setAuthTag(bytes.subarray(12,28));
  return importedCredentialSchema.parse(JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8')));
}
async function verifyCredential(password:string,row:PendingUser):Promise<boolean> {
  if(Buffer.byteLength(password)>4096) return false;
  const credential=decrypt(row),config=verifierConfiguration();
  if(!config.algorithms.includes(credential.algorithm)) return false;
  // The endpoint is operator-controlled. An import cannot choose a URL or load code.
  const response=await fetch(config.url,{method:'POST',headers:{authorization:`Bearer ${config.token}`,'content-type':'application/json'},body:JSON.stringify({schemaVersion:1,source:{system:row.source_system,instance:row.source_site},credential,password}),redirect:'error',signal:AbortSignal.timeout(5000)});
  const value=JSON.parse((await boundedResponse(response,1024)).toString('utf8'));
  return value && Object.keys(value).length===1 && value.valid===true;
}

type PendingUser = { id: string; source_system: string; source_site: string; external_id: string; email: string; display_name: string; claimed_user_id: string | null; legacy_password_ciphertext: string };

export class ImportedCredentialBridge {
  constructor(private readonly db: AppDatabase, private readonly auth: ReturnType<typeof createAuth>) {}

  private async pending(email: string, client?: AppClient): Promise<PendingUser[]> {
    return (await (client ?? this.db).query<PendingUser>('SELECT id,source_system,source_site,external_id,email,display_name,claimed_user_id,legacy_password_ciphertext FROM lattis_import_user WHERE email=$1 AND auth_mode=$2 AND legacy_password_ciphertext IS NOT NULL ORDER BY source_system,source_site,external_id LIMIT 10', [email,'password'])).rows;
  }

  private async matching(email: string, password: string, client?: AppClient): Promise<PendingUser[]> {
    const rows=await this.pending(email,client);
    const matched=await Promise.all(rows.map(async row=>{
      try { return await verifyCredential(password,row)?row:null; }
      catch { return null; } // Verifier failure does not authorize an identity or break native sign-in.
    }));
    return matched.filter((row):row is PendingUser=>row!==null);
  }

  async provisionAfterFailedSignIn(email: string, password: string): Promise<boolean> {
    const table = this.db.dialect === 'postgres' ? '"user"' : '`user`';
    if ((await this.db.query(`SELECT id FROM ${table} WHERE email=$1`, [email])).rowCount) return false;
    const match = (await this.matching(email, password)).find((row) => !row.claimed_user_id);
    if (!match) return false;
    try {
      await this.auth.api.createUser({ body: { email, name: match.display_name, password, data: { emailVerified: false } } });
      return true;
    } catch (error) {
      if ((await this.db.query(`SELECT id FROM ${table} WHERE email=$1`, [email])).rowCount) return true;
      throw error;
    }
  }

  async claimAfterSignIn(userId: string, email: string, password: string, correlationId: string): Promise<void> {
    const matches = (await this.matching(email, password)).filter((row) => !row.claimed_user_id || row.claimed_user_id === userId);
    if (!matches.length) return;
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      for (const row of matches) {
        const changed = await client.query('UPDATE lattis_import_user SET claimed_user_id=$1,password_claimed_at=$2,legacy_password_ciphertext=NULL,updated_at=$2 WHERE id=$3 AND (claimed_user_id IS NULL OR claimed_user_id=$1) AND legacy_password_ciphertext=$4', [userId,new Date(),row.id,row.legacy_password_ciphertext]);
        if (changed.rowCount) await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [userId,'user.import.password',row.id,'allowed',correlationId]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { await client.release(); }
  }
}
