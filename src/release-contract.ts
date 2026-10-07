import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import semver from 'semver';
import { canonicalJson, digest, publisherFingerprint } from './manifest.js';
import { relativePath } from './security-files.js';

export const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const pathSchema = z.string().refine((value) => { try { relativePath(value); return true; } catch { return false; } });
export const fileSchema = z.object({ digest: sha256Schema, length: z.number().int().nonnegative().max(100_000_000) }).strict();
export const signatureSchema = z.object({ keyId: sha256Schema, signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(256) }).strict();
export const packagePinSchema = z.object({ version: z.string().refine((v) => !!semver.valid(v)), digest: sha256Schema, kind: z.enum(['node', 'shard']), publisherPublicKey: z.string().max(2000), signature: z.string().max(256), registryId: z.string().min(1).max(100), admissionDigest: sha256Schema }).strict();
export const migrationSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), path: pathSchema, digest: sha256Schema, dialect: z.enum(['postgres', 'mariadb']), phase: z.enum(['expand', 'backfill', 'contract']), reversible: z.boolean(), scope: z.string().min(1).max(100) }).strict();
export const releaseSchema = z.object({
  schemaVersion: z.literal(2), applicationId: z.string().regex(/^[a-z0-9-]{1,100}$/),
  core: z.string().refine((v) => !!semver.valid(v)), coreArtifact: fileSchema.extend({ path: pathSchema }).nullable(),
  platform: fileSchema.extend({ target: z.string().regex(/^platform\/[a-zA-Z0-9._-]+\.json$/) }),
  files: z.record(pathSchema, fileSchema).refine((files) => Object.keys(files).length > 0 && Object.keys(files).length <= 20000),
  packages: z.record(z.string().regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/), packagePinSchema),
  localPublisher: z.string().regex(/^[a-z0-9-]+$/), trustedModules: z.array(pathSchema).max(200),
  migrations: z.array(migrationSchema).max(500),
  components: z.array(z.enum(['app', 'admin', 'mcp', 'geode', 'worker'])).min(1),
  configurationDigest: sha256Schema,
  compatibility: z.object({ previousRelease: sha256Schema.nullable(), dataRollback: z.enum(['compatible', 'forward-only']), minimumUpdater: z.literal(1) }).strict(),
}).strict();
export type ReleaseManifest = z.infer<typeof releaseSchema>;
export const releaseEnvelopeSchema = z.object({ signed: releaseSchema, signatures: z.array(signatureSchema).min(1).max(10) }).strict();
export const installationPolicySchema = z.object({
  schemaVersion: z.literal(1), applicationId: z.string().regex(/^[a-z0-9-]{1,100}$/), localPublisher: z.string().regex(/^[a-z0-9-]+$/),
  releaseDirectory: z.string().startsWith('/'), stateDirectory: z.string().startsWith('/'),
  ownerKeys: z.record(sha256Schema, z.string().max(2000)), ownerThreshold: z.number().int().min(1).max(10),
  allowDownloadedExecution: z.literal(false),
}).strict();
export type InstallationPolicy = z.infer<typeof installationPolicySchema>;

export function releaseDigest(manifest: ReleaseManifest): string { return digest(Buffer.from(canonicalJson(releaseSchema.parse(manifest)))); }
export function approvalBytes(manifest: ReleaseManifest): Buffer { return Buffer.from(`lattis.application-release.v2\n${canonicalJson(releaseSchema.parse(manifest))}`); }
export function verifyRelease(envelope: unknown, policy: InstallationPolicy): ReleaseManifest {
  const { signed, signatures } = releaseEnvelopeSchema.parse(envelope);
  if (signed.applicationId !== policy.applicationId || signed.localPublisher !== policy.localPublisher) throw new Error('Release belongs to a different installation');
  const accepted = new Set<string>();
  for (const signature of signatures) {
    const publicKey = policy.ownerKeys[signature.keyId];
    if (!publicKey || accepted.has(signature.keyId)) continue;
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || publisherFingerprint(publicKey) !== signature.keyId) throw new Error('Invalid installation key');
    if (verify(null, approvalBytes(signed), key, Buffer.from(signature.signature, 'base64'))) accepted.add(signature.keyId);
  }
  if (accepted.size < policy.ownerThreshold) throw new Error('Release authorization threshold not met');
  if (signed.trustedModules.some((path) => !path.startsWith('packages/local/'))) throw new Error('Only local application code may be activated in Core');
  return signed;
}
