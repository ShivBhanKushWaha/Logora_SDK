// Run after `npm run build`:
//   LOGORA_ENDPOINT=http://localhost:4000 LOGORA_KEY=lgr_... node examples/node-example.mjs
import { LogoraSdk } from '../dist/esm/index.js';

const logora = new LogoraSdk({
  endpoint: process.env.LOGORA_ENDPOINT ?? 'http://localhost:4000',
  key: process.env.LOGORA_KEY ?? 'lgr_replace_me',
  service: 'sdk-example',
  environment: 'development',
  release: '0.0.1',
});

logora.installGlobalHandlers();
logora.setUser({ id: 'demo-user', email: 'demo@example.com' });
logora.setTags({ region: 'ap-south-1' });

logora.addBreadcrumb('example started', 'lifecycle');
logora.captureMessage('SDK example is running', 'INFO');

try {
  JSON.parse('{ not json');
} catch (error) {
  logora.addBreadcrumb('parsing config', 'app', { file: 'config.json' });
  logora.captureException(error, { step: 'load-config' });
}

await logora.close();
console.log(`done, ${logora.pending} event(s) still pending`);
