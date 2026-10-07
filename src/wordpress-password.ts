import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AppClient, AppDatabase } from './app-db.js';
import type { createAuth } from './auth.js';

const verifier = fileURLToPath(new URL('./compat/wordpress-password-verify.php', import.meta.url));
const bcryptHash = /^\$2[aby]\$(0[4-9]|1[0-4])\$[.\/A-Za-z0-9]{53}$/;
const phpassHash = /^\$P\$[.\/0-9A-Za-z]{31}$/;

export function supportedWordPressHash(hash: string): boolean {
  if (hash.startsWith('$wp')) return bcryptHash.test(hash.slice(3));
  if (bcryptHash.test(hash)) return true;
  if (!phpassHash.test(hash)) return false;
  const count = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.indexOf(hash[3]);
  return count >= 7 && count <= 20;
}

function importKey(): Buffer {
  const value = process.env.LATTIS_WP_IMPORT_KEY;
  if (!value || !/^[A-Za-z0-9+\/]{43}=$/.test(value)) throw new Error('LATTIS_WP_IMPORT_KEY must be 32 random bytes encoded as base64');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('Invalid LATTIS_WP_IMPORT_KEY');
  return key;
}

function phpBinary(): string {
  const path = process.env.LATTIS_PHP_BIN;
  if (!path || !path.startsWith('/')) throw new Error('LATTIS_PHP_BIN must be an absolute path for WordPress password migration');
  return path;
}

export function passwordMigrationConfigured(): void {
  importKey();
  phpBinary();
}

export function encryptWordPressHash(site: string, externalId: string, email: string, hash: string): string {
  if (!supportedWordPressHash(hash)) throw new Error('Unsupported WordPress password hash');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', importKey(), iv);
  cipher.setAAD(Buffer.from(`${site}\n${externalId}\n${email}`));
  const body = Buffer.concat([cipher.update(hash, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
}

function decryptWordPressHash(site: string, externalId: string, email: string, encrypted: string): string {
  if (!encrypted.startsWith('v1:')) throw new Error('Unknown WordPress hash envelope');
  const packed = Buffer.from(encrypted.slice(3), 'base64');
  if (packed.length < 29) throw new Error('Invalid WordPress hash envelope');
  const decipher = createDecipheriv('aes-256-gcm', importKey(), packed.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${site}\n${externalId}\n${email}`));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
}

async function verifyWordPressPassword(password: string, hash: string): Promise<boolean> {
  if (!supportedWordPressHash(hash) || Buffer.byteLength(password) > 4096) return false;
  const payload = JSON.stringify({ password, hash });
  if (Buffer.byteLength(payload) > 8192) return false;
  const child = spawn(phpBinary(), ['-n', verifier], {
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 5_000,
    killSignal: 'SIGKILL',
    cwd: '/',
    env: { LANG: 'C', LC_ALL: 'C' },
  });
  return await new Promise<boolean>((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (error?: Error, valid?: boolean) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(valid === true);
    };
    child.on('error', (error) => finish(error));
    child.stdin.on('error', (error) => finish(error));
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 8) child.kill('SIGKILL');
    });
    child.on('close', (code) => {
      if (code !== 0 || (output !== '1' && output !== '0')) finish(new Error('WordPress password verifier failed'));
      else finish(undefined, output === '1');
    });
    child.stdin.end(payload);
  });
}

type PendingUser = { id: string; source_site: string; external_id: string; email: string; display_name: string; claimed_user_id: string | null; legacy_password_ciphertext: string };

export class WordPressPasswordBridge {
  constructor(private readonly db: AppDatabase, private readonly auth: ReturnType<typeof createAuth>) {}

  private async pending(email: string, client?: AppClient): Promise<PendingUser[]> {
    return (await (client ?? this.db).query<PendingUser>('SELECT id,source_site,external_id,email,display_name,claimed_user_id,legacy_password_ciphertext FROM lattis_import_user WHERE email=$1 AND auth_mode=$2 AND legacy_password_ciphertext IS NOT NULL ORDER BY source_site,external_id', [email,'password'])).rows;
  }

  private async matching(email: string, password: string, client?: AppClient): Promise<PendingUser[]> {
    const matches: PendingUser[] = [];
    for (const row of await this.pending(email, client)) {
      if (await verifyWordPressPassword(password, decryptWordPressHash(row.source_site, row.external_id, row.email, row.legacy_password_ciphertext))) matches.push(row);
    }
    return matches;
  }

  async provisionAfterFailedSignIn(email: string, password: string): Promise<boolean> {
    const table = this.db.dialect === 'postgres' ? '"user"' : '`user`';
    if ((await this.db.query(`SELECT id FROM ${table} WHERE email=$1`, [email])).rowCount) return false;
    const match = (await this.matching(email, password)).find((row) => !row.claimed_user_id);
    if (!match) return false;
    try {
      await this.auth.api.createUser({ body: { email, name: match.display_name, password, data: { emailVerified: false } } });
      return true;
    } catch (error) {
      if ((await this.db.query(`SELECT id FROM ${table} WHERE email=$1`, [email])).rowCount) return true;
      throw error;
    }
  }

  async claimAfterSignIn(userId: string, email: string, password: string, correlationId: string): Promise<void> {
    const matches = (await this.matching(email, password)).filter((row) => !row.claimed_user_id || row.claimed_user_id === userId);
    if (!matches.length) return;
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      for (const row of matches) {
        const changed = await client.query('UPDATE lattis_import_user SET claimed_user_id=$1,password_claimed_at=$2,legacy_password_ciphertext=NULL,updated_at=$2 WHERE id=$3 AND (claimed_user_id IS NULL OR claimed_user_id=$1) AND legacy_password_ciphertext IS NOT NULL', [userId,new Date(),row.id]);
        if (changed.rowCount) await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [userId,'user.import.wordpress.password',row.id,'allowed',correlationId]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { await client.release(); }
  }
}
