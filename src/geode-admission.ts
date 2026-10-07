import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { distributionClient } from '../updater/lib/tuf-client.mjs';
import { boundedFile, exclusive } from './security-files.js';
import { digest, canonicalJson, unpack } from './manifest.js';
import { catalogSchema } from './registry-client.js';

export async function exportQuarantine(db: Pool, artifactDirectory: string, name: string, version: string, output: string) {
  const publication = (await db.query("SELECT 1 FROM geode_package p WHERE p.name=$1 AND p.visibility='public' AND EXISTS (SELECT 1 FROM geode_offer o WHERE o.package_name=p.name AND o.model='free')", [name])).rowCount;
  if (!publication) throw new Error('Public static distribution supports public free packages only in phase 1');
  const result = await db.query("SELECT package_name,version,digest,manifest,publisher_public_key,signature,byte_count FROM geode_version WHERE package_name=$1 AND version=$2 AND state='quarantined'", [name,version]);
  const row = result.rows[0]; if (!row) throw new Error('Quarantined version not found');
  const bytes = await boundedFile(join(artifactDirectory, row.digest.slice(7)), 5_000_000);
  if (digest(bytes) !== row.digest) throw new Error('Artifact storage conflict');
  const artifact = unpack(bytes);
  if (artifact.manifest.name !== name || artifact.manifest.version !== version) throw new Error('Artifact identity differs');
  await mkdir(join(output, 'artifacts'), { recursive: true, mode: 0o700 });
  const target = `artifacts/${row.digest.slice(7)}.json`;
  await writeFile(join(output, target), bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(join(output, `${row.digest.slice(7)}.review.json`), JSON.stringify({ name, version, target, digest: row.digest, length: bytes.length, publisherPublicKey: row.publisher_public_key, signature: row.signature, admission: { decision: 'PENDING', evidence: [], execution: 'download-only' } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { target, status: 'quarantined-awaiting-independent-review' };
}

export async function importAdmission(db: Pool, name: string, version: string, stateDirectory: string) {
  const publication = (await db.query("SELECT 1 FROM geode_package p WHERE p.name=$1 AND p.visibility='public' AND EXISTS (SELECT 1 FROM geode_offer o WHERE o.package_name=p.name AND o.model='free')", [name])).rowCount;
  if (!publication) throw new Error('Private or paid artifacts require a separate authenticated distribution design');
  return exclusive(join(stateDirectory, 'refresh.lock'), async () => {
    const client = await distributionClient({ stateDirectory, development: process.env.LATTIS_REGISTRY_MODE === 'development' });
    await client.refresh();
    const catalogTarget = await client.getTargetInfo('catalog.json');
    if (!catalogTarget || catalogTarget.length > 10_000_000) throw new Error('Signed catalog unavailable');
    const bytes = await boundedFile(await client.downloadTarget(catalogTarget), 10_000_000);
    const catalog = catalogSchema.parse(JSON.parse(bytes.toString('utf8')));
    const entries = catalog.packages.filter((p) => p.name === name && p.version === version && new Date(p.admission.expiresAt).getTime() > Date.now());
    if (entries.length !== 1) throw new Error('Unambiguous current admission required');
    const entry = entries[0];
    const target = await client.getTargetInfo(entry.target);
    if (!target || target.hashes.sha256 !== entry.digest.slice(7) || target.length !== entry.length) throw new Error('Admission is not bound to a TUF artifact');
    const artifact = unpack(await boundedFile(await client.downloadTarget(target), 5_000_000));
    if (artifact.manifest.name !== name || artifact.manifest.version !== version) throw new Error('Admission identity mismatch');
    const connection = await db.connect();
    try {
      await connection.query('BEGIN');
      const row = (await connection.query('SELECT digest,publisher_public_key,signature,state FROM geode_version WHERE package_name=$1 AND version=$2 FOR UPDATE', [name,version])).rows[0];
      if (!row || row.digest !== entry.digest || row.publisher_public_key !== entry.publisherPublicKey || row.signature !== entry.signature || !['quarantined','admitted'].includes(row.state)) throw new Error('Admission differs from the quarantined publication');
      await connection.query('INSERT INTO geode_admission (package_name,version,artifact_digest,admission_digest,catalog_digest,evidence,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (package_name,version) DO UPDATE SET admission_digest=EXCLUDED.admission_digest,catalog_digest=EXCLUDED.catalog_digest,evidence=EXCLUDED.evidence,expires_at=EXCLUDED.expires_at,admitted_at=now()', [name,version,entry.digest,digest(Buffer.from(canonicalJson(entry.admission))),digest(bytes),entry.admission,entry.admission.expiresAt]);
      await connection.query("UPDATE geode_version SET state='admitted' WHERE package_name=$1 AND version=$2", [name,version]);
      await connection.query('INSERT INTO geode_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', ['offline-release','package.admit',`${name}@${version}`,digest(bytes),randomUUID()]);
      await connection.query('COMMIT');
      return { name, version, state: 'admitted', execution: 'download-only' };
    } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
  });
}
