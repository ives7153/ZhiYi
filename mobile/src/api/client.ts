import {
  API_NOT_CONFIGURED_MESSAGE,
  REQUEST_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  apiBaseUrl,
} from '../config/env';
import {
  ApiError,
  AuthError,
  NetworkError,
  extractErrorCode,
  extractErrorMessage,
  isCredentialRejection,
} from './errors';

/**
 * A single authenticated request path for the whole app.
 *
 * Responsibilities:
 *  - joins `EXPO_PUBLIC_API_URL` + `/api/v1` + path
 *  - injects `Authorization: Bearer <token>`
 *  - enforces a timeout with AbortController
 *  - classifies failures into NetworkError / AuthError / ApiError
 *
 * It never swallows an error: callers (React Query, screens) render the typed
 * error. It also never logs the token or the request headers.
 */

let accessToken: string | null = null;
let sessionEpoch = 0;
let sessionAbortController = new AbortController();
let onAuthFailure: (() => void) | null = null;

/**
 * Set by the auth context. The token lives in memory only.
 * Changing the token advances `sessionEpoch` and aborts all in-flight
 * authenticated requests from the previous session so a slow response from
 * Account A can never resolve into Account B's UI.
 */
export function setAccessToken(token: string | null): void {
  if (accessToken !== token) {
    sessionEpoch += 1;
    sessionAbortController.abort();
    sessionAbortController = new AbortController();
  }
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getSessionEpoch(): number {
  return sessionEpoch;
}

/**
 * Registers the global "credentials are unusable" handler.
 *
 * Called from AuthContext so that **one confirmed credential rejection** triggers one
 * logout instead of each screen inventing its own. Implemented as a hook rather than an
 * import so the API layer stays independent of React.
 *
 * Only `isCredentialRejection` may reach it. In particular a business 403 (another
 * account's garment, an archived garment, `NOT_IN_FAMILY`) is an `ApiError` and must NOT
 * clear the session: round 3's review found `PATCH /outfits/{id}` answering 403 for a
 * garment archived after it was picked, and the app dropping the login, the cached data
 * and the unsent draft instead of telling the user which garment was refused.
 */

export function setAuthFailureHandler(handler: (() => void) | null): void {
  onAuthFailure = handler;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON-serializable body. Sent as `application/json`. */
  body?: unknown;
  /** Query string values; `undefined`/`null` entries are dropped. */
  params?: Record<string, string | number | boolean | undefined | null>;
  /** Skip the Authorization header (used by the public auth endpoints). */
  skipAuth?: boolean;
  /** Explicit token override (used when revoking a previous session on logout). */
  tokenOverride?: string | null;
  /** Set false to let an auth failure surface as AuthError without auto-logout. */
  triggerAuthFailure?: boolean;
  /**
   * Marks an endpoint whose response is gated on the credential itself.
   *
   * Only `GET /auth/session` sets this. With it, a 422 also counts as a rejected
   * credential (the response model validates `email` as `EmailStr`, so a
   * reserved-domain address produces 422 on that one endpoint). Without it, 422
   * stays an ordinary validation error — otherwise any bad item payload would
   * log the user out.
   */
  credentialChecked?: boolean;
  /** Per-request timeout override. */
  timeoutMs?: number;
  /** Caller-supplied cancellation, combined with the timeout signal. */
  signal?: AbortSignal;
}

/** Serializes query params, dropping empty values. */
function buildQueryString(params: RequestOptions['params']): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

const API_PREFIX = '/api/v1';

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!apiBaseUrl) {
    // Configuration problem, not a transport problem: say exactly what to fix. Proven
    // never dispatched — there is no URL to send a request to — so this is the one
    // transport failure where a caller may say the write definitely did not happen.
    throw new NetworkError(API_NOT_CONFIGURED_MESSAGE, { outcomeUnknown: false });
  }

  const {
    method = 'GET',
    body,
    params,
    skipAuth = false,
    tokenOverride,
    triggerAuthFailure = true,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal,
    credentialChecked = false,
  } = options;

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${apiBaseUrl}${API_PREFIX}${normalizedPath}${buildQueryString(params)}`;

  const effectiveToken = tokenOverride !== undefined ? tokenOverride : accessToken;
  const trackSession = !skipAuth && tokenOverride === undefined;
  const requestEpoch = sessionEpoch;
  const sessionSignal = trackSession ? sessionAbortController.signal : null;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!skipAuth && effectiveToken) headers.Authorization = `Bearer ${effectiveToken}`;

  // AbortController handles timeout, caller cancellation, and session-switch cancellation.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort);
  }
  if (sessionSignal) {
    if (sessionSignal.aborted) controller.abort();
    else sessionSignal.addEventListener('abort', onExternalAbort);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    // A caller-driven or session-switch cancellation is a real cancellation, not a network fault.
    if (signal?.aborted || sessionSignal?.aborted || (trackSession && requestEpoch !== sessionEpoch)) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      // Our own timeout. The request was already dispatched, so the server may have
      // stored the write even though no answer was seen.
      throw new NetworkError('请求超时，请检查网络或后端地址后重试', {
        timedOut: true,
        outcomeUnknown: true,
      });
    }
    // Every other rejection — `TypeError('Network request failed')`, a DNS/TLS failure, a
    // connection dropped mid-response — carries no evidence about *when* it failed.
    // React Native and Expo report the same error for "never connected" and "delivered,
    // answer lost", so a write's outcome cannot be ruled out here; `outcomeUnknown: true`
    // is the honest classification and the screens say so instead of promising "未保存".
    throw new NetworkError('无法连接服务器，请检查网络或后端地址', {
      outcomeUnknown: true,
    });
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
    if (sessionSignal) sessionSignal.removeEventListener('abort', onExternalAbort);
  }

  if (trackSession && requestEpoch !== sessionEpoch) {
    const staleError = new Error('Session changed; stale response discarded');
    staleError.name = 'AbortError';
    throw staleError;
  }

  // 204 No Content has no body to parse.
  if (response.status === 204) return undefined as T;
  if (!response.ok) {
    // The status already says the server refused the request, so a body that cannot be
    // read must not replace that with a vaguer transport story: classify on the status
    // and lose only the server's own wording.
    const parsed = await readResponseBodyOrNull(response);
    const detail = extractErrorMessage(parsed);

    if (isCredentialRejection(response.status, credentialChecked, parsed)) {
      const authError = new AuthError(
        detail ?? '登录已过期，请重新登录',
        response.status,
      );
      // One global reaction per failure; screens just render the AuthError text.
      if (triggerAuthFailure) onAuthFailure?.();
      throw authError;
    }

    // The machine-readable code and the raw body travel with the error so a screen can
    // act on *which* business answer it got (two different 409s read very differently)
    // without parsing the human message.
    throw new ApiError(
      detail ?? `请求失败（HTTP ${response.status}）`,
      response.status,
      detail,
      extractErrorCode(parsed),
      parsed,
    );
  }

  // A *successful* response whose body cannot be read is the uncertain case: the write the
  // server just accepted may already be stored, so it must not surface as a parse error.
  const result = (await readResponseBody(response)) as T;
  if (trackSession && requestEpoch !== sessionEpoch) {
    const staleError = new Error('Session changed; stale response discarded');
    staleError.name = 'AbortError';
    throw staleError;
  }
  return result;
}

/**
 * Reads a response body, classifying a failure to read it as a transport failure.
 *
 * Rejects 204/empty bodies as `null` and non-JSON bodies as their raw text, so both
 * callers keep the behaviour they had before this was factored out.
 *
 * The `catch` is the point of this function. A body that fails to arrive (the stream
 * breaks after the headers) is not an `ApiError` and not a validation problem: the server
 * answered, which means **the request was delivered**. Before this existed the
 * `response.text()` call sat outside every `try`, so such a failure escaped as a bare
 * `TypeError` and the save screens rendered their generic "保存失败 …已经选好的单品不会
 * 丢失" — a promise the client cannot make (round-3 review finding B). Now it becomes a
 * `NetworkError` with `outcomeUnknown: true`, which is what the screens key on.
 */
async function readResponseBody(response: Response): Promise<unknown> {
  let rawText: string;
  try {
    rawText = await response.text();
  } catch {
    throw new NetworkError('已收到服务器响应但内容读取失败，请稍后确认结果', {
      outcomeUnknown: true,
    });
  }

  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    // Non-JSON body: keep the text so the error message is still meaningful.
    return rawText;
  }
}

/**
 * `readResponseBody`, for a response whose status already decided the outcome.
 *
 * A 4xx/5xx means the server answered and refused, so the request certainly did not take
 * effect; the body is only extra detail. If even that cannot be read, returning `null`
 * keeps the status-based classification (`ApiError(403)` etc.) instead of relabelling a
 * refusal as an uncertain transport failure.
 */
async function readResponseBodyOrNull(response: Response): Promise<unknown> {
  try {
    return await readResponseBody(response);
  } catch {
    return null;
  }
}

/**
 * Turns a failed response into the right typed error, for the multipart path.
 *
 * The status rules are deliberately not re-implemented here: `isCredentialRejection` decides
 * what counts as a rejected credential, exactly as it does for `request()`. What this function
 * adds is the global reaction to that verdict — which the upload path used to skip entirely.
 *
 * `triggerAuthFailure` exists because the two paths have different callers, not because they
 * classify differently. `request()` lets a call site opt out (the login screen's
 * `/auth/session` probe must not recurse into a logout); an upload has no such case, because
 * both endpoints it reaches — `POST /items` and `POST /items/bulk` — answer 401 for a dead
 * token and 403 only for an inactive account, and either one means the session is over.
 *
 * Without this, a 401 during an upload produced an `AuthError` that no screen handled by class:
 * `app/item/new.tsx` fell through to its generic "保存失败" copy, the dead token stayed in place
 * and the user was never shown the login screen.
 *
 * It fires at most once per failure — the throw follows immediately — and `AuthContext` guards
 * its own teardown against re-entry (`signingOutRef`), so simultaneous failures cannot produce
 * more than one logout.
 */
async function throwForFailure(
  response: Response,
  options: { credentialChecked: boolean; triggerAuthFailure: boolean },
): Promise<never> {
  const parsed = await readResponseBodyOrNull(response);
  const detail = extractErrorMessage(parsed);

  if (isCredentialRejection(response.status, options.credentialChecked, parsed)) {
    if (options.triggerAuthFailure) onAuthFailure?.();
    throw new AuthError(detail ?? '登录已过期，请重新登录', response.status);
  }

  throw new ApiError(
    detail ?? `请求失败（HTTP ${response.status}）`,
    response.status,
    detail,
    extractErrorCode(parsed),
    parsed,
  );
}

/**
 * Uploads a multipart/form-data body.
 *
 * A separate function rather than an option on `request()` for one specific
 * reason: **`Content-Type` must NOT be set by hand**. `fetch` has to generate it
 * itself in order to include the multipart boundary; sending
 * `multipart/form-data` without a boundary produces a request the server cannot
 * parse at all.
 *
 * `Content-Type` is set by `fetch`, never by hand: `fetch` has to generate it in
 * order to include the multipart boundary, and `multipart/form-data` without a
 * boundary is a body the server cannot parse.
 *
 * ---------------------------------------------------------------------------
 * Why file parts must be a Blob and NOT `{ uri, name, type }`
 * ---------------------------------------------------------------------------
 * The classic React Native idiom is to append `{ uri, name, type }` and let RN's
 * native networking stack open the file. **That idiom does not work under Expo
 * SDK 57**, and it fails in the worst possible way — silently.
 *
 * Expo replaces the global `fetch` (see `expo/src/winter/fetch`) and serializes
 * the body in JavaScript rather than delegating to the native stack:
 * `convertFormDataAsync` handles `string`, `Blob` and objects with `bytes()`, and
 * for anything else it throws `Unsupported FormDataPart implementation`
 * (`expo/src/winter/fetch/convertFormData.ts`). A `{ uri, ... }` part is not a
 * `Blob` and has no `bytes()`, so every upload throws — and because the request
 * is aborted inside `fetch`, *nothing reaches the server at all*: no request log,
 * no timeout, just an immediate failure. The doc comment on that function even
 * states it outright: "`uri` is not supported for React Native's FormData."
 *
 * `expo-file-system`'s `File` class is the supported replacement: it implements
 * `Blob`, and its `bytes()` returns a `Uint8Array`, which is the exact shape
 * `convertFormDataAsync` accepts. Uploads therefore go through `Blob` parts.
 *
 * The uri file part is still accepted here for callers that have one, but it is
 * only safe on a runtime that keeps React Native's native networking. Callers in
 * this app always convert first (see `src/media/photoPicker.ts`).
 */
export async function requestMultipart<T>(
  path: string,
  form: FormData,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  if (!apiBaseUrl) {
    // Proven not to have been dispatched: there is no URL to send a request to, so this
    // is the one transport failure that may claim nothing was stored.
    throw new NetworkError(API_NOT_CONFIGURED_MESSAGE, { outcomeUnknown: false });
  }

  const { timeoutMs = UPLOAD_TIMEOUT_MS, signal } = options;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${apiBaseUrl}${API_PREFIX}${normalizedPath}`;

  const requestEpoch = sessionEpoch;
  const sessionSignal = sessionAbortController.signal;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  // Deliberately no Content-Type: fetch must set it, with the boundary.

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort);
  }
  if (sessionSignal.aborted) controller.abort();
  else sessionSignal.addEventListener('abort', onExternalAbort);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted || sessionSignal.aborted || requestEpoch !== sessionEpoch) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      // Our own timeout: the upload was dispatched, so the server may have stored it.
      throw new NetworkError('上传超时，请检查网络后重试', {
        timedOut: true,
        outcomeUnknown: true,
      });
    }
    throw new NetworkError('无法连接服务器，请检查网络或后端地址', {
      outcomeUnknown: true,
    });
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
    sessionSignal.removeEventListener('abort', onExternalAbort);
  }

  if (requestEpoch !== sessionEpoch) {
    const staleError = new Error('Session changed; stale upload response discarded');
    staleError.name = 'AbortError';
    throw staleError;
  }
  // An upload has no case where a credential rejection may be ignored, so it always triggers
  // the global reaction; `triggerAuthFailure` is what the JSON path makes configurable.
  if (!response.ok) {
    await throwForFailure(response, { credentialChecked: false, triggerAuthFailure: true });
  }
  if (response.status === 204) return undefined as T;

  const parsed = await readResponseBody(response);
  if (requestEpoch !== sessionEpoch) {
    const staleError = new Error('Session changed; stale upload response discarded');
    staleError.name = 'AbortError';
    throw staleError;
  }
  if (parsed === null) return undefined as T;
  if (typeof parsed === 'string') {
    throw new ApiError('服务器返回了无法解析的响应', response.status, parsed);
  }
  return parsed as T;
}
