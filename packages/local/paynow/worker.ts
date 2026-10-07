import { appDatabase, type AppClient, type AppDatabase } from 'lattis/app-db';
import { createPayment, credentials, paymentStatus, PaynowApiError, type PaynowCredentials } from './client.js';
import { openEmail, piiKey } from './pii.js';

type Payment = {
  external_id: string; amount_minor: string | number; currency: 'PLN'; description: string; buyer_email_sealed: string;
  paynow_payment_id: string | null; sale_id: string | null; status: string; attempt_count: number;
};

function retryAt(attempt: number): Date {
  return new Date(Date.now() + Math.min(15 * 60_000, 15_000 * 2 ** Math.min(attempt, 6)));
}

async function audit(client: AppClient, id: string, result: string): Promise<void> {
  await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)',
    ['system:paynow-worker','paynow.payment.sync',id,result,id]);
}

async function processOne(db: AppDatabase, cred: PaynowCredentials, key: Buffer, externalId: string): Promise<void> {
  const client = await db.connect();
  const lock = `paynow-payment:${externalId}`;
  try {
    await client.lock(lock);
    const row = (await client.query<Payment>('SELECT external_id,amount_minor,currency,description,buyer_email_sealed,paynow_payment_id,sale_id,status,attempt_count FROM lattis_paynow_payment WHERE external_id=$1', [externalId])).rows[0];
    if (!row || !['QUEUED','UNKNOWN','NEW','PENDING'].includes(row.status)) return;
    const attempt = Number(row.attempt_count) + 1;
    let paymentId = row.paynow_payment_id;
    let redirectUrl: string | null = null;
    let nextStatus = row.status;
    let lastError: string | null = null;
    let auditResult: string | null = null;
    try {
      if (!row.paynow_payment_id) {
        const created = await createPayment(cred, { externalId, amountMinor: Number(row.amount_minor), currency: row.currency,
          description: row.description, buyerEmail: openEmail(row.buyer_email_sealed,externalId,key) });
        paymentId = created.paymentId;
        redirectUrl = created.redirectUrl ?? null;
        nextStatus = created.status;
        auditResult = created.status;
      } else {
        const current = await paymentStatus(cred, row.paynow_payment_id);
        if (current.paymentId !== row.paynow_payment_id) throw new Error('Paynow payment ID mismatch');
        nextStatus = current.status;
        if (current.status !== row.status) auditResult = current.status;
      }
    } catch (error) {
      const permanent = error instanceof PaynowApiError && [400,401,403,404,422].includes(error.status);
      nextStatus = permanent ? 'BLOCKED' : row.paynow_payment_id ? row.status : 'UNKNOWN';
      lastError = permanent ? `HTTP_${error.status}` : 'RETRY_REQUIRED';
      if (permanent) auditResult = 'blocked';
    }
    await client.query('BEGIN');
    try {
      await client.query('UPDATE lattis_paynow_payment SET paynow_payment_id=$1,redirect_url=COALESCE($2,redirect_url),status=$3,attempt_count=$4,next_attempt_at=$5,last_error=$6,updated_at=$7 WHERE external_id=$8',
        [paymentId,redirectUrl,nextStatus,attempt,retryAt(attempt),lastError,new Date(),externalId]);
      if (row.sale_id && (nextStatus !== row.status || paymentId !== row.paynow_payment_id)) {
        const sale = (await client.query('SELECT sale_id FROM lattis_commerce_sale WHERE sale_id=$1 FOR UPDATE', [row.sale_id])).rows[0];
        if (!sale) throw new Error('Missing commerce sale');
        const link = (await client.query('SELECT 1 FROM lattis_commerce_link WHERE sale_id=$1 AND kind=$2 AND provider=$3 AND reference=$4',
          [row.sale_id,'payment','paynow',externalId])).rows[0];
        if (!link) throw new Error('Missing commerce payment link');
        await client.query('UPDATE lattis_commerce_link SET status=$1,provider_id=COALESCE($2,provider_id),updated_at=$3 WHERE sale_id=$4 AND kind=$5 AND provider=$6 AND reference=$7',
          [nextStatus,paymentId,new Date(),row.sale_id,'payment','paynow',externalId]);
        await client.query('UPDATE lattis_commerce_sale SET version=version+1,updated_at=$1 WHERE sale_id=$2', [new Date(),row.sale_id]);
      }
      if (auditResult) await audit(client, externalId, auditResult);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  } finally { await client.unlock(lock).finally(() => client.release()); }
}

export async function runPaynowOnce(db: AppDatabase): Promise<number> {
  const cred = credentials();
  const key = piiKey(process.env.PAYNOW_PII_KEY);
  const rows = (await db.query<{ external_id: string }>(
    "SELECT external_id FROM lattis_paynow_payment WHERE next_attempt_at<=$1 AND status IN ('QUEUED','UNKNOWN','NEW','PENDING') ORDER BY next_attempt_at LIMIT 25", [new Date()],
  )).rows;
  for (const row of rows) await processOne(db, cred, key, row.external_id);
  return rows.length;
}

if (process.argv[1] && /(?:^|[/\\])worker\.ts$/.test(process.argv[1])) {
  const url = process.env.APP_DATABASE_URL;
  if (!url) throw new Error('APP_DATABASE_URL is required');
  const db = appDatabase(url);
  try { process.stdout.write(`${JSON.stringify({ processed: await runPaynowOnce(db) })}\n`); }
  finally { await db.end(); }
}
