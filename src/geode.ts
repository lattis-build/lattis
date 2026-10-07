import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { canonicalJson, digest, unpack, type Manifest } from './manifest.js';

export class GeodeError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export type GeodeActor = { publisher: string | null; subject: string; scopes: string[]; audience: 'geode-api' | 'geode-mcp' };
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export class Geode {
  constructor(private readonly db: Pool, private readonly artifactDir: string) {}

  private async mutate<T>(actor: GeodeActor, operation: string, key: string, payload: unknown, apply: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!key || key.length > 128) throw new GeodeError(400, 'Idempotency-Key required');
    const requestDigest = digest(Buffer.from(canonicalJson(payload)));
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [actor.publisher, `${operation}:${key}`]);
      const prior = await client.query('SELECT request_digest,result FROM geode_idempotency WHERE actor=$1 AND operation=$2 AND key=$3', [actor.publisher, operation, key]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== requestDigest) throw new GeodeError(409, 'Idempotency key reused');
        await client.query('COMMIT');
        return prior.rows[0].result as T;
      }
      const result = await apply(client);
      await client.query('INSERT INTO geode_idempotency (actor,operation,key,request_digest,result) VALUES ($1,$2,$3,$4,$5)', [actor.publisher, operation, key, requestDigest, result]);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async issueToken(publisher: string, audience: 'geode-api', scopes: string[], expiresAt: Date): Promise<string> {
    const token = `lattis_${randomBytes(32).toString('base64url')}`;
    await this.db.query('INSERT INTO geode_token (id,publisher_slug,subject,token_hash,audience,scopes,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), publisher, `publisher:${publisher}`, tokenHash(token), audience, scopes, expiresAt]);
    return token;
  }

  async issueInstanceToken(subject: string, expiresAt: Date): Promise<string> {
    if (!/^instance:[a-z0-9-]{1,100}$/.test(subject)) throw new GeodeError(400, 'Invalid instance subject');
    const token = `lattis_${randomBytes(32).toString('base64url')}`;
    await this.db.query('INSERT INTO geode_token (id,publisher_slug,subject,token_hash,audience,scopes,expires_at) VALUES ($1,NULL,$2,$3,$4,$5,$6)', [randomUUID(), subject, tokenHash(token), 'geode-api', ['package:read', 'package:download'], expiresAt]);
    return token;
  }

  async authenticate(token: string | undefined, audience: 'geode-api', scope: string): Promise<GeodeActor> {
    if (!token?.startsWith('lattis_')) throw new GeodeError(401, 'Bearer token required');
    const result = await this.db.query('SELECT publisher_slug, subject, token_hash, scopes FROM geode_token WHERE token_hash=$1 AND audience=$2 AND revoked_at IS NULL AND expires_at > now()', [tokenHash(token), audience]);
    const row = result.rows[0];
    if (!row || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(tokenHash(token)))) throw new GeodeError(401, 'Invalid token');
    if (!row.scopes.includes(scope)) throw new GeodeError(403, 'Missing scope');
    return { publisher: row.publisher_slug, subject: row.subject, scopes: row.scopes, audience };
  }

  async search(query: string, actor: GeodeActor | null, limit = 20) {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 20;
    const result = await this.db.query(
      `SELECT p.name,p.kind,p.description,p.visibility,p.publisher_slug,
        (SELECT v.version FROM geode_version v WHERE v.package_name=p.name AND v.state='admitted' AND EXISTS (SELECT 1 FROM geode_admission a WHERE a.package_name=v.package_name AND a.version=v.version AND a.expires_at>now()) ORDER BY v.published_at DESC LIMIT 1) AS latest_version
       FROM geode_package p WHERE (p.visibility='public' OR p.publisher_slug=$2 OR EXISTS (
         SELECT 1 FROM geode_entitlement e WHERE e.package_name=p.name AND e.subject=$4 AND e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at>now())))
         AND (p.publisher_slug=$2 OR EXISTS (SELECT 1 FROM geode_version av WHERE av.package_name=p.name AND av.state='admitted' AND EXISTS (SELECT 1 FROM geode_admission a WHERE a.package_name=av.package_name AND a.version=av.version AND a.expires_at>now()))) AND (p.name ILIKE $1 OR p.description ILIKE $1) ORDER BY p.name LIMIT $3`,
      [`%${query.replace(/[\\%_]/g, '\\$&')}%`, actor?.publisher ?? '', safeLimit, actor?.subject ?? ''],
    );
    return result.rows;
  }

  async packageInfo(name: string, actor: GeodeActor | null) {
    const result = await this.db.query(
      `SELECT p.name,p.kind,p.description,p.visibility,p.publisher_slug,
       coalesce(json_agg(json_build_object('version',v.version,'digest',v.digest,'state',v.state,'manifest',v.manifest) ORDER BY v.published_at) FILTER (WHERE v.version IS NOT NULL),'[]') AS versions,
       coalesce((SELECT json_agg(json_build_object('id',o.id,'model',o.model,'amountMinor',o.amount_minor,'currency',o.currency,'terms',o.terms)) FROM geode_offer o WHERE o.package_name=p.name),'[]') AS offers
       FROM geode_package p LEFT JOIN geode_version v ON v.package_name=p.name AND (v.state='admitted' AND EXISTS (SELECT 1 FROM geode_admission a WHERE a.package_name=v.package_name AND a.version=v.version AND a.expires_at>now()) OR p.publisher_slug=$2)
       WHERE p.name=$1 AND (p.visibility='public' OR p.publisher_slug=$2 OR EXISTS (
         SELECT 1 FROM geode_entitlement e WHERE e.package_name=p.name AND e.subject=$3 AND e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at>now())))
       GROUP BY p.name`, [name, actor?.publisher ?? '', actor?.subject ?? ''],
    );
    if (!result.rows[0]) throw new GeodeError(404, 'Package not found');
    return result.rows[0];
  }

  async versionInfo(name: string, version: string, actor: GeodeActor | null) {
    const result = await this.db.query(
      `SELECT v.package_name,v.version,v.digest,v.manifest,v.state,v.byte_count,v.publisher_public_key,v.signature,p.visibility,p.publisher_slug
       FROM geode_version v JOIN geode_package p ON p.name=v.package_name
       WHERE v.package_name=$1 AND v.version=$2 AND (v.state='admitted' AND EXISTS (SELECT 1 FROM geode_admission a WHERE a.package_name=v.package_name AND a.version=v.version AND a.expires_at>now()) OR p.publisher_slug=$3) AND (p.visibility='public' OR p.publisher_slug=$3 OR EXISTS (
         SELECT 1 FROM geode_entitlement e WHERE e.package_name=p.name AND e.subject=$4 AND e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at>now())))`,
      [name, version, actor?.publisher ?? '', actor?.subject ?? ''],
    );
    if (!result.rows[0]) throw new GeodeError(404, 'Version not found');
    return result.rows[0];
  }

  async publish(actor: GeodeActor, bytes: Buffer, visibility: 'public' | 'private', signature: string, key: string, correlationId: string) {
    if (bytes.length > 5_000_000) throw new GeodeError(413, 'Artifact too large');
    let manifest: Manifest;
    try { manifest = unpack(bytes).manifest; }
    catch { throw new GeodeError(400, 'Invalid artifact'); }
    if (!actor.publisher || manifest.name.split('/')[0] !== `@${actor.publisher}`) throw new GeodeError(403, 'Publisher namespace mismatch');
    if (visibility === 'public' && manifest.license.identifier === 'UNLICENSED') throw new GeodeError(400, 'Public package requires an explicit license identifier');
    const sha = digest(bytes);
    const publisher = await this.db.query('SELECT public_key FROM geode_publisher WHERE slug=$1', [actor.publisher]);
    const publicKey = publisher.rows[0]?.public_key;
    let signatureValid = false;
    try { const key = createPublicKey(publicKey); signatureValid = key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(sha), key, Buffer.from(signature, 'base64')); }
    catch { /* Invalid signature encoding or key. */ }
    if (!signatureValid) throw new GeodeError(403, 'Invalid publisher signature');
    const requestDigest = digest(Buffer.from(`${sha}:${visibility}:${signature}`));
    const existing = await this.db.query('SELECT request_digest,result FROM geode_idempotency WHERE actor=$1 AND operation=$2 AND key=$3', [actor.publisher, 'publish', key]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_digest !== requestDigest) throw new GeodeError(409, 'Idempotency key reused');
      return existing.rows[0].result;
    }
    await mkdir(this.artifactDir, { recursive: true });
    const artifactPath = join(this.artifactDir, sha.slice(7));
    await writeFile(artifactPath, bytes, { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
      const stored = await readFile(artifactPath);
      if (digest(stored) !== sha) throw new GeodeError(500, 'Artifact storage conflict');
    });
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO geode_package (name,publisher_slug,kind,description,visibility) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (name) DO NOTHING`,
        [manifest.name, actor.publisher, manifest.kind, manifest.description, visibility]);
      const packageRow = await client.query('SELECT publisher_slug,kind,visibility FROM geode_package WHERE name=$1', [manifest.name]);
      if (packageRow.rows[0]?.publisher_slug !== actor.publisher || packageRow.rows[0]?.kind !== manifest.kind || packageRow.rows[0]?.visibility !== visibility) throw new GeodeError(409, 'Package identity or visibility conflict');
      const inserted = await client.query(`INSERT INTO geode_version (package_name,version,digest,manifest,byte_count,publisher_public_key,signature,state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'quarantined') ON CONFLICT DO NOTHING RETURNING version`,
        [manifest.name, manifest.version, sha, manifest, bytes.length, publicKey, signature]);
      if (!inserted.rowCount) throw new GeodeError(409, 'Version already published');
      const result = { name: manifest.name, version: manifest.version, digest: sha, visibility, state: 'quarantined' };
      await client.query('INSERT INTO geode_idempotency (actor,operation,key,request_digest,result) VALUES ($1,$2,$3,$4,$5)', [actor.publisher, 'publish', key, requestDigest, result]);
      await client.query('INSERT INTO geode_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [actor.publisher, 'package.publish', `${manifest.name}@${manifest.version}`, 'allowed', correlationId]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') {
        const prior = await this.db.query('SELECT request_digest,result FROM geode_idempotency WHERE actor=$1 AND operation=$2 AND key=$3', [actor.publisher, 'publish', key]);
        if (prior.rows[0]?.request_digest === requestDigest) return prior.rows[0].result;
      }
      throw error;
    } finally { client.release(); }
  }

  async createOffer(actor: GeodeActor, name: string, offer: { model: 'free' | 'one-time' | 'subscription'; amountMinor?: number; currency?: string; terms?: string }, key: string, correlationId: string) {
    if (offer.model === 'free' ? offer.amountMinor !== undefined || offer.currency !== undefined : !Number.isInteger(offer.amountMinor) || (offer.amountMinor ?? -1) < 0 || !/^[A-Z]{3}$/.test(offer.currency ?? '')) throw new GeodeError(400, 'Invalid offer');
    return this.mutate(actor, 'offer.create', key, { name, offer }, async (client) => {
      const owns = await client.query('SELECT 1 FROM geode_package WHERE name=$1 AND publisher_slug=$2', [name, actor.publisher]);
      if (!owns.rowCount) throw new GeodeError(404, 'Package not found');
      const id = randomUUID();
      await client.query('INSERT INTO geode_offer (id,package_name,model,amount_minor,currency,terms) VALUES ($1,$2,$3,$4,$5,$6)', [id, name, offer.model, offer.amountMinor ?? null, offer.currency ?? null, offer.terms ?? '']);
      await client.query('INSERT INTO geode_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [actor.publisher, 'offer.create', name, 'allowed', correlationId]);
      return { id, packageName: name, ...offer };
    });
  }

  async revokeVersion(actor: GeodeActor, name: string, version: string, reason: string, key: string, correlationId: string) {
    return this.mutate(actor, 'version.revoke', key, { name, version, reason }, async (client) => {
      const changed = await client.query(`UPDATE geode_version v SET state='revoked'
        FROM geode_package p WHERE p.name=v.package_name AND p.publisher_slug=$1
        AND v.package_name=$2 AND v.version=$3 AND v.state<>'revoked' RETURNING v.version`, [actor.publisher, name, version]);
      if (!changed.rowCount) throw new GeodeError(404, 'Published version not found');
      await client.query('INSERT INTO geode_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [actor.publisher, 'version.revoke', `${name}@${version}`, reason, correlationId]);
      return { name, version, state: 'revoked' };
    });
  }

  async grant(actor: GeodeActor, name: string, subject: string, expiresAt: string | null, key: string, correlationId: string) {
    if (!subject || subject.length > 200) throw new GeodeError(400, 'Invalid subject');
    return this.mutate(actor, 'entitlement.grant', key, { name, subject, expiresAt }, async (client) => {
      const owns = await client.query('SELECT 1 FROM geode_package WHERE name=$1 AND publisher_slug=$2', [name, actor.publisher]);
      if (!owns.rowCount) throw new GeodeError(404, 'Package not found');
      const id = randomUUID();
      await client.query('INSERT INTO geode_entitlement (id,package_name,subject,source,expires_at) VALUES ($1,$2,$3,$4,$5)', [id, name, subject, 'manual', expiresAt]);
      await client.query('INSERT INTO geode_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [actor.publisher, 'entitlement.grant', `${name}:${subject}`, 'allowed', correlationId]);
      return { id, packageName: name, subject, expiresAt };
    });
  }

  async entitlement(name: string, subject: string) {
    const result = await this.db.query(`SELECT 1 FROM geode_entitlement WHERE package_name=$1 AND subject=$2
      AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`, [name, subject]);
    return !!result.rowCount;
  }

  async artifact(name: string, version: string, actor: GeodeActor | null): Promise<Buffer> {
    const result = await this.db.query(`SELECT v.digest,p.visibility,p.publisher_slug,
      EXISTS(SELECT 1 FROM geode_offer o WHERE o.package_name=p.name AND o.model='free') AS has_free_offer
      FROM geode_version v JOIN geode_package p ON p.name=v.package_name
      WHERE v.package_name=$1 AND v.version=$2 AND v.state='admitted' AND EXISTS (SELECT 1 FROM geode_admission a WHERE a.package_name=v.package_name AND a.version=v.version AND a.expires_at>now())`, [name, version]);
    const row = result.rows[0];
    if (!row) throw new GeodeError(404, 'Version not found');
    const owner = actor?.publisher === row.publisher_slug;
    const entitled = actor ? await this.entitlement(name, actor.subject) : false;
    if (!owner && !(row.visibility === 'public' && row.has_free_offer) && !entitled) throw new GeodeError(403, 'Entitlement required');
    const bytes = await readFile(join(this.artifactDir, row.digest.slice(7)));
    if (digest(bytes) !== row.digest) throw new GeodeError(500, 'Artifact integrity failure');
    return bytes;
  }
}
