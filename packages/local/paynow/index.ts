import { z } from 'zod';
import type { NodeDefinition } from 'lattis/runtime';
import { openEmail, piiKey, sealEmail } from './pii.js';

const status = z.enum(['QUEUED','UNKNOWN','BLOCKED','NEW','PENDING','CONFIRMED','REJECTED','ERROR','EXPIRED','ABANDONED']);
const id = z.uuid();
const request = z.object({
  externalId: id,
  amountMinor: z.number().int().min(100).max(100_000_000),
  currency: z.literal('PLN'),
  description: z.string().trim().min(1).max(255),
  buyerEmail: z.string().trim().email().max(50),
}).strict();
const read = z.object({ externalId: id }).strict();
const forSale = z.object({ saleId: id, description: z.string().trim().min(1).max(255) }).strict();
const saleDetails = z.object({ saleId:id, currency:z.literal('PLN'),scale:z.literal(2),totalMinor:z.number().int().min(100).max(100_000_000),
  status:z.literal('OPEN'),buyer:z.object({ email:z.email().max(50) }).passthrough() }).passthrough();
const requested = z.object({ externalId: id, status }).strict();
const details = z.object({
  externalId: id, amountMinor: z.number().int(), currency: z.literal('PLN'), status,
  paynowPaymentId: z.string().nullable(), redirectUrl: z.string().nullable(),
}).strict();

type PaymentRow = {
  external_id: string; amount_minor: string | number; currency: string; description: string;
  buyer_email_sealed: string; status: z.infer<typeof status>; paynow_payment_id: string | null; redirect_url: string | null;
};

export const nodes: NodeDefinition[] = [
  {
    name: 'lattis.paynow.payment.request', packageName: '@lattis/paynow', kind: 'command',
    declaredSecrets: ['PAYNOW_PII_KEY'],
    action: 'paynow.payment.create', resourceType: 'payment', resourceId: (raw) => (raw as z.infer<typeof request>).externalId,
    input: request, output: requested,
    handler: async (context, raw) => {
      if (context.principal.kind !== 'service') throw new Error('Payment creation requires a trusted service');
      const input = request.parse(raw);
      const key = piiKey(await context.secrets.get('PAYNOW_PII_KEY'));
      await context.db.lock(`paynow-payment:${input.externalId}`);
      const existing = (await context.db.query<PaymentRow>('SELECT external_id,amount_minor,currency,description,buyer_email_sealed,status,paynow_payment_id,redirect_url FROM lattis_paynow_payment WHERE external_id=$1', [input.externalId])).rows[0];
      if (existing) {
        if (Number(existing.amount_minor) !== input.amountMinor || existing.currency !== input.currency
          || existing.description !== input.description || openEmail(existing.buyer_email_sealed, input.externalId, key) !== input.buyerEmail) throw new Error('Payment externalId reused with different details');
        return { externalId: input.externalId, status: existing.status };
      }
      await context.db.query('INSERT INTO lattis_paynow_payment (external_id,amount_minor,currency,description,buyer_email_sealed,created_by,status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [input.externalId,input.amountMinor,input.currency,input.description,sealEmail(input.buyerEmail,input.externalId,key),context.principal.id,'QUEUED']);
      return { externalId: input.externalId, status: 'QUEUED' };
    },
  },
  {
    name: 'lattis.paynow.payment.for-sale', packageName: '@lattis/paynow', kind: 'command',
    action: 'paynow.payment.create', resourceType: 'payment', resourceId: (raw) => (raw as z.infer<typeof forSale>).saleId,
    input: forSale, output: z.object({ saleId:id, externalId:id, status }).strict(),
    handler: async (context, raw) => {
      if (context.principal.kind !== 'service') throw new Error('Payment creation requires a trusted service');
      const input = forSale.parse(raw);
      const sale = saleDetails.parse(await context.invoke('lattis.commerce.sale.get', { saleId:input.saleId }));
      const payment = requested.parse(await context.invoke('lattis.paynow.payment.request', {
        externalId:input.saleId, amountMinor:sale.totalMinor, currency:'PLN',
        description:input.description, buyerEmail:sale.buyer.email,
      }));
      const currentSale = (await context.db.query<{ status: string }>('SELECT status FROM lattis_commerce_sale WHERE sale_id=$1 FOR UPDATE', [input.saleId])).rows[0];
      if (currentSale?.status !== 'OPEN') throw new Error('Sale is no longer open');
      const bound = await context.db.query('UPDATE lattis_paynow_payment SET sale_id=$1 WHERE external_id=$2 AND (sale_id IS NULL OR sale_id=$1)', [input.saleId,input.saleId]);
      if (!bound.rowCount) {
        const existing = (await context.db.query<{ sale_id: string | null }>('SELECT sale_id FROM lattis_paynow_payment WHERE external_id=$1', [input.saleId])).rows[0];
        if (existing?.sale_id !== input.saleId) throw new Error('Payment is bound to another sale');
      }
      await context.invoke('lattis.commerce.sale.link', { saleId:input.saleId,kind:'payment',provider:'paynow',
        reference:input.saleId,status:payment.status,amountMinor:sale.totalMinor });
      return { saleId:input.saleId, externalId:payment.externalId, status:payment.status };
    },
  },
  {
    name: 'lattis.paynow.payment.get', packageName: '@lattis/paynow', kind: 'query',
    action: 'paynow.payment.read', resourceType: 'payment', resourceId: (raw) => (raw as z.infer<typeof read>).externalId,
    input: read, output: details,
    handler: async (context, raw) => {
      const input = read.parse(raw);
      const row = (await context.db.query<PaymentRow>('SELECT external_id,amount_minor,currency,description,buyer_email_sealed,status,paynow_payment_id,redirect_url FROM lattis_paynow_payment WHERE external_id=$1', [input.externalId])).rows[0];
      if (!row) throw new Error('Payment not found');
      return { externalId: row.external_id, amountMinor: Number(row.amount_minor), currency: row.currency,
        status: row.status, paynowPaymentId: row.paynow_payment_id, redirectUrl: row.redirect_url };
    },
  },
];
