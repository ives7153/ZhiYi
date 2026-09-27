/**
 * Error taxonomy, mirroring the Web client's layering in `frontend/lib/api.ts`.
 *
 * The three classes exist because the UI must react differently to each:
 *  - `NetworkError`  → the backend is unreachable; offer a retry, never log out.
 *  - `AuthError`     → credentials are unusable; force re-authentication.
 *  - `ApiError`      → a business error; show the server's `detail` text.
 */
export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestError';
  }
}

/** The backend could not be reached, or the request timed out. */
export class NetworkError extends RequestError {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * Credentials are unusable and the user must log in again.
 *
 * Which statuses count is deliberately a set, not just 401. The backend's
 * `/auth/session` validates `email` with pydantic `EmailStr`, so an account
 * created with a reserved domain (e.g. `dev@wardrobe.local`) makes that one
 * endpoint answer **422** while `/users/me` and `/items` still answer 200.
 * Treating only 401 as "expired" would strand the user in a logged-in-looking
 * state that cannot finish bootstrapping. There is no refresh endpoint, so we
 * never attempt a silent refresh — re-auth is the only correct response.
 *
 * 422 counts ONLY on a request that actually validates the credential (see
 * `RequestOptions.credentialChecked`). Every other endpoint also returns 422 for
 * an ordinary payload validation failure, and treating those as an auth failure
 * would log the user out because they typed a 101-character garment name.
 */
export class AuthError extends RequestError {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/** A 4xx/5xx response that is not an auth failure. */
export class ApiError extends RequestError {
  status: number;
  detail: string | null;

  constructor(message: string, status: number, detail: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

/** HTTP statuses that mean "these credentials are unusable". */
const AUTH_FAILURE_STATUSES = new Set([401, 403]);

/**
 * True when a status means "the credential was rejected" *for this request*.
 *
 * `credentialChecked` must be true only for endpoints whose response is gated on
 * the credential itself (currently `GET /auth/session`). FastAPI answers 422 for
 * any request-body validation failure (`RequestValidationError` in
 * `backend/app/main.py`), so a blanket 422 here would turn a mistyped garment
 * name into a forced logout.
 */
export function isCredentialRejection(status: number, credentialChecked: boolean): boolean {
  if (credentialChecked) return status === 401 || status === 403 || status === 422;
  return isAuthFailureStatus(status);
}

export function isAuthFailureStatus(status: number): boolean {
  return AUTH_FAILURE_STATUSES.has(status);
}

/**
 * Turns a backend error body into readable text.
 *
 * FastAPI returns `{"detail": "..."}` for HTTPException. The app also installs
 * a validation handler that returns
 * `{"detail": "Validation error", "errors": [{field, message}]}`, so that shape
 * is rendered too rather than showing a useless "Validation error".
 */
export function extractErrorMessage(body: unknown): string | null {
  if (body == null) return null;

  if (typeof body === 'string') {
    const trimmed = body.trim();
    return trimmed || null;
  }

  if (typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;

  const errors = record.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const parts = errors
      .map((entry) => {
        if (entry && typeof entry === 'object') {
          const e = entry as Record<string, unknown>;
          const field = typeof e.field === 'string' ? e.field : null;
          const message = typeof e.message === 'string' ? e.message : null;
          if (field && message) return `${field}: ${message}`;
          return message;
        }
        return null;
      })
      .filter((part): part is string => Boolean(part));
    if (parts.length > 0) return parts.join('; ');
  }

  const detail = record.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (detail && typeof detail === 'object') {
    const message = (detail as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }

  const error = record.error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }

  return null;
}
