import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import type { AppDatabase } from './app-db.js';
import { appConfig } from './config.js';

async function sendAuthMail(to: string, subject: string, url: string): Promise<void> {
  const endpoint = process.env.LATTIS_MAIL_WEBHOOK_URL;
  const token = process.env.LATTIS_MAIL_WEBHOOK_TOKEN;
  if (!endpoint || !token) throw new Error('Mail webhook is required for verification and password reset');
  if (process.env.NODE_ENV === 'production' && !endpoint.startsWith('https://')) throw new Error('Mail webhook requires HTTPS in production');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, subject, text: url }),
  });
  if (!response.ok) throw new Error('Mail provider rejected delivery');
}

export function createAuth(db: AppDatabase, options?: { baseUrl: string; signupOpen: boolean; trustedOrigins: string[] }) {
  const config = appConfig();
  return betterAuth({
    database: db.authPool,
    baseURL: options?.baseUrl ?? config.baseUrl,
    secret: config.authSecret,
    trustedOrigins: options?.trustedOrigins ?? config.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      disableSignUp: !(options?.signupOpen ?? config.signupOpen),
      maxPasswordLength: 4096,
      // Core gates unverified users by authorization; WordPress password proof is a separate trust path.
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        // The imported address may never have been verified by WordPress.
        // Recovery of password-imported accounts needs a separate authenticated/admin flow.
        const imported = await db.query('SELECT 1 FROM lattis_import_user WHERE claimed_user_id=$1 AND password_claimed_at IS NOT NULL LIMIT 1', [user.id]);
        if (!user.emailVerified || imported.rowCount) return;
        await sendAuthMail(user.email, 'Reset Lattis password', url);
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      sendVerificationEmail: async ({ user, url }) => sendAuthMail(user.email, 'Verify Lattis email', url),
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    plugins: [admin()],
  });
}
