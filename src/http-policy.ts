import type { FastifyInstance } from 'fastify';

export const httpLogger = {
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie', 'password', 'token', 'secret', 'value'],
  serializers: {
    req: (request: { id: string; method: string; url: string; ip: string }) => ({ id: request.id, method: request.method, path: request.url.split('?')[0], ip: request.ip }),
    err: (error: { name?: string; code?: string }) => ({ type: error.name ?? 'Error', code: error.code ?? 'INTERNAL_ERROR' }),
  },
};

export function registerHttpPolicy(app: FastifyInstance, origin: string): void {
  const expectedHost = new URL(origin).host;
  const buckets = new Map<string, { until: number; count: number }>();
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
    if (process.env.NODE_ENV === 'production') {
      if (request.headers.host !== expectedHost) return reply.code(404).send({ error: 'Not found' });
      reply.header('strict-transport-security', 'max-age=31536000');
    }
    const path = request.url.split('?')[0];
    if (path === '/health/live' || path === '/health/ready') return;
    const now = Date.now();
    const login = path.startsWith('/api/auth/');
    const key = `${login ? 'auth' : 'api'}:${request.ip}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (buckets.size >= 10000) for (const [oldKey, old] of buckets) if (old.until <= now) buckets.delete(oldKey);
      if (buckets.size >= 10000) return reply.code(503).send({ error: 'Request capacity exceeded' });
      bucket = { until: now + 60000, count: 0 }; buckets.set(key, bucket);
    }
    if (++bucket.count > (login ? 30 : 600)) return reply.header('retry-after', Math.max(1, Math.ceil((bucket.until - now) / 1000))).code(429).send({ error: 'Too many requests' });
  });
}
