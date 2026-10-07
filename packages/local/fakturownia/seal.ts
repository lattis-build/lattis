import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function encryptionKey(encoded: string | undefined): Buffer {
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('FAKTUROWNIA_PII_KEY must be a Base64-encoded 32-byte key');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('Invalid FAKTUROWNIA_PII_KEY');
  return key;
}

export function seal(value: string, externalId: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(externalId));
  return `v1:${nonce.toString('base64url')}:${Buffer.concat([cipher.update(value,'utf8'),cipher.final()]).toString('base64url')}:${cipher.getAuthTag().toString('base64url')}`;
}

export function open(value: string, externalId: string, key: Buffer): string {
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid encrypted invoice payload');
  const nonce = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted invoice payload');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(externalId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')),decipher.final()]).toString('utf8');
}
