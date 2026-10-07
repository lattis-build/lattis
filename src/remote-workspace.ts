import { prohibitProductionMutation } from './production-release.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const defaultRoots = ['extensions', 'packages/local', 'src', 'web', 'docs', 'migrations', 'lattis.config.json', 'package.json', 'tsconfig.json'];
const writableExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.css', '.html', '.sql', '.yaml', '.yml', '.svg']);
const changing = new Set<string>();

export class WorkspaceError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function segments(value: string): string[] {
  if (!value || value.startsWith('/') || value.includes('\\') || value.length > 500) throw new WorkspaceError(400, 'Invalid relative path');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || !/^[a-zA-Z0-9_@ -][a-zA-Z0-9_@ .-]*$/.test(part)))
    throw new WorkspaceError(400, 'Invalid relative path');
  return parts;
}

function configuredRoots(): string[] {
  const roots = (process.env.LATTIS_MCP_EDIT_ROOTS ?? defaultRoots.join(',')).split(',').map((item) => item.trim()).filter(Boolean);
  if (!roots.length) throw new Error('LATTIS_MCP_EDIT_ROOTS is empty');
  for (const root of roots) segments(root);
  return roots;
}

function permitted(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

async function location(workspace: string, path: string, roots: string[], mustExist: boolean): Promise<string> {
  segments(path);
  if (!permitted(path, roots)) throw new WorkspaceError(403, 'Path outside editable roots');
  const absolute = resolve(workspace, path);
  if (!absolute.startsWith(workspace + sep)) throw new WorkspaceError(403, 'Path outside workspace');
  let current = workspace;
  const parts = relative(workspace, absolute).split(sep);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new WorkspaceError(403, 'Symlinks are unavailable through remote MCP');
      if (index < parts.length - 1 && !stat.isDirectory()) throw new WorkspaceError(400, 'Parent is not a directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (mustExist) throw new WorkspaceError(404, 'Path not found');
    }
  }
  return absolute;
}

export async function remoteWorkspace(root = process.cwd()) {
  prohibitProductionMutation();
  const workspace = await realpath(root);
  const roots = configuredRoots();
  return {
    workspace,
    roots,
    async list(directory: string) {
      const absolute = await location(workspace, directory, roots, true);
      if (!(await lstat(absolute)).isDirectory()) throw new WorkspaceError(400, 'Not a directory');
      const entries = await readdir(absolute, { withFileTypes: true });
      return entries.filter((entry) => !entry.name.startsWith('.') && !entry.isSymbolicLink())
        .slice(0, 200).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' }));
    },
    async read(path: string) {
      const absolute = await location(workspace, path, roots, true);
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.size > 256_000) throw new WorkspaceError(400, 'File is unavailable or too large');
      const bytes = await readFile(absolute);
      const content = bytes.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(bytes)) throw new WorkspaceError(400, 'Only UTF-8 text files are supported');
      return { path, content, sha256: createHash('sha256').update(bytes).digest('hex') };
    },
    async mkdir(directory: string) {
      if (directory.endsWith('.json')) throw new WorkspaceError(400, 'Cannot create a file as a directory');
      const absolute = await location(workspace, directory, roots, false);
      await mkdir(absolute, { recursive: true, mode: 0o755 });
      return { directory };
    },
    async scaffoldDirectory(directory: string) {
      if (!directory.startsWith('packages/local/')) throw new WorkspaceError(403, 'Scaffolds belong in packages/local');
      const absolute = await location(workspace, directory, roots, false);
      await location(workspace, relative(workspace, dirname(absolute)).split(sep).join('/'), roots, true);
      try { await lstat(absolute); throw new WorkspaceError(409, 'Directory already exists'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return absolute;
    },
    async localPackageDirectory(directory: string) {
      if (!directory.startsWith('packages/local/')) throw new WorkspaceError(403, 'Package must be in packages/local');
      const absolute = await location(workspace, directory, roots, true);
      if (!(await lstat(absolute)).isDirectory()) throw new WorkspaceError(400, 'Not a package directory');
      await location(workspace, `${directory}/lattis.manifest.json`, roots, true);
      return absolute;
    },
    async write(path: string, content: string, expectedSha256: string | null) {
      if (Buffer.byteLength(content, 'utf8') > 256_000) throw new WorkspaceError(413, 'File exceeds 256 KB');
      const extension = path.slice(path.lastIndexOf('.'));
      if (!writableExtensions.has(extension)) throw new WorkspaceError(400, 'Unsupported text file extension');
      if (extension === '.json') {
        let parsed: unknown;
        try { parsed = JSON.parse(content); } catch { throw new WorkspaceError(400, 'Invalid JSON'); }
        if (path === 'lattis.config.json') {
          const config = parsed as { schemaVersion?: unknown; trustedModules?: unknown; migrations?: unknown };
          if (!config || config.schemaVersion !== 1 || !Array.isArray(config.trustedModules) || !Array.isArray(config.migrations))
            throw new WorkspaceError(400, 'Invalid Lattis project configuration');
        }
      }
      const absolute = await location(workspace, path, roots, false);
      if (changing.has(absolute)) throw new WorkspaceError(409, 'File is being changed');
      changing.add(absolute);
      let temporary: string | undefined;
      try {
        const parent = relative(workspace, dirname(absolute)).split(sep).join('/');
        if (parent) await location(workspace, parent, roots, true);
        let current: Buffer | null = null;
        let mode = 0o644;
        try {
          const stat = await lstat(absolute);
          if (!stat.isFile() || stat.size > 256_000) throw new WorkspaceError(400, 'Target is not a supported regular file');
          mode = stat.mode & 0o777;
          current = await readFile(absolute);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const digest = current ? createHash('sha256').update(current).digest('hex') : null;
        if (digest !== expectedSha256) throw new WorkspaceError(409, 'File changed; read it again before writing');
        temporary = join(dirname(absolute), `.lattis-mcp-${randomUUID()}`);
        await writeFile(temporary, content, { flag: 'wx', mode });
        await rename(temporary, absolute);
        temporary = undefined;
        return { path, sha256: createHash('sha256').update(content, 'utf8').digest('hex') };
      } finally {
        if (temporary) await unlink(temporary).catch(() => {});
        changing.delete(absolute);
      }
    },
  };
}
