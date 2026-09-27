/**
 * Environment configuration.
 *
 * `EXPO_PUBLIC_*` variables are inlined by Expo at bundle time — see
 * https://docs.expo.dev/guides/environment-variables/. Only non-sensitive values
 * may live here; the access token never does.
 *
 * The API base URL is the single source of truth for every request. It is
 * deliberately NOT defaulted to any host: a baked-in fallback is how production
 * addresses leak into builds, and a silently wrong default produces confusing
 * network errors instead of a clear message.
 */

/** Raw value injected by Expo, or undefined when the variable was not set. */
const rawApiUrl = process.env.EXPO_PUBLIC_API_URL;

/** Scheme used for the OIDC redirect. Must match `backend/app/api/auth.py` MOBILE_APP_SCHEME. */
const rawRedirectScheme = process.env.EXPO_PUBLIC_OIDC_REDIRECT_SCHEME;

export const DEFAULT_REDIRECT_SCHEME = 'wardrowbe';

/**
 * Normalizes the API base URL: trims surrounding whitespace and trailing slashes.
 * Returns null when the variable is missing or blank so callers can surface a
 * human-readable configuration error instead of crashing at module load.
 */
function normalizeBaseUrl(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

export const apiBaseUrl = normalizeBaseUrl(rawApiUrl);

export const redirectScheme = rawRedirectScheme?.trim() || DEFAULT_REDIRECT_SCHEME;

/** True when EXPO_PUBLIC_API_URL was provided and usable. */
export const isApiConfigured = apiBaseUrl !== null;

/**
 * Message shown when the API base URL is absent. Kept in one place so the login
 * screen, the request wrapper and the profile screen all say the same thing.
 */
export const API_NOT_CONFIGURED_MESSAGE =
  '未配置后端地址。请在 mobile/.env 中设置 EXPO_PUBLIC_API_URL 后重新启动开发服务器。';

/**
 * Content types the backend accepts for an uploaded image.
 *
 * Source: `backend/app/services/image_service.py` (`ALLOWED_MIME_TYPES` and
 * `ALLOWED_EXTENSIONS`). The server validates BOTH the declared MIME type and the
 * uploaded filename's extension, so both have to agree or the upload is a 400.
 */
export const ALLOWED_UPLOAD_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

/** Request timeout in milliseconds. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Upload timeout in milliseconds.
 *
 * A phone photo is several megabytes and mobile upload bandwidth is a fraction of
 * the local network's, so the 15s that suits a JSON call would abort perfectly
 * healthy uploads. 60s still bounds a genuinely stuck request.
 */
export const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Longest edge the client resizes a photo to before uploading.
 *
 * The server stores a 2400px original (`SIZES['original']`) and derives 800px and
 * 400px versions. 1600 sits under that ceiling, so the client never upscales and
 * the server still owns the derivative sizes; the only thing the client is doing
 * is cutting upload bytes for a photo whose detail the server will discard anyway.
 */
export const UPLOAD_MAX_EDGE_PX = 1600;

/** JPEG quality used when re-encoding a picked photo. 0..1. */
export const UPLOAD_JPEG_QUALITY = 0.8;

/**
 * Signed image URLs expire after 1 hour server-side
 * (`DEFAULT_EXPIRY_SECONDS = 3600`). List cache entries must go stale sooner
 * than that so a refetch can hand out a fresh signature.
 */
export const ITEMS_STALE_TIME_MS = 60_000;

/** Poll interval while any wardrobe item is still being processed. */
export const POLL_PROCESSING_MS = 5_000;

/** Poll interval when nothing is processing. */
export const POLL_IDLE_MS = 30_000;

/** Page size for the wardrobe list. Kept well under the server's 100 cap. */
export const ITEMS_PAGE_SIZE = 20;
