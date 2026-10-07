import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDatabase } from './app-db.js';
import { ContentError } from './content.js';
import type { Principal } from './authorization.js';
import { encryptPlaybackAttribution } from './video-attribution.js';
import { videoMaxBytes } from './video-config.js';
import type { VideoPlaybackDescriptorV1, VideoPlaybackSource } from './video-contract.js';

type Permission = (request: FastifyRequest, reply: FastifyReply, action: string, resourceType: string, resourceId?: string) => Promise<Principal | null>;
type Origin = (request: FastifyRequest, reply: FastifyReply) => boolean;
type VideoRow = { id: string; title: string; mime_type: string; byte_count: string | number; content_sha256: string; storage_ref: string | null; state: string; download_ui: string; protection_mode: string; watermark_mode: string };
type VideoPackageRow = { id: string; video_id: string; container_format: string; protection: string; watermark: string; storage_ref: string; state: string };
const idParam = z.object({ id: z.uuid() });

export async function purgeOldVideoPlayback(db: AppDatabase): Promise<void> {
  const value = Number(process.env.LATTIS_VIDEO_PLAYBACK_RETENTION_DAYS ?? '30');
  if (!Number.isInteger(value) || value < 1 || value > 3650) throw new Error('LATTIS_VIDEO_PLAYBACK_RETENTION_DAYS must be 1–3650');
  await db.query('DELETE FROM lattis_video_playback WHERE expires_at<$1', [new Date(Date.now() - value * 86_400_000)]);
}

export async function videoDirectory(): Promise<string> {
  const configured = process.env.LATTIS_VIDEO_DIR;
  if (process.env.NODE_ENV === 'production' && !configured) throw new Error('LATTIS_VIDEO_DIR is required in production');
  const directory = resolve(configured ?? '.lattis/videos');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || await realpath(directory) !== directory) throw new Error('Video directory must be private and contain no symlinked path');
  return directory;
}

function rangeFor(value: unknown, length: number): { start: number; end: number; partial: boolean } | null {
  if (value === undefined) return { start: 0, end: length - 1, partial: false };
  if (typeof value !== 'string') return null;
  if (!value.startsWith('bytes=')) return { start: 0, end: length - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, length - suffix);
    end = length - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : length - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || end < start) return null;
    end = Math.min(end, length - 1);
  }
  return { start, end, partial: true };
}

