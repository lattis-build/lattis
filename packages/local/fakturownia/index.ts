import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { NodeDefinition } from 'lattis/runtime';
import { encryptionKey, seal } from './seal.js';
import { grossMinor, read, request, status } from './contract.js';

const fromSale = z.object({ saleId:z.uuid(),departmentId:z.number().int().positive(),
  issueDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),sellDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requireConfirmedPaynow:z.boolean().default(false) }).strict();
const saleSnapshot = z.object({
  saleId:z.uuid(),currency:z.literal('PLN'),scale:z.literal(2),totalMinor:z.number().int().positive(),status:z.literal('OPEN'),
  buyer:z.object({ name:z.string().min(1),email:z.email().optional(),taxNo:z.string().optional(),
    street:z.string().optional(),city:z.string().optional(),postCode:z.string().optional(),country:z.string().optional() }).passthrough(),
  items:z.array(z.object({name:z.string(),quantity:z.number().int().positive(),tax:z.union([z.number().int().min(0).max(100),z.enum(['zw','np'])]),
    totalMinor:z.number().int().positive() }).passthrough()).min(1).max(50),
}).passthrough();

type InvoiceRow = {
  external_id: string; gross_minor: string | number; status: z.infer<typeof status>;
  payload_digest: string; fakturownia_id: string | number | null; invoice_number: string | null; last_error: string | null;
};

const requested = z.object({ externalId: z.uuid(), status }).strict();
const details = z.object({
  externalId: z.uuid(), grossMinor: z.number().int(), currency: z.literal('PLN'), status,
  fakturowniaId: z.number().int().nullable(), number: z.string().nullable(), attentionCode: z.string().nullable(),
}).strict();

export const nodes: NodeDefinition[] = [
  {
    name: 'lattis.fakturownia.invoice.request', packageName: '@lattis/fakturownia', kind: 'command',
    action: 'fakturownia.invoice.create', resourceType: 'invoice',
    resourceId: (raw) => (raw as z.infer<typeof request>).externalId,
    declaredSecrets: ['FAKTUROWNIA_PII_KEY'], input: request, output: requested,
    handler: async (context, raw) => {
      if (context.principal.kind !== 'service') throw new Error('Invoice creation requires a trusted service');
      const input = request.parse(raw);
      const amount = grossMinor(input);
      const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      await context.db.lock(`fakturownia-invoice:${input.externalId}`);
      const existing = (await context.db.query<InvoiceRow>(
        'SELECT external_id,gross_minor,status,payload_digest,fakturownia_id,invoice_number,last_error FROM lattis_fakturownia_invoice WHERE external_id=$1', [input.externalId],
      )).rows[0];
      if (existing) {
        if (existing.payload_digest !== digest) throw new Error('Invoice externalId reused with different details');
        return { externalId: input.externalId, status: existing.status };
      }
      if (input.requireConfirmedPaynow) {
        const payment = (await context.db.query<{ amount_minor: string | number; currency: string; status: string }>(
          'SELECT amount_minor,currency,status FROM lattis_paynow_payment WHERE external_id=$1', [input.externalId],
        )).rows[0];
        if (!payment || payment.status !== 'CONFIRMED' || payment.currency !== 'PLN' || Number(payment.amount_minor) !== amount)
          throw new Error('Matching confirmed Paynow payment is required');
      }
      const key = encryptionKey(await context.secrets.get('FAKTUROWNIA_PII_KEY'));
      await context.db.query(
        'INSERT INTO lattis_fakturownia_invoice (external_id,gross_minor,currency,payload_sealed,payload_digest,created_by,status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [input.externalId,amount,'PLN',seal(JSON.stringify(input),input.externalId,key),digest,context.principal.id,'QUEUED'],
      );
      return { externalId: input.externalId, status: 'QUEUED' };
    },
  },
  {
    name: 'lattis.fakturownia.invoice.from-sale', packageName: '@lattis/fakturownia', kind: 'command',
    action: 'fakturownia.invoice.create', resourceType: 'invoice', resourceId: (raw) => (raw as z.infer<typeof fromSale>).saleId,
    input: fromSale, output: z.object({ saleId:z.uuid(),externalId:z.uuid(),status }).strict(),
    handler: async (context, raw) => {
      if (context.principal.kind !== 'service') throw new Error('Invoice creation requires a trusted service');
      const input = fromSale.parse(raw);
      const sale = saleSnapshot.parse(await context.invoke('lattis.commerce.sale.get', { saleId:input.saleId }));
      const invoiceInput = request.parse({ externalId:input.saleId,departmentId:input.departmentId,
        issueDate:input.issueDate,sellDate:input.sellDate,
        buyer:{ kind:'new',name:sale.buyer.name,email:sale.buyer.email,taxNo:sale.buyer.taxNo,
          street:sale.buyer.street,city:sale.buyer.city,postCode:sale.buyer.postCode,country:sale.buyer.country ?? 'PL' },
        positions:sale.items.map((entry) => ({ name:entry.name,quantity:entry.quantity,tax:entry.tax,totalGrossMinor:entry.totalMinor })),
        requireConfirmedPaynow:input.requireConfirmedPaynow });
      if (grossMinor(invoiceInput) !== sale.totalMinor) throw new Error('Sale amount differs from invoice positions');
      const invoice = requested.parse(await context.invoke('lattis.fakturownia.invoice.request',invoiceInput));
      const currentSale = (await context.db.query<{ status: string }>('SELECT status FROM lattis_commerce_sale WHERE sale_id=$1 FOR UPDATE', [input.saleId])).rows[0];
      if (currentSale?.status !== 'OPEN') throw new Error('Sale is no longer open');
      const bound = await context.db.query('UPDATE lattis_fakturownia_invoice SET sale_id=$1 WHERE external_id=$2 AND (sale_id IS NULL OR sale_id=$1)', [input.saleId,input.saleId]);
      if (!bound.rowCount) {
        const prior = (await context.db.query<{ sale_id: string | null }>('SELECT sale_id FROM lattis_fakturownia_invoice WHERE external_id=$1', [input.saleId])).rows[0];
        if (prior?.sale_id !== input.saleId) throw new Error('Invoice is bound to another sale');
      }
      await context.invoke('lattis.commerce.sale.link', { saleId:input.saleId,kind:'invoice',provider:'fakturownia',
        reference:input.saleId,status:invoice.status,amountMinor:sale.totalMinor });
      return { saleId:input.saleId,externalId:invoice.externalId,status:invoice.status };
    },
  },
  {
    name: 'lattis.fakturownia.invoice.get', packageName: '@lattis/fakturownia', kind: 'query',
    action: 'fakturownia.invoice.read', resourceType: 'invoice',
    resourceId: (raw) => (raw as z.infer<typeof read>).externalId,
    input: read, output: details,
    handler: async (context, raw) => {
      const input = read.parse(raw);
      const row = (await context.db.query<InvoiceRow>(
        'SELECT external_id,gross_minor,status,payload_digest,fakturownia_id,invoice_number,last_error FROM lattis_fakturownia_invoice WHERE external_id=$1', [input.externalId],
      )).rows[0];
      if (!row) throw new Error('Invoice not found');
      return { externalId: row.external_id, grossMinor: Number(row.gross_minor), currency: 'PLN', status: row.status,
        fakturowniaId: row.fakturownia_id === null ? null : Number(row.fakturownia_id),
        number: row.invoice_number, attentionCode: row.last_error };
    },
  },
];
