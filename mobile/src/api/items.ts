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
    },
    signal,
  });
}

/** `GET /items/{id}` — 404 `{"detail":"Item not found"}` when not owned. */
export function getItem(itemId: string, signal?: AbortSignal): Promise<Item> {
  return request<Item>(`/items/${encodeURIComponent(itemId)}`, { signal });
}

/** `GET /items/types` — available types with counts, for the filter row. */
export function getItemTypes(signal?: AbortSignal): Promise<ItemTypeCount[]> {
  return request<ItemTypeCount[]>('/items/types', { signal });
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
