import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { canonicalize } from '@tufjs/canonical-json';
import { digest } from '../src/manifest.js';
import { boundedFile, insideFile, relativePath } from '../src/security-files.js';

// Run only on an offline release workstation. The online registry has no
// signing endpoint and never receives these keys.
type KeyRecord = { role: string; keyid: string; key: { keytype: 'ed25519'; scheme: 'ed25519'; keyval: { public: string } } };
const [command, ...args] = process.argv.slice(2);
const need = (value: string | undefined) => { if (!value) throw new Error('Missing argument'); return value; };
const readJson = async (path: string) => JSON.parse((await boundedFile(path, 10_000_000)).toString('utf8'));
const expiry = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function output(path: string, value: unknown) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Offline signing is unavailable on production services');
  if (command === 'keygen') {
    const role = need(args[0]), directory = resolve(need(args[1]));
    if (!['root','targets','snapshot','timestamp'].includes(role) || directory.startsWith(resolve(process.cwd()) + '/')) throw new Error('Use a separate offline key directory and a TUF role');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const pair = generateKeyPairSync('ed25519');
    const der = pair.publicKey.export({ type: 'spki', format: 'der' });
    const key = { keytype: 'ed25519' as const, scheme: 'ed25519' as const, keyval: { public: der.subarray(-32).toString('hex') } };
    const keyid = sha(Buffer.from(canonicalize(key)));
    await output(join(directory, `${keyid}.public.json`), { role, keyid, key });
    await writeFile(join(directory, `${keyid}.private.pem`), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ keyid, publicRecord: join(directory, `${keyid}.public.json`) }) + '\n'); return;
  }
  if (command === 'root') {
    const records = await readJson(need(args[0])) as KeyRecord[];
    const keys: Record<string, KeyRecord['key']> = {}, roles: Record<string, { keyids: string[]; threshold: number }> = {};
    for (const role of ['root','targets','snapshot','timestamp']) {
      const entries = records.filter((k) => k.role === role);
      const threshold = ['root','targets'].includes(role) ? 2 : 1;
      if (new Set(entries.map((e) => e.keyid)).size < (threshold === 2 ? 3 : 1)) throw new Error('Provide three independent keys for root/targets and one for snapshot/timestamp');
      roles[role] = { keyids: entries.map((e) => e.keyid), threshold };
      for (const entry of entries) { if (sha(Buffer.from(canonicalize(entry.key))) !== entry.keyid) throw new Error('Invalid key ID'); if (keys[entry.keyid]) throw new Error('Keys cannot be reused between roles'); keys[entry.keyid] = entry.key; }
    }
    await output(need(args[1]), { signed: { _type: 'root', spec_version: '1.0.31', version: 1, expires: expiry(365), consistent_snapshot: false, keys, roles }, signatures: [] }); return;
  }
  if (command === 'sign') {
    const envelope = await readJson(need(args[0]));
    if (!envelope.signed?._type || !Array.isArray(envelope.signatures)) throw new Error('Expected TUF metadata envelope');
    for (const path of args.slice(2)) {
      const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Private key must have mode 0600');
      const key = createPrivateKey(await boundedFile(path, 10000));
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519 key');
      const pub = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
      const keyid = sha(Buffer.from(canonicalize({ keytype: 'ed25519', scheme: 'ed25519', keyval: { public: pub } })));
      envelope.signatures = envelope.signatures.filter((s: { keyid: string }) => s.keyid !== keyid);
      envelope.signatures.push({ keyid, sig: sign(null, Buffer.from(canonicalize(envelope.signed)), key).toString('hex') });
    }
    if (!envelope.signatures.length) throw new Error('Provide signing keys');
    await output(need(args[1]), envelope); return;
  }
  const version = Number(need(args[1]));
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Version must be a positive monotonic integer');
  if (command === 'targets') {
    const directory = resolve(need(args[0]));
    const targets: Record<string, unknown> = {};
    async function walk(path: string) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const name = relative(directory, join(path, entry.name)).split('\\').join('/'); relativePath(name);
        if (entry.isSymbolicLink()) throw new Error('Target symlinks forbidden');
        if (entry.isDirectory()) { await walk(join(path, entry.name)); continue; }
        const data = await insideFile(directory, name, 256_000_000);
        targets[name] = { length: data.length, hashes: { sha256: sha(data) } };
      }
    }
    await walk(directory);
    await output(need(args[2]), { signed: { _type: 'targets', spec_version: '1.0.31', version, expires: expiry(30), targets }, signatures: [] }); return;
  }
  if (command === 'snapshot' || command === 'timestamp') {
    const file = need(args[0]), previous = await readJson(file), bytes = await readFile(file);
    const type = command === 'snapshot' ? 'targets' : 'snapshot';
    if (previous.signed?._type !== type || !previous.signatures?.length) throw new Error('Previous metadata must already be signed');
    await output(need(args[2]), { signed: { _type: command, spec_version: '1.0.31', version, expires: expiry(command === 'timestamp' ? 1 : 7), meta: { [`${type}.json`]: { version: previous.signed.version, length: bytes.length, hashes: { sha256: sha(bytes) } } } }, signatures: [] }); return;
  }
  throw new Error('Commands: keygen ROLE OFFLINE_DIRECTORY; root PUBLIC_RECORD_ARRAY OUTPUT; sign INPUT OUTPUT KEY...; targets DIRECTORY VERSION OUTPUT; snapshot SIGNED_TARGETS VERSION OUTPUT; timestamp SIGNED_SNAPSHOT VERSION OUTPUT');
}
main().catch((error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
