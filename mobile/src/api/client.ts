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
let onAuthFailure: (() => void) | null = null;

/** Set by the auth context. The token lives in memory only. */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/**
 * Registers the global "credentials are unusable" handler.
 *
 * Called from AuthContext so that any screen hitting a 401/403/422 triggers one
 * logout instead of each screen inventing its own. Implemented as a hook rather
 * than an import so the API layer stays independent of React.
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
    // Configuration problem, not a transport problem: say exactly what to fix.
    throw new NetworkError(API_NOT_CONFIGURED_MESSAGE);
  }

  const {
    method = 'GET',
    body,
    params,
    skipAuth = false,
    triggerAuthFailure = true,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal,
    credentialChecked = false,
  } = options;

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${apiBaseUrl}${API_PREFIX}${normalizedPath}${buildQueryString(params)}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!skipAuth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  // AbortController handles both the timeout and caller cancellation.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort);
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
    // A caller-driven cancellation is a real cancellation, not a network fault.
    if (signal?.aborted) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new NetworkError('请求超时，请检查网络或后端地址后重试');
    }
    throw new NetworkError('无法连接服务器，请检查网络或后端地址');
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }

  // 204 No Content has no body to parse.
  if (response.status === 204) return undefined as T;

  const rawText = await response.text();
  let parsed: unknown = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Non-JSON body: keep the text so the error message is still meaningful.
      parsed = rawText;
    }
  }

  if (!response.ok) {
    const detail = extractErrorMessage(parsed);

    if (isCredentialRejection(response.status, credentialChecked)) {
      const authError = new AuthError(
        detail ?? '登录已过期，请重新登录',
        response.status,
      );
      // One global reaction per failure; screens just render the AuthError text.
      if (triggerAuthFailure) onAuthFailure?.();
      throw authError;
    }

    throw new ApiError(detail ?? `请求失败（HTTP ${response.status}）`, response.status, detail);
  }

  return parsed as T;
}

/**
 * Turns a failed response into the right typed error.
 *
 * Shared by the JSON and multipart paths so both classify errors identically
 * instead of each inventing its own status-code rules.
 */
async function throwForFailure(response: Response, credentialChecked: boolean): Promise<never> {
  const rawText = await response.text();
  let parsed: unknown = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = rawText;
    }
  }

  const detail = extractErrorMessage(parsed);

  if (isCredentialRejection(response.status, credentialChecked)) {
    throw new AuthError(detail ?? '登录已过期，请重新登录', response.status);
  }

  throw new ApiError(detail ?? `请求失败（HTTP ${response.status}）`, response.status, detail);
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
    throw new NetworkError(API_NOT_CONFIGURED_MESSAGE);
  }

  const { timeoutMs = UPLOAD_TIMEOUT_MS, signal } = options;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${apiBaseUrl}${API_PREFIX}${normalizedPath}`;

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

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new NetworkError('上传超时，请检查网络后重试');
    }
    throw new NetworkError('无法连接服务器，请检查网络或后端地址');
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }

  if (!response.ok) await throwForFailure(response, false);
  if (response.status === 204) return undefined as T;

  const rawText = await response.text();
  if (!rawText) return undefined as T;
  try {
    return JSON.parse(rawText) as T;
  } catch {
    throw new ApiError('服务器返回了无法解析的响应', response.status, rawText);
  }
}
