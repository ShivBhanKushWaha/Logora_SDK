import type { Breadcrumb, LogLevel, LogoraEvent, LogoraOptions, LogoraStorage, LogoraUser } from './types.js';

const STORAGE_KEY = 'logora:buffer:v1';

const MAX_STACK = 20_000;

const MAX_MESSAGE = 8_000;

const newEventId = (): string => {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;

  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
};

const MAX_BREADCRUMB_DATA = 2_000;

type Outcome = 'sent' | 'retry' | 'drop';

/**
 * Collects events, keeps them in a bounded buffer (optionally persisted), and
 * sends them in batches. A failed request is retried with exponential backoff;
 * events the server rejects for good (400/401/403/404/413/422) are dropped so
 * one bad event can never block the queue. It never throws into the host app.
 */
export class LogoraSdk {
  private readonly options: Required<
    Pick<LogoraOptions, 'maxBuffer' | 'maxBatch' | 'flushIntervalMs' | 'baseRetryDelayMs' | 'maxRetryDelayMs' | 'maxBreadcrumbs'>
  > &
    LogoraOptions;

  private readonly storage?: LogoraStorage;

  private readonly fetchImpl: typeof fetch;

  private buffer: LogoraEvent[] = [];

  private flushing: Promise<void> | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  private failures = 0;

  private nextAttemptAt = 0;

  private ready: Promise<void>;

  private user: LogoraUser | null = null;

  private tags: Record<string, string> = {};

  private breadcrumbs: Breadcrumb[] = [];

  constructor(options: LogoraOptions) {
    this.options = {
      maxBuffer: 500,
      maxBatch: 20,
      flushIntervalMs: 5_000,
      baseRetryDelayMs: 1_000,
      maxRetryDelayMs: 60_000,
      maxBreadcrumbs: 30,
      ...options,
    };

    this.storage = options.storage;

    this.fetchImpl = options.fetch ?? (globalThis.fetch as typeof fetch);

    this.ready = this.restore();

    if (this.options.flushIntervalMs > 0) {
      this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);

      // Do not keep a Node process alive just for the flush timer.
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Events waiting to be sent. */
  get pending(): number {
    return this.buffer.length;
  }

  /** Who is using the app; null on sign-out. Sent with every event after this call. */
  setUser(user: LogoraUser | null): void {
    this.user = user ? { ...user } : null;
  }

  /** Extra labels (e.g. `{ plan: 'pro' }`) sent with every event; passing a value of `undefined` is not allowed, use removeTag. */
  setTags(tags: Record<string, string>): void {
    this.tags = { ...this.tags, ...tags };
  }

  removeTag(name: string): void {
    delete this.tags[name];
  }

  /** Remembers a step (screen opened, button tapped, request sent); the latest ones ride along with the next event. */
  addBreadcrumb(message: string, category?: string, data?: Record<string, unknown>): void {
    if (this.options.maxBreadcrumbs <= 0) {
      return;
    }

    let safeData: Record<string, unknown> | undefined;

    if (data) {
      try {
        safeData = JSON.stringify(data).length > MAX_BREADCRUMB_DATA ? { truncated: true } : data;
      } catch {
        safeData = { unserializable: true };
      }
    }

    this.breadcrumbs.push({ timestamp: new Date().toISOString(), message: message.slice(0, 300), category, data: safeData });

    if (this.breadcrumbs.length > this.options.maxBreadcrumbs) {
      this.breadcrumbs.splice(0, this.breadcrumbs.length - this.options.maxBreadcrumbs);
    }
  }

  captureMessage(message: string, level: LogLevel = 'INFO', context?: Record<string, unknown>): string {
    return this.enqueue({ level, message, context });
  }

  captureException(error: unknown, context?: Record<string, unknown>, level: LogLevel = 'ERROR'): string {
    const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : safeStringify(error));

    return this.enqueue({
      level,
      message: err.message || err.name,
      exception: { type: err.name, stacktrace: err.stack?.slice(0, MAX_STACK) },
      context,
    });
  }

  /**
   * Reports uncaught errors and unhandled rejections. Works in Node and in
   * React Native (ErrorUtils); returns a function that removes the handlers.
   */
  installGlobalHandlers(): () => void {
    const undo: Array<() => void> = [];

    const proc = (globalThis as { process?: NodeJS.Process }).process;

    if (proc?.on) {
      const onError = (error: Error) => this.captureException(error, { source: 'uncaughtException' }, 'CRITICAL');

      const onRejection = (reason: unknown) => this.captureException(reason, { source: 'unhandledRejection' });

      // Node: a last flush when the event loop empties, so short scripts do not exit with events unsent.
      const onBeforeExit = () => void this.flush();

      proc.on('uncaughtException', onError);
      proc.on('unhandledRejection', onRejection);
      proc.on('beforeExit', onBeforeExit);

      undo.push(() => {
        proc.off('uncaughtException', onError);
        proc.off('unhandledRejection', onRejection);
        proc.off('beforeExit', onBeforeExit);
      });
    }

    const errorUtils = (globalThis as { ErrorUtils?: { getGlobalHandler(): (e: Error, fatal?: boolean) => void; setGlobalHandler(h: (e: Error, fatal?: boolean) => void): void } }).ErrorUtils;

    if (errorUtils) {
      const previous = errorUtils.getGlobalHandler();

      errorUtils.setGlobalHandler((error, isFatal) => {
        this.captureException(error, { source: 'ErrorUtils', isFatal: !!isFatal }, isFatal ? 'CRITICAL' : 'ERROR');

        previous(error, isFatal);
      });

      undo.push(() => errorUtils.setGlobalHandler(previous));
    }

    return () => undo.forEach((fn) => fn());
  }

