import { readFileSync } from 'node:fs';

export const LATTIS_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
export const GEODE_CONTRACT_VERSION = 3;
