#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
const envFile = resolve(process.cwd(), '.env');
const child = spawn(process.execPath, [...(existsSync(envFile) ? [`--env-file=${envFile}`] : []), '--import', loader, script, ...process.argv.slice(2)], {
  cwd: process.cwd(), env: process.env, stdio: 'inherit', shell: false,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
