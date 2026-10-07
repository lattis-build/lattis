/** Player-neutral response from POST /api/videos/{id}/playback. */
export type VideoPlaybackSource = {
  kind: 'hls' | 'dash' | 'progressive';
  url: string;
  mimeType: string;
  container: 'cmaf' | 'mp4';
};

export type VideoDrmSystem = {
  keySystem: string;
  licenseUrl: string;
  certificateUrl?: string;
};

export type VideoPlaybackDescriptorV1 = {
  contractVersion: 1;
  playbackId: string;
  expiresAt: string;
  title: string;
  downloadUi: 'show' | 'hide';
  sources: VideoPlaybackSource[];
  protection: { mode: 'access-controlled'; drmSystems: [] }
    | { mode: 'drm-required'; drmSystems: VideoDrmSystem[] };
  watermark: { mode: 'off' } | { mode: 'forensic'; sessionRef: string };
  /** Compatibility alias for the original progressive-only component; absent for protected packages. */
  streamUrl?: string;
  mimeType?: string;
};
