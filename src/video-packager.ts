import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { AppDatabase } from './app-db.js';
import { videoDirectory } from './video-transfer.js';

type Stream = { codec_type?: string; width?: number; height?: number };

function executable(name: string): string {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path to an approved executable`);
  return value;
}

function run(binary: string, args: string[], cwd: string, limitMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, limitMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 65_536) child.kill('SIGKILL');
    });
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8_192); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve(stdout);
      else reject(new Error(timedOut ? 'Video packaging timed out' : `Media tool exited with ${code}: ${stderr}`));
    });
  });
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || await realpath(path) !== path) throw new Error('Video package directory must be private');
}

/** Run only in the separate operator/worker process; never from an HTTP request. */
export async function packageClearCmaf(db: AppDatabase, videoId: string): Promise<{ packageId: string; formats: ('hls' | 'dash')[]; container: 'cmaf' }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(videoId)) throw new Error('Invalid video ID');
  const ffprobe = executable('LATTIS_FFPROBE_BIN');
  const ffmpeg = executable('LATTIS_FFMPEG_BIN');
  const packager = executable('LATTIS_SHAKA_PACKAGER_BIN');
  const directory = await videoDirectory();
  const packageRoot = join(directory, 'packages');
  await privateDirectory(packageRoot);
  const client = await db.connect();
  const lock = `video-package:${videoId}`;
  let work: string | undefined;
  let finalPath: string | undefined;
  try {
    await client.lock(lock);
    const video = (await client.query<{ state: string; storage_ref: string | null; protection_mode: string; watermark_mode: string }>(
      'SELECT state,storage_ref,protection_mode,watermark_mode FROM lattis_video WHERE id=$1', [videoId],
    )).rows[0];
    if (!video || video.state !== 'ready' || video.storage_ref !== `local:${videoId}`) throw new Error('Local video is not ready');
    if (video.protection_mode !== 'access-controlled' || video.watermark_mode !== 'off') throw new Error('Clear package is forbidden by video policy');
    if ((await client.query('SELECT 1 FROM lattis_video_package WHERE video_id=$1 AND protection=$2 AND state=$3', [videoId, 'clear', 'ready'])).rowCount) throw new Error('Clear CMAF package already exists');
    const source = join(directory, videoId);
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('Video source is not private');
    } finally { await handle.close(); }
    const packageId = randomUUID();
    work = await mkdtemp(join(packageRoot, '.work-'));
    const probe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', source], work, 60_000)) as { streams?: Stream[] };
    const videoStream = probe.streams?.find((stream) => stream.codec_type === 'video');
    const sourceHeight = videoStream?.height;
    if (typeof sourceHeight !== 'number' || !Number.isInteger(sourceHeight) || sourceHeight < 144 || sourceHeight > 4320) throw new Error('Unsupported video dimensions');
    const hasAudio = probe.streams?.some((stream) => stream.codec_type === 'audio') ?? false;
    const heights = [360, 720, 1080].filter((height) => height <= sourceHeight);
    if (!heights.length) heights.push(Math.floor(sourceHeight / 2) * 2);
    const renditions: { height: number; name: string }[] = [];
    process.umask(0o077);
    for (const height of heights) {
      const name = `video-${height}`;
      await privateDirectory(join(work, name));
      const rate = height <= 360 ? 900 : height <= 720 ? 2800 : 5000;
      await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', source,
        '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-sn', '-dn',
        '-vf', `scale=-2:${height}`, '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p',
        '-r', '30', '-g', '120', '-keyint_min', '120', '-sc_threshold', '0',
        '-crf', '22', '-maxrate', `${rate}k`, '-bufsize', `${rate * 2}k`,
        '-force_key_frames', 'expr:gte(t,n_forced*4)', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', '+faststart', join(work, `${name}.mp4`)], work, 4 * 60 * 60_000);
      renditions.push({ height, name });
    }
    const descriptors = renditions.map(({ name }) =>
      `in=${name}.mp4,stream=video,init_segment=${name}/init.mp4,segment_template=${name}/seg-$Number$.m4s,playlist_name=${name}/index.m3u8`);
    if (hasAudio) {
      await privateDirectory(join(work, 'audio'));
      descriptors.push(`in=${renditions[0].name}.mp4,stream=audio,init_segment=audio/init.mp4,segment_template=audio/seg-$Number$.m4s,playlist_name=audio/index.m3u8,hls_group_id=audio,hls_name=Default`);
    }
    await run(packager, [...descriptors, '--segment_duration', '4', '--generate_static_live_mpd',
      '--mpd_output', 'manifest.mpd', '--hls_playlist_type', 'VOD', '--hls_master_playlist_output', 'master.m3u8'], work, 60 * 60_000);
    for (const manifest of ['manifest.mpd', 'master.m3u8']) {
      if (!(await readFile(join(work, manifest))).length) throw new Error(`Empty ${manifest}`);
    }
    for (const { name } of renditions) await rm(join(work, `${name}.mp4`));
    finalPath = join(packageRoot, packageId);
    await rename(work, finalPath);
    work = undefined;
    await client.query('INSERT INTO lattis_video_package (id,video_id,container_format,protection,encryption_scheme,watermark,drm_provider_ref,watermark_provider_ref,storage_ref,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [packageId, videoId, 'cmaf', 'clear', null, 'off', null, null, `local:${packageId}`, 'ready']);
    finalPath = undefined;
    return { packageId, formats: ['hls', 'dash'], container: 'cmaf' };
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
    if (finalPath) await rm(finalPath, { recursive: true, force: true });
    await client.unlock(lock).finally(() => client.release());
  }
}