  /** Sends what is buffered. Safe to call any time; concurrent calls share one run. */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => {
      this.flushing = null;
    });

    return this.flushing;
  }

  /** Stops the timer and makes a last attempt to send. */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);

      this.timer = null;
    }

    await this.flush();
  }

  private enqueue(partial: Pick<LogoraEvent, 'level' | 'message'> & Partial<LogoraEvent>): string {
    const eventId = newEventId();

    try {
      const context: Record<string, unknown> = {
        ...(this.user ? { user: this.user } : {}),
        ...(Object.keys(this.tags).length > 0 ? { tags: this.tags } : {}),
        ...(this.breadcrumbs.length > 0 ? { breadcrumbs: [...this.breadcrumbs] } : {}),
        ...partial.context,
      };

      let event: LogoraEvent | null = {
        service: this.options.service,
        environment: this.options.environment,
        release: this.options.release,
        ...partial,
        context: Object.keys(context).length > 0 ? context : undefined,
        message: partial.message.slice(0, MAX_MESSAGE) || 'Unknown error',
        eventId,
        timestamp: new Date().toISOString(),
      };

      if (this.options.beforeSend) {
        event = this.options.beforeSend(event);
      }

      if (event) {
        this.buffer.push(event);

        if (this.buffer.length > this.options.maxBuffer) {
          this.buffer.splice(0, this.buffer.length - this.options.maxBuffer);
        }

        void this.persist();

        if (event.level === 'ERROR' || event.level === 'CRITICAL') {
          void this.flush();
        }
      }
    } catch {
      // Capturing must never break the host app.
    }

    return eventId;
  }

  private async drain(): Promise<void> {
    await this.ready;

    while (this.buffer.length > 0) {
      const wait = this.nextAttemptAt - Date.now();

      if (wait > 0) {
        // Backing off: the timer or the next flush() picks it up after the delay.
        return;
      }

      const batch = this.buffer.slice(0, this.options.maxBatch);

      const outcome = await this.send(batch);

      if (outcome === 'retry') {
        this.failures += 1;

        const delay = Math.min(this.options.baseRetryDelayMs * 2 ** (this.failures - 1), this.options.maxRetryDelayMs);

        this.nextAttemptAt = Date.now() + delay * (0.5 + Math.random() / 2);

        return;
      }

      this.failures = 0;

      this.nextAttemptAt = 0;

      // Remove by id: new events may have been appended (or old ones evicted) while the request was in flight.
      const sent = new Set(batch.map((event) => event.eventId));

      this.buffer = this.buffer.filter((event) => !sent.has(event.eventId));

      await this.persist();
    }
  }

  private async send(batch: LogoraEvent[]): Promise<Outcome> {
    try {
      const single = batch.length === 1;

      const response = await this.fetchImpl(`${this.options.endpoint}/ingest/events${single ? '' : '/batch'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-logora-key': this.options.key },
        body: JSON.stringify(single ? batch[0] : { events: batch }),
      });

      if (response.ok) {
        return 'sent';
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));

        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          this.failures = Math.max(this.failures, 1);

          this.nextAttemptAt = Date.now() + retryAfter * 1000;

          return 'retry';
        }
      }

      // 5xx, rate limits and timeouts are worth another try; other 4xx will never succeed.
      return response.status >= 500 || response.status === 429 || response.status === 408 ? 'retry' : 'drop';
    } catch {
      return 'retry';
    }
  }

  private async restore(): Promise<void> {
    if (!this.storage) {
      return;
    }

    try {
      const raw = await this.storage.getItem(STORAGE_KEY);

      if (raw) {
        const saved = JSON.parse(raw) as LogoraEvent[];

        // Anything captured before restore finished stays after the older saved events.
        const known = new Set(this.buffer.map((event) => event.eventId));

        this.buffer = [...saved.filter((event) => !known.has(event.eventId)), ...this.buffer].slice(-this.options.maxBuffer);
      }
    } catch {
      // A corrupt buffer is discarded rather than blocking startup.
    }
  }

  private async persist(): Promise<void> {
    if (!this.storage) {
      return;
    }

    try {
      await this.ready;

      if (this.buffer.length === 0) {
        await this.storage.removeItem(STORAGE_KEY);
      } else {
        await this.storage.setItem(STORAGE_KEY, JSON.stringify(this.buffer));
      }
    } catch {
      // Storage full or unavailable: keep running from memory.
    }
  }
}

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};
