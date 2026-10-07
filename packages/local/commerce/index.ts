import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { NodeDefinition } from 'lattis/runtime';
import { create, fulfillmentStatus, link, linkKind, linkStatus, read, saleId, saleStatus, totalMinor, updateStatus } from './contract.js';
import { encryptionKey, open, seal } from './seal.js';

type SaleRow = {
  sale_id: string; currency: string; scale: number; total_minor: number | string;
  snapshot_sealed: string; snapshot_digest: string; status: z.infer<typeof saleStatus>;
  fulfillment_status: z.infer<typeof fulfillmentStatus>; version: number;
};
type LinkRow = {
  sale_id: string; kind: z.infer<typeof linkKind>; provider: string; reference: string;
  provider_id: string | null; status: string; amount_minor: number | string | null;
};

const created = z.object({ saleId, totalMinor: z.number().int(), currency: z.string(), scale: z.number().int(), status: saleStatus }).strict();
const linked = z.object({ saleId, kind: linkKind, provider: z.string(), reference: z.string(), status: linkStatus }).strict();
const updated = z.object({ saleId, status: saleStatus, fulfillmentStatus, version: z.number().int() }).strict();
const linkOut = z.object({ kind: linkKind, provider: z.string(), reference: z.string(), providerId: z.string().nullable(),
  status: linkStatus, amountMinor: z.number().int().nullable() }).strict();
const details = z.object({
  saleId, currency: z.string(), scale: z.number().int(), totalMinor: z.number().int(),
  buyer: z.unknown(), items: z.array(z.unknown()), metadata: z.record(z.string(),z.unknown()),
  status: saleStatus, fulfillmentStatus, version: z.number().int(),
  paymentStatus: z.enum(['UNPAID','PENDING','PARTIAL','PAID','OVERPAID','REFUNDED']),
  paymentReceivedMinor: z.number().int(), links: z.array(linkOut),
}).strict();

