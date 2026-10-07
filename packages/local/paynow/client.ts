import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';

const paymentId = z.string().regex(/^[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{3}){3}$/);
export const paynowStatus = z.enum(['NEW','PENDING','CONFIRMED','REJECTED','ERROR','EXPIRED','ABANDONED']);
const created = z.object({ paymentId, status: z.enum(['NEW','PENDING','ERROR']).default('NEW'), redirectUrl: z.string().url().optional() });
const current = z.object({ paymentId, status: paynowStatus });

export type PaynowCredentials = { apiKey: string; signatureKey: string; baseUrl: string };

export function credentials(): PaynowCredentials {
  const environment = process.env.PAYNOW_ENVIRONMENT;
  if (environment !== 'sandbox' && environment !== 'production') throw new Error('PAYNOW_ENVIRONMENT must be sandbox or production');
  const apiKey = process.env.PAYNOW_API_KEY;
  const signatureKey = process.env.PAYNOW_SIGNATURE_KEY;
  if (!apiKey || !signatureKey || /[\r\n]/.test(apiKey + signatureKey)) throw new Error('Paynow credentials are missing or invalid');
  return { apiKey, signatureKey, baseUrl: environment === 'production' ? 'https://api.paynow.pl' : 'https://api.sandbox.paynow.pl' };
}

export function signature(apiKey: string, signatureKey: string, idempotencyKey: string, body: string): string {
  const payload = JSON.stringify({ headers: { 'Api-Key': apiKey, 'Idempotency-Key': idempotencyKey }, parameters: {}, body });
  return createHmac('sha256', signatureKey).update(payload, 'utf8').digest('base64');
}

export class PaynowApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

async function limitedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty Paynow response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 65_536) { await reader.cancel(); throw new Error('Oversized Paynow response'); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) as unknown;
}

async function callPaynow(cred: PaynowCredentials, method: 'GET' | 'POST', path: string, idempotencyKey: string, body = ''): Promise<unknown> {
  const response = await fetch(cred.baseUrl + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(12_000),
    headers: {
      'Api-Key': cred.apiKey, 'Idempotency-Key': idempotencyKey,
      Signature: signature(cred.apiKey, cred.signatureKey, idempotencyKey, body),
      Accept: 'application/json', 'User-Agent': 'Lattis-Paynow/0.1',
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PaynowApiError(response.status, `Paynow API returned HTTP ${response.status}`);
  }
  return limitedJson(response);
}

export async function createPayment(cred: PaynowCredentials, input: {
  externalId: string; amountMinor: number; currency: 'PLN'; description: string; buyerEmail: string;
}): Promise<z.infer<typeof created>> {
  const body = JSON.stringify({ amount: input.amountMinor, currency: input.currency, externalId: input.externalId,
    description: input.description, buyer: { email: input.buyerEmail } });
  const result = created.parse(await callPaynow(cred, 'POST', '/v3/payments', input.externalId, body));
  if (result.redirectUrl) {
    const url = new URL(result.redirectUrl);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !(url.hostname === 'paynow.pl' || url.hostname.endsWith('.paynow.pl'))) throw new Error('Unexpected Paynow redirect origin');
  }
  return result;
}

export async function paymentStatus(cred: PaynowCredentials, id: string): Promise<z.infer<typeof current>> {
  const safeId = paymentId.parse(id);
  return current.parse(await callPaynow(cred, 'GET', `/v3/payments/${safeId}/status`, randomUUID()));
}
