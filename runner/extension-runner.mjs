// MIT. Data-only expression service. Never import extension code or expose eval.
import { createServer } from 'node:http';
import { chmod, lstat } from 'node:fs/promises';

const socketPath = process.env.LATTIS_RUNNER_SOCKET ?? '/run/lattis-runner/runner.sock';
const maximum = 262144;
const forbidden = new Set(['constructor', 'prototype', '__proto__']);
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Invalid expression');
}
function at(value, path) {
  if (!Array.isArray(path) || path.length > 12) throw new Error('Invalid path');
  for (const key of path) {
    if (typeof key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || forbidden.has(key) || !object(value) || !Object.hasOwn(value, key)) throw new Error('Missing or forbidden path');
    value = value[key];
  }
  return value;
}
function evaluate(expression, input, results, budget, depth = 0) {
  if (--budget.remaining < 0 || depth > 24 || !object(expression)) throw new Error('Expression limit exceeded');
  switch (expression.op) {
    case 'literal': keys(expression, ['op', 'value']); if (!Object.hasOwn(expression, 'value')) throw new Error('Missing literal'); return expression.value;
    case 'input': keys(expression, ['op', 'path']); return at(input, expression.path);
    case 'result': keys(expression, ['op', 'name', 'path']); return at(at(results, [expression.name]), expression.path);
    case 'object': {
      keys(expression, ['op', 'fields']); if (!object(expression.fields) || Object.keys(expression.fields).length > 100) throw new Error('Invalid fields');
      const result = Object.create(null);
      for (const [key, value] of Object.entries(expression.fields)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || forbidden.has(key)) throw new Error('Forbidden key');
        result[key] = evaluate(value, input, results, budget, depth + 1);
      }
      return result;
    }
    case 'array': keys(expression, ['op', 'items']); if (!Array.isArray(expression.items) || expression.items.length > 100) throw new Error('Invalid array'); return expression.items.map((item) => evaluate(item, input, results, budget, depth + 1));
    default: throw new Error('Unknown operation');
  }
}
let active = 0;
const server = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  response.setHeader('connection', 'close');
  if (request.method !== 'POST' || request.url !== '/evaluate') { response.writeHead(404).end('{}'); return; }
  if (request.headers['content-type'] !== 'application/json') { response.writeHead(415).end('{}'); return; }
  if (active >= 16) { response.writeHead(503).end('{}'); return; }
  active++;
  try {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > maximum) { response.writeHead(413).end('{}'); request.destroy(); return; } chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    keys(body, ['expression', 'input', 'results']);
    if (!object(body.results)) throw new Error('Invalid results');
    const value = evaluate(body.expression, body.input, body.results, { remaining: 4096 });
    const encoded = JSON.stringify({ value });
    if (Buffer.byteLength(encoded) > maximum) throw new Error('Result exceeds limit');
    response.end(encoded);
  } catch { if (!response.headersSent) response.writeHead(400).end('{"error":"Invalid or excessive expression"}'); }
  finally { active--; }
});
server.requestTimeout = 5000;
server.headersTimeout = 3000;
server.maxHeadersCount = 16;
server.maxConnections = 32;
server.on('clientError', (_error, socket) => socket.destroy());
try { await lstat(socketPath); throw new Error('Runner socket already exists; supervisor must recover its private runtime directory'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
server.listen(socketPath, async () => { try { await chmod(socketPath, 0o660); } catch { server.close(); process.exitCode = 1; } });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
