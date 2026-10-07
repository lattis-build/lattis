import { z } from 'zod';

export const saleId = z.uuid();
const moneyMinor = z.number().int().nonnegative().max(1_000_000_000_000);
const buyer = z.object({
  customerRef: z.string().trim().min(1).max(191).optional(),
  userId: z.string().trim().min(1).max(191).optional(),
  name: z.string().trim().min(1).max(255).optional(),
  email: z.email().max(100).optional(),
  taxNo: z.string().trim().min(1).max(32).optional(),
  street: z.string().trim().min(1).max(255).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  postCode: z.string().trim().min(1).max(20).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
}).strict().refine((value) => !!(value.customerRef || value.userId || value.name || value.email), 'Buyer identity is required');
const item = z.object({
  lineId: saleId,
  productRef: z.string().trim().min(1).max(191).optional(),
  name: z.string().trim().min(1).max(255),
  quantity: z.number().int().positive().max(1_000_000),
  unit: z.string().trim().min(1).max(30).optional(),
  totalMinor: moneyMinor.positive(),
  tax: z.union([z.number().int().min(0).max(100), z.enum(['zw','np'])]).optional(),
}).strict();
const metadata = z.record(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/), z.union([z.string().max(500),z.number().finite(),z.boolean(),z.null()]));

export const create = z.object({
  saleId: saleId.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  scale: z.number().int().min(0).max(3),
  buyer,
  items: z.array(item).min(1).max(100),
  metadata: metadata.default({}),
}).strict().superRefine((value, context) => {
  if (new Set(value.items.map((entry) => entry.lineId)).size !== value.items.length)
    context.addIssue({ code: 'custom', path: ['items'], message: 'Duplicate lineId' });
  const total = totalMinor(value.items);
  if (!Number.isSafeInteger(total) || total > 1_000_000_000_000)
    context.addIssue({ code: 'custom', path: ['items'], message: 'Sale amount exceeds limit' });
  if (Buffer.byteLength(JSON.stringify(value.metadata), 'utf8') > 4_096)
    context.addIssue({ code: 'custom', path: ['metadata'], message: 'Metadata exceeds 4 KiB' });
});

export type SaleCreate = z.infer<typeof create>;
export const read = z.object({ saleId }).strict();
export const saleStatus = z.enum(['OPEN','CANCELLED','CLOSED']);
export const fulfillmentStatus = z.enum(['UNFULFILLED','PARTIAL','FULFILLED']);
export const linkKind = z.enum(['payment','invoice','fulfillment','other']);
export const linkStatus = z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/);

export const link = z.object({
  saleId, kind: linkKind, provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  reference: z.string().trim().min(1).max(191), providerId: z.string().trim().min(1).max(191).optional(),
  status: linkStatus, amountMinor: moneyMinor.optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === 'payment' && (!value.amountMinor || !['QUEUED','NEW','PENDING','UNKNOWN','CONFIRMED','REJECTED','ERROR','EXPIRED','ABANDONED','BLOCKED','FAILED','REFUNDED'].includes(value.status)))
    context.addIssue({ code: 'custom', path: ['status'], message: 'Payment link requires amount and a known status' });
});

export const updateStatus = z.object({
  saleId, expectedVersion: z.number().int().nonnegative(),
  status: saleStatus.optional(), fulfillmentStatus: fulfillmentStatus.optional(),
}).strict().refine((value) => value.status !== undefined || value.fulfillmentStatus !== undefined, 'A status change is required');

export function totalMinor(items: Array<{ totalMinor: number }>): number {
  return items.reduce((sum, entry) => sum + entry.totalMinor, 0);
}
