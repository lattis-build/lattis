import { z } from 'zod';
import semver from 'semver';
import { sha256Schema, packagePinSchema } from './release-contract.js';
export const admittedPackageSchema = z.object({
  name: z.string().regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/), version: z.string().refine((v) => !!semver.valid(v)),
  target: z.string().regex(/^artifacts\/[a-f0-9]{64}\.json$/), digest: sha256Schema, length: z.number().int().min(1).max(5_000_000),
  publisherPublicKey: z.string().max(2000), signature: z.string().max(256),
  dependencies: z.record(z.string().regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/), sha256Schema),
  admission: z.object({ id: z.string().min(1).max(100), decision: z.literal('approved'), evidence: z.array(z.string().min(1).max(2000)).min(1).max(100), reviewedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), execution: z.literal('download-only'),
    policy: z.literal('controlled-v1'), reviewer: z.string().min(1).max(200),
    checks: z.array(z.object({ category: z.enum(['security','compatibility','ui','dependencies','license','maintenance']), status: z.literal('passed'), evidence: z.array(z.string().min(1).max(2000)).min(1).max(30) }).strict()).length(6).refine((checks) => new Set(checks.map((check) => check.category)).size === 6),
  }).strict().refine((admission) => Date.parse(admission.reviewedAt) <= Date.now() && Date.parse(admission.expiresAt) > Date.parse(admission.reviewedAt) && Date.parse(admission.expiresAt) - Date.parse(admission.reviewedAt) <= 180 * 86400000, 'Invalid admission validity'),
}).strict();
export const catalogSchema = z.object({ schemaVersion: z.literal(3), registryId: z.literal('lattis-official'), packages: z.array(admittedPackageSchema).max(20000) }).strict();
export const lockSchema = z.object({ schemaVersion: z.literal(2), core: z.string().refine((v) => !!semver.valid(v)), packages: z.record(z.string().regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/), packagePinSchema) }).strict();

