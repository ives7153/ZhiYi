import { request } from './client';
import type {
  BulkUploadResponse,
  BulkUploadResult,
  CapabilitiesResponse,
  Item,
  ItemListParams,
  ItemListResponse,
  ItemTypeCount,
  UserProfile,
} from './types';
import { OWNED, type Ownership } from './toBuy';
import type { ItemCreateFields, ItemUpdateFields, UploadablePhoto } from './itemVocab';

/**
 * Wardrobe read endpoints. Round 1 is read-only — no create/update/delete.
 * `page` is 1-based and `page_size` is capped at 100 by the server
 * (`Query(20, ge=1, le=100)`).
 */
export function getItems(params: ItemListParams, signal?: AbortSignal): Promise<ItemListResponse> {
  return request<ItemListResponse>('/items', {
    params: {
      page: params.page,
      page_size: params.page_size,
      type: params.type,
      subtype: params.subtype,
      colors: params.colors,
      status: params.status,
      tagging_status: params.tagging_status,
      favorite: params.favorite,
      needs_wash: params.needs_wash,
      is_archived: params.is_archived,
      search: params.search,
      sort_by: params.sort_by,
      sort_order: params.sort_order,
      ownership: params.ownership,
    },
    signal,
  });
}

/** `GET /items/{id}` — 404 `{"detail":"Item not found"}` when not owned. */
export function getItem(itemId: string, signal?: AbortSignal): Promise<Item> {
  return request<Item>(`/items/${encodeURIComponent(itemId)}`, { signal });
}

/**
 * `GET /items/types` — available types with counts, for a filter row.
 *
 * `ownership` selects which side is counted: the wardrobe's chips use `owned` (the
 * server's default, and what every pre-round-4 caller gets) and the 待购 screen asks
 * for `to_buy` explicitly, so a planned garment can never inflate a wardrobe count.
 */
export function getItemTypes(
  ownership: Ownership = OWNED,
  signal?: AbortSignal,
): Promise<ItemTypeCount[]> {
  return request<ItemTypeCount[]>('/items/types', { params: { ownership }, signal });
}

/**
 * `GET /capabilities` — server-side feature flags.
 *
 * `ai.vision === false` means the internal AI is switched off server-side, so any
 * UI that promises automatic recognition would be lying. This is the server's own
 * report (`/capabilities` in `backend/app/api/health.py`-adjacent router), not a
 * client-side build constant.
 */
export function getCapabilities(signal?: AbortSignal): Promise<CapabilitiesResponse> {
  return request<CapabilitiesResponse>('/capabilities', { signal });
}

/** `GET /users/me` — profile used by the 我的 screen. */
export function getUserProfile(signal?: AbortSignal): Promise<UserProfile> {
  return request<UserProfile>('/users/me', { signal });
}

/** `PATCH /users/me` — update profile (display_name, location, etc.). */
export function updateUserProfile(data: {
  display_name?: string;
  location_name?: string | null;
  location_lat?: number | null;
  location_lon?: number | null;
}): Promise<UserProfile> {
  return request<UserProfile>('/users/me', {
    method: 'PATCH',
    body: data,
  });
}
