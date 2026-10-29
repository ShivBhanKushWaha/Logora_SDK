# @shiv-kush/logora-sdk

Send errors and messages from your app to Logora. Works in Node 18+, React Native and browsers.

- **Never loses or duplicates an event:** events wait in a local buffer (optionally saved to disk), are sent in batches, retried with exponential backoff, and carry a stable `eventId`, so a resend is never counted twice.
- **Never breaks your app:** capturing never throws; the SDK swallows its own failures.
- **Small:** no dependencies, about 6 KB.

## Install

```sh
npm install @shiv-kush/logora-sdk
```

## Quick start

```ts
import { LogoraSdk } from '@shiv-kush/logora-sdk';

const logora = new LogoraSdk({
  endpoint: 'https://api.example.com', // your Logora gateway, no trailing slash
  key: 'lgr_xxxxxxxx',                 // project ingestion key (Project settings → keys)
  service: 'checkout-api',
  environment: 'production',
  release: '1.4.2',
});

logora.installGlobalHandlers();        // uncaught errors + unhandled rejections

try {
  await charge(order);
} catch (error) {
  logora.captureException(error, { orderId: order.id });
}

logora.captureMessage('Payment provider slow', 'WARN', { ms: 4200 });
```

Create the key in the Logora app: Project → settings (owner/admin) → ingestion keys. The secret is shown once.

## API

| Method | What it does |
|---|---|
| `captureException(error, context?, level = 'ERROR')` | Sends an error with its type, message and stack trace. Returns the `eventId`. |
| `captureMessage(message, level = 'INFO', context?)` | Sends a plain message. Levels: `DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL`. |
| `setUser({ id, email, name })` or `setUser(null)` | Who is using the app; sent with every event. Pass `null` on sign-out. No secrets. |
| `setTags({ plan: 'pro' })` / `removeTag(name)` | Labels sent with every event. |
| `addBreadcrumb(message, category?, data?)` | Remembers a step (screen opened, tap, request). The latest 30 are attached to the next event. |
| `installGlobalHandlers()` | Reports uncaught errors and unhandled rejections (Node and React Native). Returns a function that removes them. |
| `flush()` | Sends what is buffered now. `ERROR` and `CRITICAL` events flush on their own. |
| `close()` | Stops the timer and makes a last attempt to send. Call before a script or serverless function ends. |
| `pending` | Number of events still waiting. |

`user`, `tags` and `breadcrumbs` travel inside the event's `context`, next to anything you pass yourself.

## Options

| Option | Default | |
|---|---|---|
| `endpoint`, `key` | required | Gateway URL and project ingestion key. |
| `service`, `environment`, `release` | – | Labels on every event. |
| `storage` | memory | Where unsent events survive restarts: any `{ getItem, setItem, removeItem }`, so React Native's AsyncStorage fits as is. |
| `maxBuffer` | 500 | Events held while offline; the oldest are dropped first. |
| `maxBatch` | 20 | Events per request (the server allows 100). |
| `flushIntervalMs` | 5000 | Background flush; `0` turns the timer off. |
| `baseRetryDelayMs` / `maxRetryDelayMs` | 1000 / 60000 | Backoff after a failed request, doubled each time. |
| `maxBreadcrumbs` | 30 | `0` turns breadcrumbs off. |
| `beforeSend(event)` | – | Return `null` to drop an event, or a changed copy. Use it to scrub private data. |
| `fetch` | global `fetch` | Bring your own for old runtimes or tests. |

## React Native

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LogoraSdk } from '@shiv-kush/logora-sdk';

export const logora = new LogoraSdk({
  endpoint: 'https://api.example.com',
  key: 'lgr_xxxxxxxx',
  service: 'my-app',
  environment: __DEV__ ? 'development' : 'production',
  storage: AsyncStorage,   // events captured offline are sent next launch
});

logora.installGlobalHandlers();
```

Add breadcrumbs where it helps (navigation `onStateChange`, important taps). Send what is left when the app goes to the background:

```ts
AppState.addEventListener('change', (state) => state === 'background' && logora.flush());
```

## Node, Express and serverless

```ts
app.use((error, req, res, next) => {
  logora.captureException(error, { path: req.path, method: req.method });
  next(error);
});

// Serverless handlers: send before the function is frozen.
export const handler = async (event) => {
  try { return await run(event); }
  catch (error) { logora.captureException(error); throw error; }
  finally { await logora.flush(); }
};
```

`installGlobalHandlers()` also flushes when a short script's event loop empties (`beforeExit`).

## How delivery works

1. An event is stamped with `eventId` and `timestamp` and put in the buffer (and saved to `storage`).
2. A batch is sent to `POST /ingest/events` (one event) or `POST /ingest/events/batch` with the header `x-logora-key`.
3. Success removes exactly those events from the buffer.
4. `5xx`, `408`, network errors and `429` are retried with backoff (`Retry-After` is honoured).
5. Other `4xx` (bad key, invalid event, too large) are dropped, so one bad event never blocks the queue.

The server de-duplicates by `eventId` and groups events into issues by fingerprint.

## Develop

```sh
npm test            # unit tests
npm run build       # dist/esm + dist/cjs
npm run smoke       # real fetch against a throwaway local server
LOGORA_ENDPOINT=http://localhost:4000 LOGORA_KEY=lgr_... npm run smoke   # against your server
```

`examples/` has a runnable Node script and a React Native setup. To use the package from another folder before publishing: `npm pack` here, then `npm install ../LogoraSdk/logora-sdk-0.1.0.tgz` there.
