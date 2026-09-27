/**
 * Builds an absolute URL for the server's RELATIVE signed image paths.
 *
 * The backend returns e.g.
 *   /api/v1/images/<user_id>/<file>.jpg?expires=1750000000&sig=abcdef...
 *
 * Note the path ALREADY contains `/api/v1`, while `EXPO_PUBLIC_API_URL` does not
 * (it is a bare origin with no path suffix). Naively appending the path is
 * `/api/v1` again would produce `/api/v1/api/v1/...`. Absolute URLs are passed
 * through unchanged so externally hosted images keep working.
 */
export function joinUrl(
  baseUrl: string | null | undefined,
  path: string | null | undefined,
): string | null {
  // Without a configured API base we cannot build a fetchable URL; callers fall
  // back to their placeholder block rather than rendering a broken image.
  if (!baseUrl) return null;
  if (!path) return null;

  const trimmed = path.trim();
  if (!trimmed) return null;

  // Already absolute (external storage, or a proxy that rewrites to a CDN).
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  // Protocol-relative URL — inherit the scheme from the API base.
  if (trimmed.startsWith('//')) {
    const scheme = baseUrl.match(/^([a-z][a-z0-9+.-]*):/i)?.[1] ?? 'http';
    return `${scheme}:${trimmed}`;
  }

  const base = baseUrl.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? `${base}${trimmed}` : `${base}/${trimmed}`;
}

/**
 * Picks the best available image URL, mirroring the Web `ItemCard`.
 *
 * Preference order: thumbnail → medium → full image. Returns null when the item
 * has no image at all, which the callers render as a placeholder block.
 */
export function pickImageUrl(
  baseUrl: string | null,
  item: {
    thumbnail_url?: string | null;
    medium_url?: string | null;
    image_url?: string | null;
  },
): string | null {
  if (!baseUrl) return null;
  return (
    joinUrl(baseUrl, item.thumbnail_url) ??
    joinUrl(baseUrl, item.medium_url) ??
    joinUrl(baseUrl, item.image_url)
  );
}
