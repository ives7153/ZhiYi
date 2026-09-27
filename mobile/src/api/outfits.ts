import { getItems } from './items';
import { request } from './client';
import type {
  Item,
  Outfit,
  OutfitCreateFields,
  OutfitListParams,
  OutfitListResponse,
  OutfitPatchFields,
} from './types';
import { SLOT_TYPES, type SlotKey } from './outfitVocab';

/**
 * Round-3 outfit endpoints, transcribed from `backend/app/api/outfits.py`:
 *
 *   POST   /outfits/suggestions  201 OutfitResponse   (SuggestionCreateRequest)
 *   GET    /outfits              OutfitListResponse   (page/page_size/search/…)
 *   GET    /outfits/{id}         OutfitResponse      404 OUTFIT_NOT_FOUND if not owned
 *   PATCH  /outfits/{id}         OutfitResponse      422 PATCH_EMPTY when neither field
 *                                                    409 OUTFIT_WORN_IMMUTABLE when worn
 *                                                    403 OUTFIT_ITEM_OWNERSHIP
 *   DELETE /outfits/{id}         204
 *
 * All of them are owner-scoped: the handlers filter on `Outfit.user_id == current_user.id`
 * (directly, or through `StudioService`), so another account's id answers 404 instead of
 * leaking a row.
 *
 * Why `POST /outfits/suggestions` and not `POST /outfits/studio`:
 *
 *  - `/studio` is behind the `studio_disabled` kill switch and additionally applies
 *    `mark_worn` wear tracking and a synthetic *accepted* feedback row
 *    (`StudioService.create_from_scratch` → `learning.create_synthetic_feedback`).
 *    Saving a slot combination is not "this was worn and accepted", so writing that
 *    feedback would be a fabricated signal into the learning pipeline.
 *  - `/suggestions` is the endpoint for externally authored outfits
 *    (`source='external'`, status `pending`, no feedback), which is exactly what a
 *    user-composed outfit is. `GET /capabilities` reports it enabled
 *    (`features.external_suggestions: true`).
 *
 * Both share `validate_item_ownership`, so neither can be used to attach another
 * account's garment.
 */

/** `GET /api/v1/outfits` */
export function listOutfits(
  params: OutfitListParams,
  signal?: AbortSignal,
): Promise<OutfitListResponse> {
  return request<OutfitListResponse>('/outfits', {
    params: {
      page: params.page,
      page_size: params.page_size,
      search: params.search,
    },
    signal,
  });
}

/** `GET /api/v1/outfits/{id}` — 404 when the outfit does not exist or is not ours. */
export function getOutfit(outfitId: string, signal?: AbortSignal): Promise<Outfit> {
  return request<Outfit>(`/outfits/${encodeURIComponent(outfitId)}`, { signal });
}

/** `POST /api/v1/outfits/suggestions` — 201 with the stored outfit. */
export function createOutfit(fields: OutfitCreateFields): Promise<Outfit> {
  return request<Outfit>('/outfits/suggestions', { method: 'POST', body: fields });
}

/** `PATCH /api/v1/outfits/{id}` — at least one of `name` / `items` must be present. */
export function patchOutfit(outfitId: string, fields: OutfitPatchFields): Promise<Outfit> {
  return request<Outfit>(`/outfits/${encodeURIComponent(outfitId)}`, {
    method: 'PATCH',
    body: fields,
  });
}

/** `DELETE /api/v1/outfits/{id}` — 204. Removes the outfit row only, never a garment. */
export function deleteOutfit(outfitId: string): Promise<void> {
  return request<void>(`/outfits/${encodeURIComponent(outfitId)}`, { method: 'DELETE' });
}

/* ------------------------------------------------------------------ *
 * Slot candidate loading.
 *
 * `GET /items` filters on **one** exact `type` (`ItemFilter.type` →
 * `ClothingItem.type == filters.type`); there is no multi-type or role filter, and the
 * 搭配 endpoints expose no "garments of this slot" listing either. A slot is a group of
 * types (上衣 = 7 of them, 下装 covers trousers and skirts), so one request cannot
 * describe it.
 *
 * The loader below therefore walks the server's own pages **once per type** and merges
 * the results, instead of asking for page 1 of each type and calling that the slot. Two
 * properties matter for the round-3 requirement "支持搜索和分页，不能用第一页冒充全部衣物":
 *
 *  - the merge runs until a type reports `has_more === false`, so the set it returns is
 *    the *complete* candidate list, not a first page. The panel then paginates over that
 *    complete set, which is why every garment is reachable;
 *  - `search` is passed to the server on every request, so searching is a real
 *    server-side match on name/brand/type/notes, not a filter over an already-truncated
 *    page.
 *
 * `MAX_PAGES_PER_TYPE` bounds the work (7 types × 5 pages × 100 = at most 3500 rows for
 * 上衣). If it is ever reached the result is flagged `truncated` and the panel says so,
 * rather than silently presenting a partial list as complete.
 * ------------------------------------------------------------------ */

/** Server cap on `page_size` (`Query(20, ge=1, le=100)`). */
const CANDIDATE_PAGE_SIZE = 100;

/** Pages fetched per type before giving up and reporting truncation. */
export const MAX_PAGES_PER_TYPE = 5;

export interface SlotCandidates {
  items: Item[];
  /** True when a type still had more rows after `MAX_PAGES_PER_TYPE` pages. */
  truncated: boolean;
  /** Number of server requests made; surfaced for the acceptance harness log. */
  requests: number;
}

/**
 * Every non-archived garment of a slot's types, newest first.
 *
 * `is_archived=false` is sent explicitly: the server's default is `False` too, but the
 * requirement is "本用户可用、未归档衣物", and stating it in the request keeps that
 * independent of a future default change.
 *
 * Archived rows are excluded here *and* rejected by the server on save
 * (`validate_item_ownership` requires `status == ready`, and archiving sets
 * `status = archived`), so an archived garment cannot enter an outfit either way.
 */
export async function getSlotCandidates(
  slot: SlotKey,
  options: { search?: string; signal?: AbortSignal } = {},
): Promise<SlotCandidates> {
  const types = SLOT_TYPES[slot];
  const search = options.search?.trim() || undefined;

  let requests = 0;
  let truncated = false;
  const byId = new Map<string, Item>();

  for (const type of types) {
    for (let page = 1; page <= MAX_PAGES_PER_TYPE; page += 1) {
      const response = await getItems(
        {
          page,
          page_size: CANDIDATE_PAGE_SIZE,
          type,
          is_archived: false,
          search,
          // Explicit rather than relying on the default: this is the ordering the
          // merge below re-applies, so both have to agree.
          sort_by: 'created_at',
          sort_order: 'desc',
        },
        options.signal,
      );
      requests += 1;
      for (const item of response.items) byId.set(item.id, item);
      if (!response.has_more) break;
      if (page === MAX_PAGES_PER_TYPE) truncated = true;
    }
  }

  // Re-apply the server's own ordering to the merged set: created_at desc, id asc.
  // Without this, the list would be grouped by type, which is not an order the server
  // ever produces and would make "next candidate" depend on the slot's type order.
  const items = [...byId.values()].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });

  return { items, truncated, requests };
}
