/**
 * A single error vocabulary for the API.
 *
 * Every failure the client can encounter maps to one of these, with a stable
 * machine-readable `code` alongside the human message. Clients branch on the
 * code; humans read the message. Parsing prose to decide whether to retry is
 * how integrations break on a copy edit.
 */

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'limit_exceeded'
  | 'idempotency_mismatch'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'symbol_unknown'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  limit_exceeded: 422,
  idempotency_mismatch: 422,
  rate_limited: 429,
  upstream_unavailable: 503,
  symbol_unknown: 404,
  internal: 500,
};

export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Extra fields merged into the response body - e.g. the current version. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = STATUS[code];
  }

  toBody(): Record<string, unknown> {
    return {
      error: { code: this.code, message: this.message, ...(this.details ?? {}) },
    };
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError('bad_request', message, details);

export const unauthorized = (message = 'authentication required'): ApiError =>
  new ApiError('unauthorized', message);

export const notFound = (what: string): ApiError => new ApiError('not_found', `${what} not found`);

/**
 * A lost-update conflict. The current version and state travel with the error
 * so the client can reconcile without a second round trip - and so a UI can
 * show "someone else changed this, here is what it looks like now".
 */
export const conflict = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError('conflict', message, details);
