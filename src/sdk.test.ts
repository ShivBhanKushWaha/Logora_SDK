import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LogoraSdk } from './sdk.js';
import type { LogoraStorage } from './types.js';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

const fakeFetch = (statuses: Array<number | 'network'>) => {
  const calls: Call[] = [];

  const impl = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });

    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];

    if (status === 'network') {
      throw new TypeError('network down');
    }

    return new Response('{}', { status });
  }) as unknown as typeof fetch;

  return { calls, impl };
};

const memoryStorage = (): LogoraStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();

  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
    removeItem: async (key) => void data.delete(key),
  };
};

const make = (statuses: Array<number | 'network'>, extra = {}) => {
  const { calls, impl } = fakeFetch(statuses);

  const sdk = new LogoraSdk({
    endpoint: 'https://api.test',
    key: 'lgr_test',
    service: 'svc',
    flushIntervalMs: 0,
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 2,
    fetch: impl,
    ...extra,
  });

  return { sdk, calls };
};

describe('LogoraSdk', () => {
  it('sends one event to /events with the key header and an eventId', async () => {
    const { sdk, calls } = make([202]);

    const id = sdk.captureMessage('hello', 'INFO');

    await sdk.flush();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.test/ingest/events');
    assert.equal(calls[0].headers['x-logora-key'], 'lgr_test');
    assert.equal(calls[0].body.eventId, id);
    assert.equal(calls[0].body.service, 'svc');
    assert.equal(sdk.pending, 0);
  });

  it('batches several events into /events/batch', async () => {
    const { sdk, calls } = make([202]);

    sdk.captureMessage('a');
    sdk.captureMessage('b');
    sdk.captureMessage('c');

    await sdk.flush();

    assert.equal(calls[0].url, 'https://api.test/ingest/events/batch');
    assert.equal(calls[0].body.events.length, 3);
  });

  it('keeps events through a network failure and resends with the same eventId', async () => {
    const { sdk, calls } = make(['network', 202]);

    const id = sdk.captureMessage('later');

    await sdk.flush();

    assert.equal(sdk.pending, 1);

    await new Promise((resolve) => setTimeout(resolve, 5));

    await sdk.flush();

    assert.equal(sdk.pending, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.eventId, id);
  });

  it('drops events the server rejects for good', async () => {
    const { sdk, calls } = make([422]);

    sdk.captureMessage('bad');

    await sdk.flush();

    assert.equal(calls.length, 1);
    assert.equal(sdk.pending, 0);
  });

  it('retries after a 500', async () => {
    const { sdk } = make([500]);

    sdk.captureMessage('x');

    await sdk.flush();

    assert.equal(sdk.pending, 1);
  });

  it('caps the buffer and drops the oldest', async () => {
    const { sdk } = make([500], { maxBuffer: 3 });

    for (let i = 0; i < 5; i += 1) {
      sdk.captureMessage(`m${i}`);
    }

    assert.equal(sdk.pending, 3);
  });

  it('captureException sends type, message and stacktrace', async () => {
    const { sdk, calls } = make([202]);

    sdk.captureException(new TypeError('boom'), { userId: 1 });

    await sdk.flush();

    assert.equal(calls[0].body.level, 'ERROR');
    assert.equal(calls[0].body.message, 'boom');
    assert.equal(calls[0].body.exception.type, 'TypeError');
    assert.match(calls[0].body.exception.stacktrace, /boom/);
    assert.deepEqual(calls[0].body.context, { userId: 1 });
  });

  it('restores unsent events from storage after a restart', async () => {
    const storage = memoryStorage();

    const first = make([500], { storage });

    first.sdk.captureMessage('survives');

    await first.sdk.flush();

    assert.equal(storage.data.size, 1);

    const second = make([202], { storage });

    await second.sdk.flush();

    assert.equal(second.calls.length, 1);
    assert.equal(second.calls[0].body.message, 'survives');
    assert.equal(storage.data.size, 0);
  });

  it('beforeSend can drop an event', async () => {
    const { sdk, calls } = make([202], { beforeSend: () => null });

    sdk.captureMessage('secret');

    await sdk.flush();

    assert.equal(calls.length, 0);
  });

  it('sends the user, tags and recent breadcrumbs with every event', async () => {
    const { calls, impl } = fakeFetch([200]);

    const sdk = new LogoraSdk({ endpoint: 'https://x.test', key: 'lgr_k', fetch: impl, flushIntervalMs: 0, maxBreadcrumbs: 2 });

    sdk.setUser({ id: 'u1', email: 'a@b.c' });
    sdk.setTags({ plan: 'pro' });
    sdk.addBreadcrumb('opened cart', 'nav');
    sdk.addBreadcrumb('tapped pay', 'ui');
    sdk.addBreadcrumb('payment request', 'http', { status: 500 });

    sdk.captureMessage('boom', 'WARN', { orderId: 7 });

    await sdk.flush();

    const context = calls[0]!.body.context;

    assert.deepEqual(context.user, { id: 'u1', email: 'a@b.c' });
    assert.deepEqual(context.tags, { plan: 'pro' });
    assert.equal(context.orderId, 7);
    assert.deepEqual(
      context.breadcrumbs.map((crumb: { message: string }) => crumb.message),
      ['tapped pay', 'payment request'],
    );
  });

  it('stops sending the user after setUser(null) and the tag after removeTag', async () => {
    const { calls, impl } = fakeFetch([200]);

    const sdk = new LogoraSdk({ endpoint: 'https://x.test', key: 'lgr_k', fetch: impl, flushIntervalMs: 0 });

    sdk.setUser({ id: 'u1' });
    sdk.setTags({ plan: 'pro' });
    sdk.setUser(null);
    sdk.removeTag('plan');

    sdk.captureMessage('plain');

    await sdk.flush();

    assert.equal(calls[0]!.body.context, undefined);
  });

  it('keeps no breadcrumbs when maxBreadcrumbs is 0', async () => {
    const { calls, impl } = fakeFetch([200]);

    const sdk = new LogoraSdk({ endpoint: 'https://x.test', key: 'lgr_k', fetch: impl, flushIntervalMs: 0, maxBreadcrumbs: 0 });

    sdk.addBreadcrumb('ignored');

    sdk.captureMessage('plain');

    await sdk.flush();

    assert.equal(calls[0]!.body.context, undefined);
  });
});
