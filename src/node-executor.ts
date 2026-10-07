import { createHash } from 'node:crypto';
import { authorize, type Principal } from './authorization.js';
import { jsonValue, type AppDatabase } from './app-db.js';
import type { NodeDefinition } from './runtime.js';

export class NodeExecutionError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

// Shared controlled broker for Admin UI. It never accepts SQL, secrets or a
// Principal from an extension or its runner; every nested call is authorized.
export function controlledExecutor(db: AppDatabase, nodes: NodeDefinition[]) {
  return async (name: string, raw: unknown, who: Principal, key: string | undefined, correlationId: string) => {
    const root = nodes.find((node) => node.name === name);
    if (!root) throw new NodeExecutionError(404, 'Node not found');
    if (root.kind === 'command' && (!key || key.length > 128)) throw new NodeExecutionError(400, 'Idempotency-Key required');
    const client = await db.connect();
    const budget = { remaining: 64, deadline: Date.now() + 15000 };
    let committed = false;
    const transactional = root.kind === 'command';
    async function invoke(targetName: string, value: unknown, path: string[], fromKind: 'command' | 'query'): Promise<unknown> {
      if (--budget.remaining < 0 || Date.now() > budget.deadline || path.length >= 8 || path.includes(targetName)) throw new NodeExecutionError(400, 'Invocation budget exceeded');
      const node = nodes.find((candidate) => candidate.name === targetName);
      if (!node) throw new NodeExecutionError(404, 'Node not found');
      if (node.kind === 'command' && (fromKind === 'query' || !transactional)) throw new NodeExecutionError(403, 'A query cannot invoke a command');
      const input = node.input.parse(value);
      const decision = await authorize(db, who, node.action, node.resourceType, node.resourceId(input));
      if (!decision.allowed) {
        await db.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [who.id,'node.invoke',targetName,'denied',correlationId]);
        throw new NodeExecutionError(403, 'Node invocation forbidden');
      }
      const nested = [...path, targetName];
      const requestDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const receiptKey = path.length ? createHash('sha256').update(JSON.stringify({ rootKey: key, nestedPath: nested })).digest('hex') : key;
      if (node.kind === 'command') {
        await client.lock(`${path.length ? 'nested:' : ''}${targetName}:${who.id}:${receiptKey}`);
        const prior = await client.query('SELECT request_digest,response FROM lattis_node_receipt WHERE node_name=$1 AND principal_id=$2 AND idempotency_key=$3', [targetName,who.id,receiptKey]);
        if (prior.rows[0]) {
          if (prior.rows[0].request_digest !== requestDigest) throw new NodeExecutionError(409, 'Idempotency conflict');
          return jsonValue(prior.rows[0].response);
        }
      }
      const output = node.output.parse(await node.handler({ db: client, principal: who,
        secrets: { get: async () => { throw new NodeExecutionError(403, 'Direct secrets are unavailable to declarative extensions'); } },
        invoke: (target, input) => invoke(target, input, nested, node.kind),
      }, input));
      const encoded = JSON.stringify(output);
      if (encoded === undefined || Buffer.byteLength(encoded) > 262144) throw new NodeExecutionError(400, 'Node output exceeds budget');
      if (node.kind === 'command') await client.query('INSERT INTO lattis_node_receipt (node_name,principal_id,idempotency_key,request_digest,response) VALUES ($1,$2,$3,$4,$5)', [targetName,who.id,receiptKey,requestDigest,encoded]);
      return output;
    }
    try {
      if (transactional) await client.query('BEGIN');
      const output = await invoke(name, raw, [], root.kind);
      await client.query('INSERT INTO lattis_audit (actor,action,resource,result,correlation_id) VALUES ($1,$2,$3,$4,$5)', [who.id,'admin.extension.execute',name,'allowed',correlationId]);
      if (transactional) await client.query('COMMIT');
      committed = true;
      return output;
    } catch (error) { if (transactional && !committed) await client.query('ROLLBACK'); throw error; }
    finally { await client.release(); }
  };
}
