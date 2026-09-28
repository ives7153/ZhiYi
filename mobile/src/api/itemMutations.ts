import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../auth/AuthContext';
import type { Item, ItemCreateFields, ItemUpdateFields, UploadablePhoto } from '../api/types';
import {
  analyzeItem,
  archiveItem,
  createItem,
  deleteItem,
  purchaseItem,
  restoreItem,
  updateItem,
} from '../api/itemWrites';
import { userScope } from './hooks';
import {
  invalidateItemViews,
  invalidateWardrobeAndOutfits,
} from './invalidations';
import type { Ownership } from './toBuy';

/**
 * Round-2 write hooks.
 *
 * Cache strategy, which is the whole reason these live together:
 *
 *  - After a **create** the new item may belong on any page of the infinite list,
 *    and the default list only shows non-archived rows, so the correct and
 *    cheapest reaction is to invalidate the list rather than try to splice the
 *    item into a page by hand.
 *  - After an **update** the server's copy is authoritative (it recomputes
 *    `updated_at`, and editing a tag field flips `tagging_status` to `tagged`),
 *    so the returned item is written straight into the detail cache and the list
 *    is invalidated. Seeding the detail cache means the detail screen shows the
 *    saved values immediately instead of flashing stale ones.
 *  - After **archive / restore / delete** the item enters or leaves the default
 *    list entirely, so both the list and the detail entry must be refreshed —
 *    for a delete the detail entry is removed outright, because keeping it would
 *    let a back-navigation render a garment that no longer exists.
 *
 * Round 4 widens "the list" to "every view the item appears in": the 待购 list, both
 * sides' category counts, the slot candidate panels, and the 「试搭·含待购」 marker of
 * any saved outfit. `invalidateItemViews` / `invalidateWardrobeAndOutfits` own that
 * spread (see `./invalidations.ts`) so no single screen has to remember it, and every
 * key they touch is prefixed with the user scope, so one account's writes can never
 * invalidate or seed another account's cache.
 */

export function useCreateItem() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useMutation<Item, Error, { photo: UploadablePhoto; fields?: ItemCreateFields }>({
    mutationFn: ({ photo, fields }) => createItem(photo, fields),
    onSuccess: async (item) => {
      // Seed the detail cache so the "view this garment" action renders instantly.
      queryClient.setQueryData([...userScope(userId), 'item', item.id], item);
      await invalidateItemViews(queryClient, userId);
    },
  });
}

export function useUpdateItem(itemId: string) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useMutation<Item, Error, ItemUpdateFields>({
    mutationFn: (fields) => updateItem(itemId, fields),
    onSuccess: async (item) => {
      queryClient.setQueryData([...userScope(userId), 'item', itemId], item);
      await invalidateItemViews(queryClient, userId);
    },
  });
}

export function useArchiveItem(itemId: string) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useMutation<Item, Error, string | undefined>({
    mutationFn: (reason) => archiveItem(itemId, reason),
    onSuccess: async (item) => {
      queryClient.setQueryData([...userScope(userId), 'item', itemId], item);
      // An archived garment leaves every candidate set and every list, so the outfits
      // that referenced it have to re-render too.
      await invalidateWardrobeAndOutfits(queryClient, userId);
    },
  });
}

export function useRestoreItem(itemId: string) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useMutation<Item, Error, void>({
    mutationFn: () => restoreItem(itemId),
    onSuccess: async (item) => {
      queryClient.setQueryData([...userScope(userId), 'item', itemId], item);
      await invalidateWardrobeAndOutfits(queryClient, userId);
    },
  });
}

/**
 * Deletes a garment.
 *
 * `ownership` is forwarded to the endpoint's guard. The 待购 detail screen passes
 * `'to_buy'` so a page that was opened before another device bought the garment cannot
 * delete a row that is now part of the wardrobe (the server answers 409 and keeps it).
 */
export function useDeleteItem(itemId: string, ownership?: Ownership) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useMutation<void, Error, void>({
    mutationFn: () => deleteItem(itemId, { ownership }),
    onSuccess: async () => {
      // Drop the detail entry rather than invalidate it: re-fetching a deleted
      // item would just 404, and a stale entry would render a phantom garment.
      queryClient.removeQueries({ queryKey: [...userScope(userId), 'item', itemId] });
      // `DELETE /items/{id}` cascades to `outfit_items`, so saved outfits change as
      // well and must not keep rendering a garment that no longer exists.
      await invalidateWardrobeAndOutfits(queryClient, userId);
    },
  });
}

/**
 * 标记已购买 — 待购 → 已拥有 (round 4, step 3).
 *
 * Writes the returned item straight into the detail cache (same id, so the screen that
 * was showing the 待购 record immediately shows the owned one) and invalidates every
 * derived view: the 待购 list and its count, the wardrobe list and its count, both
 * category filters, the slot candidate panels, and the outfit markers.
 *
 * No optimistic update: the server decides the outcome, and the screen renders what it
 * returns. That keeps a repeat request honest — the endpoint is idempotent, so the
 * second call answers with the same garment rather than creating a second one.
 */
export function usePurchaseItem(itemId: string) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useMutation<Item, Error, void>({
    mutationFn: () => purchaseItem(itemId),
    onSuccess: async (item) => {
      queryClient.setQueryData([...userScope(userId), 'item', itemId], item);
      await invalidateWardrobeAndOutfits(queryClient, userId);
    },
  });
}

/**
 * Asks the server to (re)run AI tagging for one item.
 *
 * The response is the server's decision, not a client guess: when vision is
 * disabled it answers `deferred` and the item stays manually manageable, which is
 * exactly the behaviour the round-2 spec requires when AI is unavailable.
 */
export function useAnalyzeItem(itemId: string) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useMutation({
    mutationFn: () => analyzeItem(itemId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...userScope(userId), 'item', itemId],
      });
      await invalidateItemViews(queryClient, userId);
    },
  });
}
