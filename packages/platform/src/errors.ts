import type { ApiErrorCode } from '@caixiaozhi/contracts';

export const errorHttpStatus: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_STATE: 409,
  CONFIRMATION_EXPIRED: 409,
  REVALIDATION_REQUIRED: 409,
  RATE_LIMITED: 429,
  DEPENDENCY_UNAVAILABLE: 503,
  OUTCOME_UNKNOWN: 202,
};

export class AppError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = errorHttpStatus[code];
    this.retryable = options.retryable ?? code === 'DEPENDENCY_UNAVAILABLE';
    this.details = options.details;
  }
}
