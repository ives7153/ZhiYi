/**
 * Error taxonomy, mirroring the Web client's layering in `frontend/lib/api.ts`.
 *
 * The three classes exist because the UI must react differently to each:
 *  - `NetworkError`  → the transport failed; whether anything was stored is a separate
 *                      fact, carried in `outcomeUnknown`. A write must not claim "not
 *                      saved" when the client cannot prove it.
 *  - `AuthError`     → the credential was rejected; force re-authentication.
 *  - `ApiError`      → a business error; show the server's `detail` text. Most of this
 *                      backend's 403s are these, NOT credential failures — see
 *                      `isCredentialRejection`.
 */
export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestError';
  }
}

/**
 * The transport failed before a usable answer arrived.
 *
 * Two independent facts, because a write must be honest about both:
 *
 *  - `timedOut` — *why* it failed, so the message can say 超时 or 无法连接;
 *  - `outcomeUnknown` — whether the server may already have stored the write. This is
 *    the one the UI acts on.
 *
 * `outcomeUnknown` is `true` for every failure that happened **after** the request was
 * handed to `fetch`, and that is deliberate. Neither React Native's `fetch` nor Expo's
 * replacement reports *where* a transport failed: `TypeError('Network request failed')`
 * covers both "the connection was never established" and "the request was delivered and
 * the answer was lost", and the two are indistinguishable from JavaScript. A dropped
 * response body (`response.text()` rejecting) is worse still — the headers arrived, so
 * the request certainly reached the server. Round 3's review (finding B) found the save
 * screens promising "已经选好的单品不会丢失" for exactly those cases, so the promise is
 * gone: only a failure that provably happened **before** dispatch sets
 * `outcomeUnknown: false` (a missing API base URL — no request exists to be stored).
 *
 * The distinction is carried this far because `POST /outfits/suggestions` has no
 * idempotency key (`SuggestionCreateRequest` accepts none), so retrying an uncertain
 * create can produce a second outfit — the user has to be told to check the saved list
 * first instead of being told the save failed.
 */
export class NetworkError extends RequestError {
  readonly timedOut: boolean;
  /** True when the request was dispatched, so the server may have committed it. */
  readonly outcomeUnknown: boolean;

  constructor(
    message: string,
    options: { timedOut?: boolean; outcomeUnknown?: boolean } = {},
  ) {
    super(message);
    this.name = 'NetworkError';
    this.timedOut = options.timedOut ?? false;
    // Default to the honest reading: assume the request may have been delivered.
    this.outcomeUnknown = options.outcomeUnknown ?? true;
  }
}

/**
 * The credential was rejected and the user must log in again.
 *
 * Only `isCredentialRejection` creates one (see there for the exact status rules); this
 * type is the *consequence* — the global handler clears the token, the persisted
 * credentials and the query cache.
 *
 * The rule on a credential-checked endpoint (`GET /auth/session`, the only one) is a set,
 * not just 401: that endpoint validates `email` with pydantic `EmailStr`, so an account
 * created with a reserved domain (e.g. `dev@wardrobe.local`) makes it answer **422**
 * while `/users/me` and `/items` still answer 200. Treating only 401 as "expired" would
 * strand the user in a logged-in-looking state that cannot finish bootstrapping. There is
 * no refresh endpoint, so we never attempt a silent refresh — re-auth is the only correct
 * response.
 *
 * Everywhere else 403 and 422 are *not* credential failures: 422 is an ordinary payload
 * validation failure (a 101-character garment name), and 403 is an authorization answer
 * for a valid session (`OUTFIT_ITEM_OWNERSHIP` and friends). Turning either into this
 * type logs the user out and throws away their unsent draft.
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
  /**
   * The server's machine-readable `detail.error_code`, when it sent one.
   *
   * Round 4's screens need to tell apart two answers that are both 409 with a perfectly
   * readable `message`: `ITEM_ARCHIVED` (restore it first) and `ITEM_OWNERSHIP_CHANGED`
   * (this row is not 待购 any more — do **not** delete it). Matching on the English
   * message text would break the moment the wording changed, and matching on the status
   * alone cannot distinguish them at all. Business errors keep the session either way;
   * this is only about saying the right thing.
   */
  errorCode: string | null;
  /** The parsed error body, for the rare field the message does not carry. */
  body: unknown;

  constructor(
    message: string,
    status: number,
    detail: string | null = null,
    errorCode: string | null = null,
    body: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.errorCode = errorCode;
    this.body = body;
  }
}