export function registerVideoTransfer(app: FastifyInstance, db: AppDatabase, permission: Permission, sameOrigin: Origin): void {
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

  app.put('/api/videos/:id/file', { bodyLimit: videoMaxBytes(), onRequest: async (request, reply) => {
    if (!sameOrigin(request, reply)) return;
    const { id } = idParam.parse(request.params);
    if (!await permission(request, reply, 'video.manage', 'video', id)) return;
    if (request.headers['content-type'] !== 'application/octet-stream') return reply.code(415).send({ error: 'Use application/octet-stream' });
    const announced = request.headers['content-length'];
    if (announced !== undefined && Number(announced) > videoMaxBytes()) return reply.code(413).send({ error: 'Video exceeds upload limit' });
  } }, async (request, reply) => {
    if (!sameOrigin(request, reply)) return;
    const { id } = idParam.parse(request.params);
    const who = await permission(request, reply, 'video.manage', 'video', id);
    if (!who) return;
    if (request.headers['content-type'] !== 'application/octet-stream') return reply.code(415).send({ error: 'Use application/octet-stream' });
    const client = await db.connect();
    const lock = `video-upload:${id}`;
    const maxUpload = videoMaxBytes();
    let path: string | undefined;
    let createdFile = false;
    let inTransaction = false;
    try {
      await client.lock(lock);
      const row = (await client.query<VideoRow>('SELECT id,title,mime_type,byte_count,content_sha256,storage_ref,state,download_ui,protection_mode,watermark_mode FROM lattis_video WHERE id=$1', [id])).rows[0];
      if (!row) throw new ContentError(404, 'Video not found');
      if (row.state !== 'pending') throw new ContentError(409, 'Video is already uploaded');
      const expected = Number(row.byte_count);
      if (!Number.isSafeInteger(expected) || expected < 1 || expected > maxUpload) throw new ContentError(400, 'Invalid video length');
      const announced = request.headers['content-length'];
      if (announced !== undefined && (!/^\d+$/.test(announced) || Number(announced) !== expected)) throw new ContentError(400, 'Content-Length does not match video metadata');
      const directory = await videoDirectory();
      path = join(directory, id);
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      createdFile = true;
      const hash = createHash('sha256');
      let count = 0;
      let prefix = Buffer.alloc(0);
      const scanner = new Transform({ transform(chunk: Buffer, _encoding, done) {
        count += chunk.length;
        if (count > expected || count > maxUpload) return done(new ContentError(413, 'Video exceeds declared length'));
        if (prefix.length < 12) prefix = Buffer.concat([prefix, chunk.subarray(0, 12 - prefix.length)]);
        hash.update(chunk);
        done(null, chunk);
      } });
      try {
        await pipeline(request.body as Readable, scanner, file.createWriteStream({ autoClose: false }));
        await file.sync();
      } finally { await file.close(); }
      if (count !== expected || hash.digest('hex') !== row.content_sha256 || prefix.length < 12 || prefix.toString('ascii', 4, 8) !== 'ftyp') throw new ContentError(400, 'Video bytes do not match declared MP4 and SHA-256');
      await client.query('BEGIN');
      inTransaction = true;
      const changed = await client.query('UPDATE lattis_video SET storage_ref=$1,state=$2,updated_at=$3 WHERE id=$4 AND state=$5', [`local:${id}`,'ready',new Date(),id,'pending']);
      if (!changed.rowCount) throw new ContentError(409, 'Video upload state changed');
      await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [who.id,'video.upload',id,'allowed',request.id]);
      await client.query('COMMIT');
      inTransaction = false;
      path = undefined;
      createdFile = false;
      return reply.code(201).send({ id, ready: true });
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => {});
      if (path && createdFile) await unlink(path).catch(() => {});
      throw error;
    } finally { await client.unlock(lock).finally(() => client.release()); }
  });

  app.post('/api/videos/:id/playback', async (request, reply) => {
    if (!sameOrigin(request, reply)) return;
    const { id } = idParam.parse(request.params);
    const who = await permission(request, reply, 'video.play', 'video', id);
    if (!who) return;
    if (who.kind !== 'user') return reply.code(403).send({ error: 'Interactive user required' });
    const row = (await db.query<VideoRow>('SELECT id,title,mime_type,byte_count,content_sha256,storage_ref,state,download_ui,protection_mode,watermark_mode FROM lattis_video WHERE id=$1', [id])).rows[0];
    if (!row || row.state !== 'ready') return reply.code(404).send({ error: 'Video not available' });
    if (row.protection_mode === 'drm-required' || row.watermark_mode === 'forensic-required') return reply.code(501).send({ error: 'Required DRM or forensic watermark pipeline is not configured' });
    const mediaPackage = (await db.query<VideoPackageRow>('SELECT id,video_id,container_format,protection,watermark,storage_ref,state FROM lattis_video_package WHERE video_id=$1 AND state=$2 AND protection=$3 AND watermark=$4 ORDER BY created_at DESC', [id, 'ready', 'clear', 'off'])).rows[0];
    const userTable = db.dialect === 'postgres' ? '"user"' : '`user`';
    const user = (await db.query<{ name: string }>(`SELECT name FROM ${userTable} WHERE id=$1`, [who.id])).rows[0];
    const playbackId = randomUUID();
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const viewerIp = isIP(request.ip) ? request.ip : (request.raw.socket.remoteAddress ?? 'unknown');
    const attribution = encryptPlaybackAttribution(playbackId, id, who.id, (user?.name ?? '').slice(0, 191), viewerIp);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO lattis_video_playback (id,video_id,user_id,viewer_ciphertext,expires_at) VALUES ($1,$2,$3,$4,$5)', [playbackId,id,who.id,attribution,expiresAt]);
      await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [who.id,'video.playback.start',id,'allowed',request.id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { await client.release(); }
    reply.header('cache-control', 'no-store');
    const streamUrl = `/api/videos/${id}/stream?playbackId=${playbackId}`;
    const packageBase = mediaPackage?.container_format === 'cmaf' && mediaPackage.storage_ref === `local:${mediaPackage.id}`
      ? `/api/videos/${id}/playback/${playbackId}/packages/${mediaPackage.id}` : null;
    const sources: VideoPlaybackSource[] = [
      ...(packageBase ? [
        { kind: 'hls' as const, url: `${packageBase}/master.m3u8`, mimeType: 'application/vnd.apple.mpegurl', container: 'cmaf' as const },
        { kind: 'dash' as const, url: `${packageBase}/manifest.mpd`, mimeType: 'application/dash+xml', container: 'cmaf' as const },
      ] : []),
      { kind: 'progressive', url: streamUrl, mimeType: row.mime_type, container: 'mp4' },
    ];
    const descriptor: VideoPlaybackDescriptorV1 = {
      contractVersion: 1, playbackId, streamUrl, expiresAt: expiresAt.toISOString(), mimeType: row.mime_type,
      title: row.title, downloadUi: row.download_ui === 'show' ? 'show' : 'hide', sources,
      protection: { mode: 'access-controlled', drmSystems: [] },
      watermark: { mode: 'off' },
    };
    return descriptor;
  });

  app.get('/api/videos/:id/playback/:playbackId/packages/:packageId/*', async (request, reply) => {
    const params = z.object({ id: z.uuid(), playbackId: z.uuid(), packageId: z.uuid(), '*': z.string() }).parse(request.params);
    const relative = params['*'];
    if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:m3u8|mpd|mp4|m4s)$/.test(relative) || relative.length > 200) return reply.code(404).send({ error: 'Package file not found' });
    const who = await permission(request, reply, 'video.play', 'video', params.id);
    if (!who) return;
    if (who.kind !== 'user') return reply.code(403).send({ error: 'Interactive user required' });
    const playback = await db.query('SELECT 1 FROM lattis_video_playback WHERE id=$1 AND video_id=$2 AND user_id=$3 AND expires_at>$4', [params.playbackId, params.id, who.id, new Date()]);
    if (!playback.rowCount) return reply.code(404).send({ error: 'Playback session expired or unavailable' });
    const video = (await db.query<VideoRow>('SELECT id,title,mime_type,byte_count,content_sha256,storage_ref,state,download_ui,protection_mode,watermark_mode FROM lattis_video WHERE id=$1', [params.id])).rows[0];
    const mediaPackage = (await db.query<VideoPackageRow>('SELECT id,video_id,container_format,protection,watermark,storage_ref,state FROM lattis_video_package WHERE id=$1 AND video_id=$2', [params.packageId, params.id])).rows[0];
    if (!video || video.state !== 'ready' || video.protection_mode !== 'access-controlled' || video.watermark_mode !== 'off'
      || !mediaPackage || mediaPackage.state !== 'ready' || mediaPackage.container_format !== 'cmaf'
      || mediaPackage.protection !== 'clear' || mediaPackage.watermark !== 'off' || mediaPackage.storage_ref !== `local:${params.packageId}`) {
      return reply.code(404).send({ error: 'Package not available' });
    }
    const directory = join(await videoDirectory(), 'packages', params.packageId);
    let directoryInfo: Awaited<ReturnType<typeof lstat>>;
    try { directoryInfo = await lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'Package not found' }); throw error; }
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077) !== 0 || await realpath(directory) !== directory) throw new ContentError(500, 'Package storage mismatch');
    const filePath = join(directory, relative);
    try { if (await realpath(dirname(filePath)) !== dirname(filePath)) throw new ContentError(500, 'Package storage mismatch'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'Package file not found' }); throw error; }
    let file: FileHandle;
    try { file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'Package file not found' }); throw error; }
    let handedToStream = false;
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0) throw new ContentError(500, 'Package storage mismatch');
      const mimeType = relative.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
        : relative.endsWith('.mpd') ? 'application/dash+xml'
          : relative.startsWith('audio/') ? 'audio/mp4' : 'video/mp4';
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');
      reply.header('referrer-policy', 'no-referrer');
      reply.header('content-length', String(info.size));
      if (request.method === 'HEAD') return reply.type(mimeType).send();
      handedToStream = true;
      return reply.type(mimeType).send(file.createReadStream({ autoClose: true }));
    } finally { if (!handedToStream) await file.close(); }
  });

  app.get('/api/videos/:id/stream', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { playbackId } = z.object({ playbackId: z.uuid() }).parse(request.query);
    const who = await permission(request, reply, 'video.play', 'video', id);
    if (!who) return;
    if (who.kind !== 'user') return reply.code(403).send({ error: 'Interactive user required' });
    const playback = await db.query('SELECT 1 FROM lattis_video_playback WHERE id=$1 AND video_id=$2 AND user_id=$3 AND expires_at>$4', [playbackId,id,who.id,new Date()]);
    if (!playback.rowCount) return reply.code(404).send({ error: 'Playback session expired or unavailable' });
    const row = (await db.query<VideoRow>('SELECT id,title,mime_type,byte_count,content_sha256,storage_ref,state,download_ui,protection_mode,watermark_mode FROM lattis_video WHERE id=$1', [id])).rows[0];
    if (!row || row.state !== 'ready' || row.protection_mode !== 'access-controlled' || row.watermark_mode !== 'off' || row.storage_ref !== `local:${id}`) return reply.code(404).send({ error: 'Video not available' });
    const directory = await videoDirectory();
    let file: FileHandle;
    try { file = await open(join(directory,id), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'Video not found' }); throw error; }
    let handedToStream = false;
    try {
      const info = await file.stat();
      const length = Number(row.byte_count);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size !== length || length < 1) throw new ContentError(500, 'Video storage mismatch');
      const range = rangeFor(request.headers.range, length);
      reply.header('accept-ranges', 'bytes');
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');
      reply.header('content-disposition', 'inline');
      reply.header('referrer-policy', 'no-referrer');
      if (!range) {
        reply.header('content-range', `bytes */${length}`);
        return reply.code(416).send();
      }
      reply.header('content-length', String(range.end - range.start + 1));
      if (range.partial) { reply.code(206); reply.header('content-range', `bytes ${range.start}-${range.end}/${length}`); }
      if (request.method === 'HEAD') return reply.type(row.mime_type).send();
      const stream = file.createReadStream({ start: range.start, end: range.end, autoClose: true });
      handedToStream = true;
      return reply.type(row.mime_type).send(stream);
    } finally { if (!handedToStream) await file.close(); }
  });
}
