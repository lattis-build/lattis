import { createHash } from 'node:crypto';

export const REVIEW_CATEGORIES = ['security', 'compatibility', 'ui', 'dependencies', 'recovery', 'waf', 'license'];
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export function reviewedInventoryDigest(files) {
  const sorted = Object.fromEntries(Object.entries(files).filter(([name]) => name !== 'lattis.review.json').sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) => [name, { digest: file.digest, length: file.length }]));
  return sha(JSON.stringify(sorted));
}
export function requireReview(review, files, version, configurationDigest, enforceExpiry = true, edgePolicyDigest) {
  if (!review || review.schemaVersion !== 1 || review.decision !== 'approved' || review.core !== version || review.configurationDigest !== configurationDigest || review.inventoryDigest !== reviewedInventoryDigest(files)) throw new Error('Quality review is missing or does not cover this exact release');
  if (!/^sha256:[a-f0-9]{64}$/.test(review.edgePolicyDigest) || (edgePolicyDigest !== undefined && review.edgePolicyDigest !== edgePolicyDigest)) throw new Error('Review does not cover the protected edge configuration');
  const reviewed = Date.parse(review.reviewedAt), expires = Date.parse(review.expiresAt);
  if (!Number.isFinite(reviewed) || !Number.isFinite(expires) || reviewed > Date.now() || expires <= reviewed || expires - reviewed > 180 * 86400000 || (enforceExpiry && expires <= Date.now())) throw new Error('Quality review validity is invalid or expired');
  if (typeof review.reviewer !== 'string' || !review.reviewer.trim() || review.reviewer.length > 200 || !Array.isArray(review.checks) || review.checks.length !== REVIEW_CATEGORIES.length) throw new Error('Named reviewer and all quality checks required');
  for (const category of REVIEW_CATEGORIES) {
    const matches = review.checks.filter((check) => check.category === category);
    if (matches.length !== 1 || matches[0].status !== 'passed' || !Array.isArray(matches[0].evidence) || !matches[0].evidence.length || matches[0].evidence.length > 30) throw new Error(`Quality evidence required: ${category}`);
    for (const item of matches[0].evidence) {
      if (!item || typeof item.path !== 'string' || item.path === 'lattis.review.json' || !Object.hasOwn(files, item.path) || files[item.path].digest !== item.digest) throw new Error(`Quality evidence is not bound to release files: ${category}`);
    }
  }
  return review;
}
