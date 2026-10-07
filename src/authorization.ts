import { insertIgnore, type AppDatabase } from './app-db.js';

export type Principal = { kind: 'user'; id: string; email: string; emailVerified: boolean; legacyPasswordAuthenticated: boolean } | { kind: 'service'; id: string; scopes: string[] };
export type Decision = { allowed: boolean; reason: string };

export async function authorize(db: AppDatabase, principal: Principal | null, action: string, resourceType: string, resourceId = '*'): Promise<Decision> {
  if (!principal) return { allowed: false, reason: 'anonymous' };
  if (principal.kind === 'service') {
    const scope = `${action}:${resourceType}`;
    return principal.scopes.includes(scope) ? { allowed: true, reason: 'service_scope' } : { allowed: false, reason: 'scope_missing' };
  }
  if (!principal.emailVerified && !principal.legacyPasswordAuthenticated) return { allowed: false, reason: 'identity_unverified' };
  const result = await db.query(
    `SELECT 1 FROM lattis_user_role ur JOIN lattis_role_grant rg ON rg.role_id = ur.role_id
     WHERE ur.user_id = $1 AND (ur.resource_id = '*' OR ur.resource_id = $4)
       AND (rg.action = '*' OR rg.action = $2)
       AND (rg.resource_type = '*' OR rg.resource_type = $3) LIMIT 1`,
    [principal.id, action, resourceType, resourceId],
  );
  return result.rowCount ? { allowed: true, reason: 'role_grant' } : { allowed: false, reason: 'default_deny' };
}

export async function bootstrapOwner(db: AppDatabase, principal: Extract<Principal, { kind: 'user' }>, ownerEmail: string): Promise<void> {
  if (!principal.emailVerified || principal.email.toLowerCase() !== ownerEmail) return;
  await insertIgnore(db, db.dialect, 'lattis_user_role', ['user_id','role_id','resource_id'], [principal.id,'owner','*']);
}
