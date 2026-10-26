import { UnrecoverableError } from 'bullmq';

/** Non-2xx from HubSpot. `retryAfterMs` is set for 429. */
export class HubSpotError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HubSpotError';
  }
  get isRateLimit() {
    return this.status === 429;
  }
  get isUnauthorized() {
    return this.status === 401;
  }
  /** Worth retrying with backoff: server errors, timeouts, rate limits. */
  get retryable() {
    return this.status === 429 || this.status === 408 || this.status >= 500;
  }
}

/** Refresh token rejected: the user has to reconnect. Retrying cannot help. */
export class ReauthRequiredError extends UnrecoverableError {
  constructor(message = 'HubSpot authorization is no longer valid; reconnect required') {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

/** Permanent failure for one job (bad request, resource gone). BullMQ will not retry. */
export class PermanentError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

/** Turn an arbitrary error from a job into retry-vs-fail-now semantics. */
export function classify(err: unknown): Error {
  if (err instanceof UnrecoverableError) return err;
  if (err instanceof HubSpotError && !err.retryable && !err.isUnauthorized) {
    return new PermanentError(`HubSpot ${err.status}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}
