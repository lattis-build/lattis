import { request } from 'node:http';
import { lstat } from 'node:fs/promises';
import { protectedFile } from '../updater/lib/tuf-client.mjs';
import { installationPolicySchema } from './release-contract.js';
import { INSTALLATION_POLICY_PATH } from './production-release.js';
import { digest } from './manifest.js';
import type { Expression } from './extension-contract.js';

export async function evaluateExpression(expression: Expression, input: unknown, results: Record<string, unknown>): Promise<unknown> {
  let socketPath = process.env.LATTIS_RUNNER_SOCKET ?? '/run/lattis-runner/runner.sock';
  if (process.env.NODE_ENV === 'production') {
    const policy = installationPolicySchema.parse(JSON.parse((await protectedFile(INSTALLATION_POLICY_PATH)).toString('utf8')));
    if (!policy.runner) throw new Error('Protected data-only runner policy required');
    if (digest(await protectedFile(policy.runner.executablePath)) !== policy.runner.digest) throw new Error('Runner executable differs from protected policy');
    socketPath = policy.runner.socketPath;
    const socket = await lstat(socketPath), parent = await lstat(socketPath.slice(0, socketPath.lastIndexOf('/')));
    if (!socket.isSocket() || socket.uid === process.getuid?.() || (socket.mode & 0o007) || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid === process.getuid?.() || (parent.mode & 0o022)) throw new Error('Runner socket requires a separate protected account and directory');
  }
  const payload = JSON.stringify({ expression, input, results });
  if (Buffer.byteLength(payload) > 262144) throw new Error('Runner request exceeds limit');
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/evaluate', method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (response) => {
      const chunks: Buffer[] = []; let length = 0;
      response.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 262144) response.destroy(new Error('Runner response exceeds limit')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('Runner rejected expression');
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'value')) throw new Error('Invalid runner response');
          resolve(parsed.value);
        } catch (error) { reject(error); }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error('Runner deadline exceeded')), 5000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end(payload);
  });
}
