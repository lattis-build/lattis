import type { Updater } from 'tuf-js';
export const OFFICIAL_GEODE: string;
export const OFFICIAL_UPDATES: string;
export function protectedFile(path: string, maximum?: number): Promise<Buffer>;
export function distributionClient(options: { stateDirectory: string; channel?: 'geode' | 'updates'; development?: boolean }): Promise<Updater>;