/**
 * Pulls `error_code` out of a backend error body.
 *
 * Both shapes this backend uses are accepted: a plain string detail (no code), and the
 * structured `{"detail": {"error_code": …, "message": …}}` that carries one, plus a
 * top-level `error_code` for completeness. Returns `null` when there is none — callers
 * must treat "no code" as a real case, not as a failed lookup.
 */
export function extractErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const detail = record.detail;
  if (detail && typeof detail === 'object') {
    const code = (detail as Record<string, unknown>).error_code;
    if (typeof code === 'string' && code.trim()) return code.trim();
  }
  const code = record.error_code;
  if (typeof code === 'string' && code.trim()) return code.trim();
  return null;
}

/**
 * HTTP statuses that mean "this credential is unusable", on *any* endpoint.
 *
 * **401 only.** The backend answers 401 for every credential rejection: `decode_token`
 * (`backend/app/utils/auth.py:22-38`) answers 401 "Invalid or expired token" when the
 * token does not verify or has expired, and `get_current_user` (same file, `:46-70`)
 * answers 401 "Not authenticated" when the header is missing or names no user.
 *
 * 403 is deliberately **not** here. In this backend a 403 means "you are authenticated,
 * but this action is not allowed": every business 403 carries
 * `detail = {error_code, message}` — `OUTFIT_ITEM_OWNERSHIP` when a garment is not yours
 * or not usable (`backend/app/api/outfits.py:632-639`, `:1479-1486`), `NOT_IN_FAMILY`
 * (`backend/app/services/outfit_service.py:180-186`), `Admin access required`,
 * `Access denied` — and each of them is a normal answer to a perfectly valid session.
 * Round 3's review (finding D) found the app logging the user out on one of those:
 * a business 403 was turned into an `AuthError`, the global handler cleared the token,
 * the secure store and the query cache, and the save screen's own 403 message never ran.
 * A worse case is losing an unsent draft because a chosen garment was archived between
 * picking it and saving.
 */
const AUTH_FAILURE_STATUSES = new Set([401]);

/**
 * The one 403 that *is* a credential failure, matched on the server's own wording.
 *
 * `get_current_user` (`backend/app/utils/auth.py:70-80`) answers 403 with the plain
 * detail `"User account is inactive"` when the token is valid but the account's
 * `is_active` is false. That is not "this action is not allowed" but "this account may
 * not do anything", so re-authentication is the only useful reaction.
 *
 * Recognized explicitly, by the exact string the server sends, rather than by counting
 * every 403 as fatal. It cannot collide with a business 403: those send an object detail
 * with an `error_code`, which `extractErrorMessage` renders as their `message`.
 */
const ACCOUNT_INACTIVE_DETAIL = 'User account is inactive';

/**
 * True when a status means "the credential was rejected" *for this request*.
 *
 * `body` is the parsed error body. It is read only to tell the account-level 403 apart
 * from a business one (`ACCOUNT_INACTIVE_DETAIL`); a 403 that does not carry that exact
 * detail stays an ordinary `ApiError`, so the screen keeps the session, the cache and
 * the user's draft and can act on the real problem.
 *
 * `credentialChecked` must be true only for endpoints whose response is gated on the
 * credential itself (currently `GET /auth/session`). There all three of 401 (invalid or
 * expired, or no user), 403 (account inactive) and 422 mean "this session cannot be
 * used": `/auth/session` validates `email` with pydantic `EmailStr`, so an account
 * created with a reserved domain (e.g. `dev@wardrobe.local`) makes that one endpoint
 * answer 422 while `/users/me` and `/items` still answer 200. FastAPI also answers 422
 * for any request-body validation failure (`RequestValidationError` in
 * `backend/app/main.py`), so a blanket 422 would turn a mistyped garment name into a
 * forced logout.
 */
export function isCredentialRejection(
  status: number,
  credentialChecked: boolean,
  body?: unknown,
): boolean {
  if (credentialChecked) return status === 401 || status === 403 || status === 422;
  if (status === 401) return true;
  return isAccountLevelForbidden(status, body);
}

/**
 * True for the 403 that denies the whole account (`is_active == false`), not one action.
 *
 * Used both by `isCredentialRejection` and, on the login screen's boot path, as the
 * documented reason a 403 may end a session.
 */
export function isAccountLevelForbidden(status: number, body?: unknown): boolean {
  if (status !== 403) return false;
  return extractErrorMessage(body) === ACCOUNT_INACTIVE_DETAIL;
}

/**
 * True for the statuses that mean "these credentials are unusable" on any endpoint.
 *
 * Kept as a named predicate because several call sites ask the question about a status
 * alone (a retry policy, a screen's error text); `isCredentialRejection` is the one that
 * also consults the body.
 */
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
