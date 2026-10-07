import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ContentError } from './content.js';
import type { NodeDefinition } from './runtime.js';
import { videoHardMaxBytes, videoMaxBytes } from './video-config.js';

const id = z.uuid();
const policy = z.object({
  downloadUi: z.enum(['show', 'hide']).default('hide'),
  protectionMode: z.enum(['access-controlled', 'drm-required']).default('access-controlled'),
  watermarkMode: z.enum(['off', 'forensic-required']).default('off'),
});
const create = z.object({
  title: z.string().trim().min(1).max(500),
  mimeType: z.literal('video/mp4'),
  byteCount: z.number().int().positive().max(videoHardMaxBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).extend(policy.shape).strict();
const update = z.object({
  id,
  downloadUi: z.enum(['show', 'hide']),
  protectionMode: z.enum(['access-controlled', 'drm-required']),
  watermarkMode: z.enum(['off', 'forensic-required']),
}).strict();

export function videoNodes(): NodeDefinition[] {
  return [
    {
      name: 'lattis.video.create', packageName: '@lattis/video', kind: 'command', action: 'video.manage', resourceType: 'video',
      resourceId: () => '*', input: create, output: z.object({ id, uploadUrl: z.string() }).strict(),
      handler: async (context, raw) => {
        const input = create.parse(raw);
        if (input.byteCount > videoMaxBytes()) throw new ContentError(413, 'Video exceeds configured upload limit');
        const videoId = randomUUID();
        await context.db.query('INSERT INTO lattis_video (id,title,mime_type,byte_count,content_sha256,state,download_ui,protection_mode,watermark_mode,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [videoId,input.title,input.mimeType,input.byteCount,input.sha256,'pending',input.downloadUi,input.protectionMode,input.watermarkMode,context.principal.id]);
        return { id: videoId, uploadUrl: `/api/videos/${videoId}/file` };
      },
    },
    {
      name: 'lattis.video.get', packageName: '@lattis/video', kind: 'query', action: 'video.play', resourceType: 'video',
      resourceId: (raw) => (raw as { id: string }).id, input: z.object({ id }).strict(),
      output: z.object({ id, title: z.string(), mimeType: z.string(), byteCount: z.number(), ready: z.boolean(), downloadUi: z.string(), protectionMode: z.string(), watermarkMode: z.string(), playbackUrl: z.string() }).strict(),
      handler: async (context, raw) => {
        const input = z.object({ id }).strict().parse(raw);
        const row = (await context.db.query<{ id: string; title: string; mime_type: string; byte_count: string | number; state: string; download_ui: string; protection_mode: string; watermark_mode: string }>('SELECT id,title,mime_type,byte_count,state,download_ui,protection_mode,watermark_mode FROM lattis_video WHERE id=$1', [input.id])).rows[0];
        if (!row) throw new ContentError(404, 'Video not found');
        return { id: row.id, title: row.title, mimeType: row.mime_type, byteCount: Number(row.byte_count), ready: row.state === 'ready', downloadUi: row.download_ui, protectionMode: row.protection_mode, watermarkMode: row.watermark_mode, playbackUrl: `/api/videos/${row.id}/playback` };
      },
    },
    {
      name: 'lattis.video.policy.update', packageName: '@lattis/video', kind: 'command', action: 'video.manage', resourceType: 'video',
      resourceId: (raw) => (raw as { id: string }).id, input: update,
      output: z.object({ id, downloadUi: z.string(), protectionMode: z.string(), watermarkMode: z.string() }).strict(),
      handler: async (context, raw) => {
        const input = update.parse(raw);
        const changed = await context.db.query('UPDATE lattis_video SET download_ui=$1,protection_mode=$2,watermark_mode=$3,updated_at=$4 WHERE id=$5', [input.downloadUi,input.protectionMode,input.watermarkMode,new Date(),input.id]);
        if (!changed.rowCount) throw new ContentError(404, 'Video not found');
        return { id: input.id, downloadUi: input.downloadUi, protectionMode: input.protectionMode, watermarkMode: input.watermarkMode };
      },
    },
  ];
}
