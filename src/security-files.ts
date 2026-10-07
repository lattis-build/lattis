import { constants } from 'node:fs';
import { open, mkdir, rename, unlink, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export function relativePath(value: string): string {
  if (!value || value.length > 512 || value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9@_.-]+$/.test(part))) throw new Error('Invalid relative path');
  return value;
}

export async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('File unavailable or too large');
    const bytes = await file.readFile();
    if (bytes.length > limit) throw new Error('File too large');
    return bytes;
  } finally { await file.close(); }
}

export async function insideFile(root: string, name: string, limit: number): Promise<Buffer> {
  relativePath(name);
  const base = await realpath(root);
  let current = base;
  for (const part of name.split('/')) {
    current = resolve(current, part);
    if (!current.startsWith(base + sep) || (await lstat(current)).isSymbolicLink()) throw new Error('Symlinks are forbidden in releases');
  }
  return boundedFile(current, limit);
}

export async function atomicFile(path: string, content: string | Buffer, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', mode);
  try { await file.writeFile(content); await file.sync(); }
  catch (error) { await file.close(); await unlink(temporary).catch(() => {}); throw error; }
  await file.close();
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function exclusive<T>(path: string, work: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await open(path, 'wx', 0o600).catch(() => { throw new Error('Operation locked; a crashed operation requires explicit operator recovery'); });
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await lock.sync(); return await work(); }
  finally { await lock.close(); await unlink(path); }
}

export async function boundedResponse(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`Remote service returned ${response.status}`);
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) { await response.body.cancel(); throw new Error('Remote response too large'); }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > limit) throw new Error('Remote response too large');
      parts.push(item.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(parts);
}
