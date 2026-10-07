import { appDatabase, type AppClient, type AppDatabase } from 'lattis/app-db';
import { createInvoice, credentials, existingOid, FakturowniaHttpError, type FakturowniaCredentials } from './client.js';
import { request } from './contract.js';
import { encryptionKey, open } from './seal.js';

type InvoiceRow = { external_id: string; sale_id: string | null; payload_sealed: string; status: string; attempt_count: number };
type Outcome = { status: 'BLOCKED' | 'NEEDS_REVIEW' | 'ISSUED'; code: string | null; invoiceId: number | null; number: string | null };

async function record(client: AppClient, externalId: string, saleId: string | null, outcome: Outcome | { status: 'IN_FLIGHT'; code: null; invoiceId: null; number: null }, attempt: number): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('UPDATE lattis_fakturownia_invoice SET status=$1,last_error=$2,fakturownia_id=$3,invoice_number=$4,attempt_count=$5,attempted_at=$6,updated_at=$7 WHERE external_id=$8',
      [outcome.status,outcome.code,outcome.invoiceId,outcome.number,attempt,new Date(),new Date(),externalId]);
    if (saleId) {
      const sale = (await client.query('SELECT sale_id FROM lattis_commerce_sale WHERE sale_id=$1 FOR UPDATE', [saleId])).rows[0];
      if (!sale) throw new Error('Missing commerce sale');
      const link = (await client.query('SELECT 1 FROM lattis_commerce_link WHERE sale_id=$1 AND kind=$2 AND provider=$3 AND reference=$4',
        [saleId,'invoice','fakturownia',externalId])).rows[0];
      if (!link) throw new Error('Missing commerce invoice link');
      await client.query('UPDATE lattis_commerce_link SET status=$1,provider_id=COALESCE($2,provider_id),updated_at=$3 WHERE sale_id=$4 AND kind=$5 AND provider=$6 AND reference=$7',
        [outcome.status,outcome.invoiceId === null ? null : String(outcome.invoiceId),new Date(),saleId,'invoice','fakturownia',externalId]);
      await client.query('UPDATE lattis_commerce_sale SET version=version+1,updated_at=$1 WHERE sale_id=$2', [new Date(),saleId]);
    }
    await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)',
      ['system:fakturownia-worker','fakturownia.invoice.sync',externalId,outcome.status,externalId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

async function processOne(db: AppDatabase, cred: FakturowniaCredentials, key: Buffer, externalId: string): Promise<void> {
  const client = await db.connect();
  const lock = `fakturownia-invoice:${externalId}`;
  try {
    await client.lock(lock);
    const row = (await client.query<InvoiceRow>(
      'SELECT external_id,sale_id,payload_sealed,status,attempt_count FROM lattis_fakturownia_invoice WHERE external_id=$1', [externalId],
    )).rows[0];
    if (!row || row.status !== 'QUEUED') return;
    const attempt = Number(row.attempt_count) + 1;
    let input: ReturnType<typeof request.parse>;
    try { input = request.parse(JSON.parse(open(row.payload_sealed,externalId,key)) as unknown); }
    catch { await record(client,externalId,row.sale_id,{ status:'BLOCKED',code:'PAYLOAD_INVALID',invoiceId:null,number:null },attempt); return; }
    await record(client,externalId,row.sale_id,{ status:'IN_FLIGHT',code:null,invoiceId:null,number:null },attempt);
    let outcome: Outcome;
    try {
      const matches = await existingOid(cred, externalId);
      if (matches.length) outcome = { status:'NEEDS_REVIEW',code:'OID_EXISTS',invoiceId:null,number:null };
      else {
        try {
          const created = await createInvoice(cred,input);
          outcome = created.exact
            ? { status:'ISSUED',code:null,invoiceId:created.id,number:created.number }
            : { status:'NEEDS_REVIEW',code:'REMOTE_MISMATCH',invoiceId:created.id,number:created.number };
        } catch (error) {
          const blocked = error instanceof FakturowniaHttpError && [400,401,403].includes(error.status);
          outcome = { status:blocked ? 'BLOCKED' : 'NEEDS_REVIEW',
            code:blocked ? `HTTP_${error.status}` : 'POST_UNCERTAIN',invoiceId:null,number:null };
        }
      }
    } catch (error) {
      const blocked = error instanceof FakturowniaHttpError && [400,401,403,422].includes(error.status);
      outcome = { status:blocked ? 'BLOCKED' : 'NEEDS_REVIEW',
        code:blocked ? `HTTP_${error.status}` : 'PREFLIGHT_FAILED',invoiceId:null,number:null };
    }
    await record(client,externalId,row.sale_id,outcome,attempt);
  } finally { await client.unlock(lock).finally(() => client.release()); }
}

export async function runFakturowniaOnce(db: AppDatabase): Promise<number> {
  const cred = credentials();
  const key = encryptionKey(process.env.FAKTUROWNIA_PII_KEY);
  const rows = (await db.query<{ external_id: string }>(
    "SELECT external_id FROM lattis_fakturownia_invoice WHERE status='QUEUED' ORDER BY created_at LIMIT 25",
  )).rows;
  for (const row of rows) await processOne(db,cred,key,row.external_id);
  return rows.length;
}

if (process.argv[1] && /(?:^|[/\\])worker\.ts$/.test(process.argv[1])) {
  const url = process.env.APP_DATABASE_URL;
  if (!url) throw new Error('APP_DATABASE_URL is required');
  const db = appDatabase(url);
  try { process.stdout.write(`${JSON.stringify({ processed: await runFakturowniaOnce(db) })}\n`); }
  finally { await db.end(); }
}
