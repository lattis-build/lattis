import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key(): Buffer {
  const value = process.env.LATTIS_VIDEO_ATTRIBUTION_KEY;
  if (!value || !/^[A-Za-z0-9+\/]{43}=$/.test(value)) throw new Error('LATTIS_VIDEO_ATTRIBUTION_KEY must be 32 random bytes encoded as base64');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) throw new Error('Invalid LATTIS_VIDEO_ATTRIBUTION_KEY');
  return decoded;
}

function aad(playbackId: string, videoId: string, userId: string): Buffer {
  return Buffer.from(`${playbackId}\n${videoId}\n${userId}`);
}

export function encryptPlaybackAttribution(playbackId: string, videoId: string, userId: string, name: string, ip: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(aad(playbackId, videoId, userId));
  const data = Buffer.concat([cipher.update(JSON.stringify({ name, ip }), 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
}

export function decryptPlaybackAttribution(playbackId: string, videoId: string, userId: string, encrypted: string): { name: string; ip: string } {
  if (!encrypted.startsWith('v1:')) throw new Error('Unknown video attribution envelope');
  const packed = Buffer.from(encrypted.slice(3), 'base64');
  if (packed.length < 29) throw new Error('Invalid video attribution envelope');
  const decipher = createDecipheriv('aes-256-gcm', key(), packed.subarray(0, 12));
  decipher.setAAD(aad(playbackId, videoId, userId));
  decipher.setAuthTag(packed.subarray(12, 28));
  const value = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || !('name' in value) || !('ip' in value) || typeof value.name !== 'string' || typeof value.ip !== 'string') throw new Error('Invalid video attribution payload');
  return { name: value.name, ip: value.ip };
}
