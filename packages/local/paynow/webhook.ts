import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appDatabase, type AppDatabase } from 'lattis/app-db';
import { z } from 'zod';
import { paynowStatus } from './client.js';

const maxBodyBytes = 16_384;
const notification = z.object({
  paymentId: z.string().regex(/^[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{3}){3}$/),
  externalId: z.uuid(),
  status: paynowStatus,
  modifiedAt: z.string().min(19).max(40),
}).passthrough();

type Payment = { paynow_payment_id: string | null; sale_id: string | null; status: string; provider_modified_at: Date | string | null };

function reply(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'Content-Length': '0', 'Cache-Control': 'no-store' });
  response.end();
}

function validSignature(raw: Buffer, supplied: string | undefined, key: string): boolean {
  if (!supplied || !/^[A-Za-z0-9+/]{43}=$/.test(supplied)) return false;
  const actual = Buffer.from(supplied, 'base64');
  const expected = createHmac('sha256', key).update(raw).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function timestamp(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return null;
  // Paynow also sends timestamps without an offset; persist those consistently as UTC.
  const parsed = new Date(value.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function readRaw(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBodyBytes) throw new RangeError('Oversized notification');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function persist(db: AppDatabase, event: z.infer<typeof notification>, modifiedAt: Date): Promise<boolean> {
  const client = await db.connect();
  const lock = `paynow-payment:${event.externalId}`;
  try {
    await client.lock(lock);
    await client.query('BEGIN');
    try {
      const row = (await client.query<Payment>('SELECT paynow_payment_id,sale_id,status,provider_modified_at FROM lattis_paynow_payment WHERE external_id=$1', [event.externalId])).rows[0];
      if (!row) { await client.query('ROLLBACK'); return false; }
      const previous = row.provider_modified_at ? new Date(row.provider_modified_at).getTime() : -Infinity;
      const newer = modifiedAt.getTime() > previous;
      const newPayment = event.paymentId !== row.paynow_payment_id;
      if (row.status !== 'CONFIRMED' && (event.status === 'CONFIRMED' || newer || (newPayment && modifiedAt.getTime() === previous))) {
        await client.query('UPDATE lattis_paynow_payment SET redirect_url=CASE WHEN paynow_payment_id=$1 THEN redirect_url ELSE NULL END,paynow_payment_id=$1,status=$2,provider_modified_at=$3,next_attempt_at=$4,last_error=$5,updated_at=$6 WHERE external_id=$7',
          [event.paymentId,event.status,modifiedAt,new Date(Date.now() + 30_000),null,new Date(),event.externalId]);
        if (row.sale_id) {
          const sale = (await client.query('SELECT sale_id FROM lattis_commerce_sale WHERE sale_id=$1 FOR UPDATE', [row.sale_id])).rows[0];
          if (!sale) throw new Error('Missing commerce sale');
          const link = (await client.query('SELECT 1 FROM lattis_commerce_link WHERE sale_id=$1 AND kind=$2 AND provider=$3 AND reference=$4',
            [row.sale_id,'payment','paynow',event.externalId])).rows[0];
          if (!link) throw new Error('Missing commerce payment link');
          await client.query('UPDATE lattis_commerce_link SET status=$1,provider_id=$2,updated_at=$3 WHERE sale_id=$4 AND kind=$5 AND provider=$6 AND reference=$7',
            [event.status,event.paymentId,new Date(),row.sale_id,'payment','paynow',event.externalId]);
          await client.query('UPDATE lattis_commerce_sale SET version=version+1,updated_at=$1 WHERE sale_id=$2', [new Date(),row.sale_id]);
        }
        await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)',
          ['system:paynow-webhook','paynow.notification.accepted',event.externalId,event.status,event.externalId]);
      }
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  } finally { await client.unlock(lock).finally(() => client.release()); }
}

export function paynowWebhookHandler(db: AppDatabase, signatureKey: string) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.url !== '/paynow/notifications') { reply(response, 404); return; }
    if (request.method !== 'POST') { reply(response, 405); return; }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] ?? '')) { reply(response, 415); return; }
    const announced = Number(request.headers['content-length'] ?? 0);
    if (!Number.isSafeInteger(announced) || announced > maxBodyBytes || announced < 0) { reply(response, 413); return; }
    let raw: Buffer;
    try { raw = await readRaw(request); }
    catch (error) { reply(response, error instanceof RangeError ? 413 : 400); return; }
    const header = request.headers.signature;
    if (!validSignature(raw, typeof header === 'string' ? header : undefined, signatureKey)) { reply(response, 401); return; }
    let event: z.infer<typeof notification>;
    try { event = notification.parse(JSON.parse(raw.toString('utf8')) as unknown); }
    catch { reply(response, 400); return; }
    const modifiedAt = timestamp(event.modifiedAt);
    if (!modifiedAt) { reply(response, 400); return; }
    try { reply(response, await persist(db, event, modifiedAt) ? 202 : 503); }
    catch { reply(response, 503); }
  };
}

if (process.argv[1] && /(?:^|[/\\])webhook\.ts$/.test(process.argv[1])) {
  const url = process.env.APP_DATABASE_URL;
  const signatureKey = process.env.PAYNOW_SIGNATURE_KEY;
  if (!url || !signatureKey) throw new Error('APP_DATABASE_URL and PAYNOW_SIGNATURE_KEY are required');
  const port = Number(process.env.PAYNOW_WEBHOOK_PORT ?? '4110');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid PAYNOW_WEBHOOK_PORT');
  const db = appDatabase(url);
  const server = createServer(paynowWebhookHandler(db, signatureKey));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(port, process.env.PAYNOW_WEBHOOK_HOST ?? '127.0.0.1');
  const shutdown = () => server.close(() => { void db.end(); });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
