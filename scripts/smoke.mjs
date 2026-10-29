// Real-network check of the built package. With LOGORA_ENDPOINT + LOGORA_KEY it sends to your server;
// without them it starts a throwaway local server and checks what arrives.
import { createServer } from 'node:http';

import { LogoraSdk } from '../dist/esm/index.js';

let endpoint = process.env.LOGORA_ENDPOINT;
const key = process.env.LOGORA_KEY ?? 'lgr_smoke';
let local = null;
const received = [];

if (!endpoint) {
  local = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push({ url: request.url, key: request.headers['x-logora-key'], body: JSON.parse(body) });
      response.writeHead(201, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${local.address().port}`;
}

const sdk = new LogoraSdk({ endpoint, key, service: 'smoke', environment: 'test', flushIntervalMs: 0 });

sdk.setUser({ id: 'smoke-user' });
sdk.addBreadcrumb('smoke started', 'test');
sdk.captureMessage('hello from the smoke test', 'INFO');
sdk.captureException(new Error('smoke error'));
await sdk.close();

console.log(`pending after close: ${sdk.pending}`);

if (local) {
  local.close();
  const events = received.flatMap((call) => call.body.events ?? [call.body]);
  const ok = sdk.pending === 0 && events.length === 2 && received.every((call) => call.key === key);
  console.log(`local server got ${events.length} events in ${received.length} request(s): ${received.map((c) => c.url).join(', ')}`);
  process.exit(ok ? 0 : 1);
}
process.exit(sdk.pending === 0 ? 0 : 1);
