import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { useAuth } from '../auth/AuthContext';
import { OUTFITS_PAGE_SIZE, ITEMS_STALE_TIME_MS } from '../config/env';
import {
  createOutfit,
  deleteOutfit,
  getOutfit,
  getFullBodyCandidates,
  getSlotCandidates,
  listOutfits,
  patchOutfit,
  suggestOutfit,
  type SlotCandidates,
  type SuggestOutfitParams,
} from './outfits';
import type { Outfit, OutfitCreateFields, OutfitListResponse, OutfitPatchFields } from './types';
import { userScope } from './hooks';
import { ApiError, AuthError, NetworkError } from './errors';
import type { SlotKey } from './outfitVocab';
import { OWNED, type Ownership } from './toBuy';
import { invalidateOutfitViews } from './invalidations';

/**
 * Round-3 server-state hooks.
 *
 * Same rules as the wardrobe hooks in `./hooks.ts`, for the same reasons:
 *
 *  - every key is prefixed with the current `userId`, so one account's outfits and
 *    candidates can never be served from another account's cache;
 *  - a credential rejection (401, or a 403 that names an inactive account) is never retried
 *    (retrying a rejected credential just repeats it), and neither is a business 403 — but
 *    before round 3's fix a business 403 *was* treated as the former and logged the user out;
 *  - `staleTime` stays under the 1-hour signed-image lifetime, so a refetch can
 *    hand out fresh image signatures.
 */

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof AuthError) return false;
  if (error instanceof NetworkError) return failureCount < 2;
  if (error instanceof ApiError) return false;
  return failureCount < 2;
}

/** Every page of this user's saved-outfit list, plus any open outfit detail. */
async function invalidateOutfitList(queryClient: QueryClient, userId: string | null) {
  await invalidateOutfitViews(queryClient, userId);
}

/**
 * The candidate garments of one slot (see `getSlotCandidates` for why this walks the
 * server per type).
 *
 * `search` is part of the key, so the swipe list (no search) and the panel's search
 * results are separate cache entries and typing in the panel cannot disturb what the
 * slot is showing behind it. `ownership` is part of it too, for the same reason: the
 * 已拥有 and 待购 candidate sets must not be able to hand each other garments, and
 * buying a garment has to move it between the two.
 *
 * Not gated on AI: the endpoint behind it is `GET /items`, which works with every AI
 * flag off — that is a round-3 requirement, and the local backend runs with
 * `AI_INTERNAL_ENABLED=false`.
 */
export function useSlotCandidates(slot: SlotKey, search: string, ownership: Ownership = OWNED) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const trimmed = search.trim();

  return useQuery<SlotCandidates, Error>({
    queryKey: [...userScope(userId), 'slot-candidates', slot, trimmed, ownership],
    enabled: Boolean(userId),
    queryFn: ({ signal }) => getSlotCandidates(slot, { search: trimmed, ownership, signal }),
    staleTime: ITEMS_STALE_TIME_MS,
    retry: shouldRetry,
  });
}

/** Paginated list of saved outfits. */
export function useOutfits(search: string) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const trimmed = search.trim();

  return useInfiniteQuery<OutfitListResponse, Error>({
    queryKey: [...userScope(userId), 'outfits', { search: trimmed }],
    enabled: Boolean(userId),
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      listOutfits(
        { page: pageParam as number, page_size: OUTFITS_PAGE_SIZE, search: trimmed || undefined },
        signal,
      ),
    getNextPageParam: (lastPage) => (lastPage.has_more ? lastPage.page + 1 : undefined),
    staleTime: ITEMS_STALE_TIME_MS,
    retry: shouldRetry,
  });
}

/** One saved outfit, with its garments. */
export function useOutfit(outfitId: string | null) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useQuery<Outfit, Error>({
    queryKey: [...userScope(userId), 'outfit', outfitId],
    enabled: Boolean(userId) && Boolean(outfitId),
    queryFn: ({ signal }) => getOutfit(outfitId as string, signal),
    staleTime: ITEMS_STALE_TIME_MS,
    retry: shouldRetry,
  });
}

/**
 * Saves a new outfit.
 *
 * There is deliberately **no optimistic update and no de-duplication of retries**: the
 * endpoint has no idempotency key (`SuggestionCreateRequest` accepts only the outfit's
 * own fields), so the client cannot know whether a timed-out request was stored. The
 * screen handles that uncertainty explicitly instead of pretending otherwise.
 */
export function useCreateOutfit() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useMutation<Outfit, Error, OutfitCreateFields>({
    mutationFn: (fields) => createOutfit(fields),
    onSuccess: async (outfit) => {
      // Seed the detail cache so opening the new outfit renders the server's copy at
      // once, then refresh the list so the saved outfit is actually there.
      queryClient.setQueryData([...userScope(userId), 'outfit', outfit.id], outfit);
      await invalidateOutfitList(queryClient, userId);
    },
  });
}

/** Edits an existing outfit (name and/or its garments). */
export function usePatchOutfit(outfitId: string) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useMutation<Outfit, Error, OutfitPatchFields>({
    mutationFn: (fields) => patchOutfit(outfitId, fields),
    onSuccess: async (outfit) => {
      queryClient.setQueryData([...userScope(userId), 'outfit', outfitId], outfit);
      await invalidateOutfitList(queryClient, userId);
    },
  });
}

/**
 * Deletes an outfit.
 *
 * `DELETE /outfits/{id}` removes the `outfits` row; `outfit_items` disappears with it
 * (`ON DELETE CASCADE` on `outfit_items.outfit_id`). The FK that could have touched a
 * garment points the other way (`outfit_items.item_id → clothing_items.id`), and
 * `ClothingItem` is never loaded or deleted here — which is why the wardrobe must be
 * unchanged afterwards, and why the confirmation says so.
 */
export function useDeleteOutfit(outfitId: string) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useMutation<void, Error, void>({
    mutationFn: () => deleteOutfit(outfitId),
    onSuccess: async () => {
      // Drop the entry rather than invalidate it: re-fetching a deleted outfit would
      // 404, and a stale entry would render an outfit that no longer exists.
      queryClient.removeQueries({ queryKey: [...userScope(userId), 'outfit', outfitId] });
      await invalidateOutfitList(queryClient, userId);
    },
  });
}

/** Flattens the infinite pages into one array for rendering. */
export function flattenOutfits(data: OutfitListResponse[] | undefined): Outfit[] {
  if (!data) return [];
  return data.flatMap((page) => page.outfits);
}

/**
 * AI Outfit Suggestion (Round 5).
 * Calls POST /outfits/suggest with occasion, weather override, and current constraints.
 */
export function useSuggestOutfit() {
  return useMutation<Outfit, Error, SuggestOutfitParams>({
    mutationFn: (params) => suggestOutfit(params),
  });
}

/**
 * Candidate garments for full-body mode (连衣裙 / 连体衣, Round 5).
 */
export function useFullBodyCandidates(search: string, ownership: Ownership = OWNED) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const trimmed = search.trim();

  return useQuery<SlotCandidates, Error>({
    queryKey: [...userScope(userId), "fullbody-candidates", trimmed, ownership],
    enabled: Boolean(userId),
    queryFn: ({ signal }) => getFullBodyCandidates({ search: trimmed, ownership, signal }),
    staleTime: ITEMS_STALE_TIME_MS,
    retry: shouldRetry,
  });
}
