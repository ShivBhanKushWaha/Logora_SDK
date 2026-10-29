export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

/** The same shape the ingest API accepts at POST /ingest/events. */
export interface LogoraEvent {
  /** Generated once when the event is captured; resends never create a second occurrence. */
  eventId: string;

  timestamp: string;

  level: LogLevel;

  service?: string;

  environment?: string;

  release?: string;

  message: string;

  exception?: { type?: string; stacktrace?: string };

  context?: Record<string, unknown>;
}

/** A trail entry (a tap, a screen change, an API call) kept briefly and attached to the next event. */
export interface Breadcrumb {
  timestamp: string;

  message: string;

  category?: string;

  data?: Record<string, unknown>;
}

/** Who was using the app; sent with every event so issues can be tied to people. Never put secrets here. */
export interface LogoraUser {
  id?: string;

  email?: string;

  name?: string;
}

/** Minimal async key-value store; AsyncStorage from React Native fits as-is. */
export interface LogoraStorage {
  getItem(key: string): Promise<string | null>;

  setItem(key: string, value: string): Promise<void>;

  removeItem(key: string): Promise<void>;
}

export interface LogoraOptions {
  /** Gateway base URL, no trailing slash. */
  endpoint: string;

  /** Project ingestion key (lgr_...). */
  key: string;

  service?: string;

  environment?: string;

  release?: string;

  /** Where the unsent buffer survives restarts. Defaults to memory only. */
  storage?: LogoraStorage;

  /** Max events held while offline; the oldest are dropped first. Default 500. */
  maxBuffer?: number;

  /** Events per request (server max is 100). Default 20. */
  maxBatch?: number;

  /** Background flush interval. 0 disables the timer. Default 5000. */
  flushIntervalMs?: number;

  /** First retry delay, doubled per failure up to maxRetryDelayMs. Default 1000. */
  baseRetryDelayMs?: number;

  maxRetryDelayMs?: number;

  /** Breadcrumbs kept and attached to events. 0 turns them off. Default 30. */
  maxBreadcrumbs?: number;

  /** Return null to drop an event, or a changed copy to send. */
  beforeSend?: (event: LogoraEvent) => LogoraEvent | null;

  fetch?: typeof fetch;
}
