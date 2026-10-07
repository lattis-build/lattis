import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const existingBuyer = z.object({ kind: z.literal('existing'), clientId: z.number().int().positive() }).strict();
const newBuyer = z.object({
  kind: z.literal('new'), name: z.string().trim().min(1).max(255),
  email: z.email().max(100).optional(), taxNo: z.string().trim().min(1).max(32).optional(),
  street: z.string().trim().min(1).max(255).optional(), city: z.string().trim().min(1).max(100).optional(),
  postCode: z.string().trim().min(1).max(20).optional(), country: z.string().regex(/^[A-Z]{2}$/).default('PL'),
}).strict();
const position = z.object({
  name: z.string().trim().min(1).max(255), quantity: z.number().int().positive().max(1_000_000),
  tax: z.union([z.number().int().min(0).max(100), z.enum(['zw','np'])]),
  totalGrossMinor: z.number().int().positive().max(100_000_000_000),
}).strict();

export const request = z.object({
  externalId: z.uuid(), departmentId: z.number().int().positive(),
  issueDate: date, sellDate: date, buyer: z.discriminatedUnion('kind', [existingBuyer,newBuyer]),
  positions: z.array(position).min(1).max(50),
  requireConfirmedPaynow: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  for (const field of ['issueDate','sellDate'] as const) {
    const raw = value[field];
    const parsed = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10) !== raw)
      context.addIssue({ code: 'custom', message: 'Invalid calendar date', path: [field] });
  }
  if (!Number.isSafeInteger(grossMinor(value))) context.addIssue({ code: 'custom', message: 'Invoice amount exceeds safe integer range', path: ['positions'] });
});

export type InvoiceRequest = z.infer<typeof request>;
export const read = z.object({ externalId: z.uuid() }).strict();
export const status = z.enum(['QUEUED','IN_FLIGHT','NEEDS_REVIEW','BLOCKED','ISSUED']);

export function grossMinor(input: Pick<InvoiceRequest, 'positions'>): number {
  return input.positions.reduce((sum, item) => sum + item.totalGrossMinor, 0);
}

export function money(minor: number): string {
  const value = BigInt(minor);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}