function received(links: LinkRow[]): number {
  const total = links.filter((entry) => entry.kind === 'payment' && entry.status === 'CONFIRMED')
    .reduce((sum, entry) => sum + BigInt(entry.amount_minor ?? 0), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Payment sum exceeds safe integer range');
  return Number(total);
}

export const nodes: NodeDefinition[] = [
  {
    name: 'lattis.commerce.sale.create', packageName: '@lattis/commerce', kind: 'command',
    action: 'commerce.sale.create', resourceType: 'sale', resourceId: (raw) => (raw as z.infer<typeof create>).saleId ?? '*',
    declaredSecrets: ['COMMERCE_PII_KEY'], input: create, output: created,
    handler: async (context, raw) => {
      if (context.principal.kind !== 'service') throw new Error('Creating a sale requires a trusted service');
      const input = create.parse(raw);
      const id = input.saleId ?? randomUUID();
      const amount = totalMinor(input.items);
      const snapshot = JSON.stringify({ buyer: input.buyer, items: input.items, metadata: input.metadata });
      const key = encryptionKey(await context.secrets.get('COMMERCE_PII_KEY'));
      const digest = createHmac('sha256',key).update(JSON.stringify({ saleId:id,currency:input.currency,scale:input.scale,
        buyer:input.buyer,items:input.items,metadata:input.metadata })).digest('hex');
      await context.db.lock(`commerce-sale:${id}`);
      const prior = (await context.db.query<SaleRow>('SELECT sale_id,currency,scale,total_minor,snapshot_sealed,snapshot_digest,status,fulfillment_status,version FROM lattis_commerce_sale WHERE sale_id=$1', [id])).rows[0];
      if (prior) {
        if (prior.snapshot_digest !== digest || prior.currency !== input.currency || Number(prior.scale) !== input.scale || Number(prior.total_minor) !== amount)
          throw new Error('Sale ID reused with different details');
        return { saleId:id,totalMinor:amount,currency:input.currency,scale:input.scale,status:prior.status };
      }
      await context.db.query('INSERT INTO lattis_commerce_sale (sale_id,currency,scale,total_minor,snapshot_sealed,snapshot_digest,status,fulfillment_status,version,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id,input.currency,input.scale,amount,seal(snapshot,id,key),digest,'OPEN','UNFULFILLED',1,context.principal.id]);
      return { saleId:id,totalMinor:amount,currency:input.currency,scale:input.scale,status:'OPEN' };
    },
  },
  {
    name: 'lattis.commerce.sale.get', packageName: '@lattis/commerce', kind: 'query',
    action: 'commerce.sale.read', resourceType: 'sale', resourceId: (raw) => (raw as z.infer<typeof read>).saleId,
    declaredSecrets: ['COMMERCE_PII_KEY'], input: read, output: details,
    handler: async (context, raw) => {
      const input = read.parse(raw);
      const sale = (await context.db.query<SaleRow>('SELECT sale_id,currency,scale,total_minor,snapshot_sealed,snapshot_digest,status,fulfillment_status,version FROM lattis_commerce_sale WHERE sale_id=$1', [input.saleId])).rows[0];
      if (!sale) throw new Error('Sale not found');
      const links = (await context.db.query<LinkRow>('SELECT sale_id,kind,provider,reference,provider_id,status,amount_minor FROM lattis_commerce_link WHERE sale_id=$1 ORDER BY kind,provider,reference', [input.saleId])).rows;
      const key = encryptionKey(await context.secrets.get('COMMERCE_PII_KEY'));
      const snapshot = JSON.parse(open(sale.snapshot_sealed,input.saleId,key)) as { buyer: unknown; items: unknown[]; metadata: Record<string,unknown> };
      const paid = received(links);
      const total = Number(sale.total_minor);
      const pending = links.some((entry) => entry.kind === 'payment' && ['QUEUED','NEW','PENDING','UNKNOWN'].includes(entry.status));
      const refunded = links.some((entry) => entry.kind === 'payment' && entry.status === 'REFUNDED');
      const paymentStatus = paid > total ? 'OVERPAID' : paid === total ? 'PAID' : paid > 0 ? 'PARTIAL' : pending ? 'PENDING' : refunded ? 'REFUNDED' : 'UNPAID';
      return { saleId:input.saleId,currency:sale.currency,scale:Number(sale.scale),totalMinor:total,
        buyer:snapshot.buyer,items:snapshot.items,metadata:snapshot.metadata,status:sale.status,
        fulfillmentStatus:sale.fulfillment_status,version:Number(sale.version),paymentStatus,
        paymentReceivedMinor:paid,links:links.map((entry) => ({ kind:entry.kind,provider:entry.provider,reference:entry.reference,
          providerId:entry.provider_id,status:entry.status,amountMinor:entry.amount_minor === null ? null : Number(entry.amount_minor) })) };
    },
  },
  {
    name: 'lattis.commerce.sale.link', packageName: '@lattis/commerce', kind: 'command',
    action: 'commerce.sale.link', resourceType: 'sale', resourceId: (raw) => (raw as z.infer<typeof link>).saleId,
    input: link, output: linked,
    handler: async (context, raw) => {
      if (context.principal.kind !== 'service') throw new Error('Linking a sale requires a trusted service');
      const input = link.parse(raw);
      await context.db.lock(`commerce-link:${input.kind}:${input.provider}:${input.reference}`);
      const sale = (await context.db.query<{ sale_id: string }>('SELECT sale_id FROM lattis_commerce_sale WHERE sale_id=$1 FOR UPDATE', [input.saleId])).rows[0];
      if (!sale) throw new Error('Sale not found');
      const prior = (await context.db.query<LinkRow>('SELECT sale_id,kind,provider,reference,provider_id,status,amount_minor FROM lattis_commerce_link WHERE kind=$1 AND provider=$2 AND reference=$3 FOR UPDATE',
        [input.kind,input.provider,input.reference])).rows[0];
      if (prior && (prior.sale_id !== input.saleId || (prior.amount_minor !== null && input.amountMinor !== undefined && Number(prior.amount_minor) !== input.amountMinor)))
        throw new Error('Provider reference belongs to a different sale or amount');
      if (prior?.status === 'REFUNDED' && input.status !== 'REFUNDED') throw new Error('Refunded payment cannot be reopened');
      if (prior?.status === 'CONFIRMED' && input.kind === 'payment' && !['CONFIRMED','REFUNDED'].includes(input.status))
        throw new Error('Confirmed payment cannot be downgraded');
      if (prior?.status === 'ISSUED' && input.kind === 'invoice' && input.status !== 'ISSUED')
        throw new Error('Issued invoice cannot be downgraded');
      if (prior && prior.status === input.status && (input.providerId === undefined || prior.provider_id === input.providerId)
        && (input.amountMinor === undefined || Number(prior.amount_minor) === input.amountMinor))
        return { saleId:input.saleId,kind:input.kind,provider:input.provider,reference:input.reference,status:input.status };
      if (prior) {
        await context.db.query('UPDATE lattis_commerce_link SET provider_id=COALESCE($1,provider_id),status=$2,amount_minor=COALESCE($3,amount_minor),updated_at=$4 WHERE kind=$5 AND provider=$6 AND reference=$7',
          [input.providerId ?? null,input.status,input.amountMinor ?? null,new Date(),input.kind,input.provider,input.reference]);
      } else {
        await context.db.query('INSERT INTO lattis_commerce_link (sale_id,kind,provider,reference,provider_id,status,amount_minor) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [input.saleId,input.kind,input.provider,input.reference,input.providerId ?? null,input.status,input.amountMinor ?? null]);
      }
      await context.db.query('UPDATE lattis_commerce_sale SET version=version+1,updated_at=$1 WHERE sale_id=$2', [new Date(),input.saleId]);
      return { saleId:input.saleId,kind:input.kind,provider:input.provider,reference:input.reference,status:input.status };
    },
  },
  {
    name: 'lattis.commerce.sale.status', packageName: '@lattis/commerce', kind: 'command',
    action: 'commerce.sale.status', resourceType: 'sale', resourceId: (raw) => (raw as z.infer<typeof updateStatus>).saleId,
    input: updateStatus, output: updated,
    handler: async (context, raw) => {
      if (context.principal.kind !== 'service') throw new Error('Changing a sale requires a trusted service');
      const input = updateStatus.parse(raw);
      await context.db.lock(`commerce-sale:${input.saleId}`);
      const sale = (await context.db.query<SaleRow>('SELECT sale_id,currency,scale,total_minor,snapshot_sealed,snapshot_digest,status,fulfillment_status,version FROM lattis_commerce_sale WHERE sale_id=$1 FOR UPDATE', [input.saleId])).rows[0];
      if (!sale || Number(sale.version) !== input.expectedVersion) throw new Error('Sale version conflict');
      if (sale.status !== 'OPEN' && input.status && input.status !== sale.status) throw new Error('Sale status is final');
      if (input.status === 'CANCELLED') {
        const links = (await context.db.query<LinkRow>('SELECT sale_id,kind,provider,reference,provider_id,status,amount_minor FROM lattis_commerce_link WHERE sale_id=$1 FOR UPDATE', [input.saleId])).rows;
        if (received(links) > 0) throw new Error('Paid sale cannot be cancelled without refund handling');
      }
      const previousFulfillment = ['UNFULFILLED','PARTIAL','FULFILLED'].indexOf(sale.fulfillment_status);
      const nextFulfillment = input.fulfillmentStatus ?? sale.fulfillment_status;
      if (['UNFULFILLED','PARTIAL','FULFILLED'].indexOf(nextFulfillment) < previousFulfillment)
        throw new Error('Fulfillment cannot move backwards');
      const nextStatus = input.status ?? sale.status;
      const saved = await context.db.query('UPDATE lattis_commerce_sale SET status=$1,fulfillment_status=$2,version=version+1,updated_at=$3 WHERE sale_id=$4 AND version=$5',
        [nextStatus,nextFulfillment,new Date(),input.saleId,input.expectedVersion]);
      if (!saved.rowCount) throw new Error('Sale version conflict');
      return { saleId:input.saleId,status:nextStatus,fulfillmentStatus:nextFulfillment,version:Number(sale.version)+1 };
    },
  },
];
