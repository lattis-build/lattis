export const REVIEW_CATEGORIES: string[];
export function reviewedInventoryDigest(files: Record<string, { digest: string; length: number }>): string;
export function requireReview(review: unknown, files: Record<string, { digest: string; length: number }>, version: string, configurationDigest: string, enforceExpiry?: boolean, edgePolicyDigest?: string): unknown;
