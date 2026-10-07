import type { AppDatabase } from './app-db.js';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SecretProvider {
  resolve(locator: string): Promise<string>;
}

export class DevelopmentEnvSecrets implements SecretProvider {
  async resolve(locator: string): Promise<string> {
    if (process.env.NODE_ENV === 'production') throw new Error('Environment secrets provider is disabled in production');
    const value = process.env[locator];
    if (value === undefined) throw new Error(`Missing development secret reference: ${locator}`);
    return value;
  }
}

export class ExternalSecretProvider implements SecretProvider {
  constructor(private readonly endpoint: string, private readonly serviceToken: string) {
    if (!endpoint.startsWith('https://')) throw new Error('External secret provider requires HTTPS');
  }
  async resolve(locator: string): Promise<string> {
    const response = await fetch(new URL(`/v1/secrets/${encodeURIComponent(locator)}`, this.endpoint), {
      headers: { authorization: `Bearer ${this.serviceToken}` },
    });
    if (!response.ok) throw new Error('External secret provider failed');
    const payload = await response.json() as { value?: unknown };
    if (typeof payload.value !== 'string') throw new Error('Invalid external secret response');
    return payload.value;
  }
}

export class DatabaseVaultSecrets implements SecretProvider {
  private readonly key: Buffer;
  constructor(private readonly db: AppDatabase, encodedKey: string) {
    this.key = Buffer.from(encodedKey, 'base64');
    if (this.key.length !== 32 || this.key.toString('base64') !== encodedKey) throw new Error('LATTIS_VAULT_KEY must be exactly 32 Base64-encoded bytes');
  }
  private seal(name: string, version: number, value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm',this.key,nonce);
    cipher.setAAD(Buffer.from(`${name}:${version}`));
    return `v1:${nonce.toString('base64url')}:${Buffer.concat([cipher.update(value,'utf8'),cipher.final()]).toString('base64url')}:${cipher.getAuthTag().toString('base64url')}`;
  }
  async resolve(locator: string): Promise<string> {
    const row = (await this.db.query<{ ciphertext: string; version: number }>('SELECT ciphertext,version FROM lattis_admin_secret WHERE name=$1', [locator])).rows[0];
    if (!row) throw new Error('Vault secret unavailable');
    const [format,nonceText,dataText,tagText,...rest] = row.ciphertext.split(':');
    if (format !== 'v1' || rest.length) throw new Error('Invalid vault secret');
    const nonce = Buffer.from(nonceText,'base64url'), tag = Buffer.from(tagText,'base64url');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid vault secret');
    const decipher = createDecipheriv('aes-256-gcm',this.key,nonce);
    decipher.setAAD(Buffer.from(`${locator}:${row.version}`));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(dataText,'base64url')),decipher.final()]).toString('utf8');
  }
  async create(name: string, allowedPackage: string, value: string, actor: string, correlationId: string): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO lattis_admin_secret (name,ciphertext,version) VALUES ($1,$2,$3)', [name,this.seal(name,1,value),1]);
      await client.query('INSERT INTO lattis_secret_ref (name,provider,locator,allowed_package) VALUES ($1,$2,$3,$4)', [name,'vault',name,allowedPackage]);
      await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [actor,'secret.vault.create',name,'allowed',correlationId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { await client.release(); }
  }
  async rotate(name: string, expectedVersion: number, value: string, actor: string, correlationId: string): Promise<number> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const ref = (await client.query<{ provider: string }>('SELECT provider FROM lattis_secret_ref WHERE name=$1', [name])).rows[0];
      if (ref?.provider !== 'vault') throw new Error('Vault secret reference unavailable');
      const version = expectedVersion + 1;
      const changed = await client.query('UPDATE lattis_admin_secret SET ciphertext=$1,version=$2,updated_at=$3 WHERE name=$4 AND version=$5',
        [this.seal(name,version,value),version,new Date(),name,expectedVersion]);
      if (!changed.rowCount) throw new Error('Secret version conflict');
      await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [actor,'secret.vault.rotate',name,'allowed',correlationId]);
      await client.query('COMMIT');
      return version;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { await client.release(); }
  }
}

export class SecretReferences {
  constructor(private readonly db: AppDatabase, private readonly providers: Record<string, SecretProvider>) {}
  async resolveForPackage(name: string, packageName: string): Promise<string> {
    const found = await this.db.query('SELECT provider,locator FROM lattis_secret_ref WHERE name=$1 AND allowed_package=$2', [name, packageName]);
    const ref = found.rows[0];
    if (!ref) throw new Error('Secret reference not available for package');
    const provider = this.providers[ref.provider];
    if (!provider) throw new Error('Secret provider unavailable');
    return provider.resolve(ref.locator);
  }
}
