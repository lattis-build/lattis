export const videoHardMaxBytes = 107_374_182_400;

export function videoMaxBytes(): number {
  const value = Number(process.env.LATTIS_VIDEO_MAX_BYTES ?? '2147483648');
  if (!Number.isSafeInteger(value) || value < 1 || value > videoHardMaxBytes) throw new Error('LATTIS_VIDEO_MAX_BYTES must be a positive integer at most 100 GiB');
  return value;
}
