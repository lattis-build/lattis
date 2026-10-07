import { z } from 'zod';
import { grossMinor, money, type InvoiceRequest } from './contract.js';

const identifier = z.union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/).transform(Number)]);
const remoteInvoice = z.object({
  id: identifier, oid: z.string().nullable().optional(), number: z.string().nullable().optional(),
  price_gross: z.union([z.string(), z.number()]).nullable().optional(),
}).passthrough();

export type FakturowniaCredentials = { origin: string; token: string };

export function credentials(): FakturowniaCredentials {
  const account = process.env.FAKTUROWNIA_ACCOUNT;
  const token = process.env.FAKTUROWNIA_API_TOKEN;
  if (!account || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(account)) throw new Error('Invalid FAKTUROWNIA_ACCOUNT');
  if (!token || /[\r\n]/.test(token)) throw new Error('Missing or invalid FAKTUROWNIA_API_TOKEN');
  return { origin: `https://${account}.fakturownia.pl`, token };
}

export class FakturowniaHttpError extends Error {
  constructor(public readonly status: number) { super(`Fakturownia returned HTTP ${status}`); }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty Fakturownia response');
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 262_144) { await reader.cancel(); throw new Error('Oversized Fakturownia response'); }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function fetchJson(cred: FakturowniaCredentials, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(cred.origin + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
    headers: { Accept: 'application/json', Authorization: `Bearer ${cred.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new FakturowniaHttpError(response.status); }
  return boundedJson(response);
}

export async function existingOid(cred: FakturowniaCredentials, oid: string): Promise<number[]> {
  const params = new URLSearchParams({ oid, period: 'all', per_page: '100', page: '1' });
  const raw = await fetchJson(cred, `/invoices.json?${params}`);
  const invoices = z.array(remoteInvoice).parse(raw);
  if (invoices.length >= 100) throw new Error('OID search result requires manual review');
  return invoices.filter((invoice) => invoice.oid === oid).map((invoice) => invoice.id);
}

function remoteGrossMinor(raw: string | number | null | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).replace(',', '.');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const minor = Number(BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')));
  return Number.isSafeInteger(minor) ? minor : null;
}

export async function createInvoice(cred: FakturowniaCredentials, input: InvoiceRequest): Promise<{ id: number; number: string | null; exact: boolean }> {
  const buyer = input.buyer.kind === 'existing'
    ? { client_id: input.buyer.clientId }
    : { buyer_name: input.buyer.name, buyer_email: input.buyer.email, buyer_tax_no: input.buyer.taxNo,
        buyer_street: input.buyer.street, buyer_city: input.buyer.city, buyer_post_code: input.buyer.postCode,
        buyer_country: input.buyer.country };
  const amount = grossMinor(input);
  const invoice = {
    kind: 'vat', oid: input.externalId, oid_unique: 'yes', department_id: input.departmentId,
    issue_date: input.issueDate, sell_date: input.sellDate, currency: 'PLN',
    status: input.requireConfirmedPaynow ? 'paid' : 'issued',
    ...(input.requireConfirmedPaynow ? { paid: money(amount) } : {}),
    ...buyer,
    positions: input.positions.map((position) => ({ name: position.name, quantity: position.quantity,
      tax: position.tax, total_price_gross: money(position.totalGrossMinor) })),
  };
  const result = remoteInvoice.parse(await fetchJson(cred, '/invoices.json', { api_token: cred.token, invoice }));
  return { id: result.id, number: result.number ?? null,
    exact: result.oid === input.externalId && remoteGrossMinor(result.price_gross) === amount };
}
