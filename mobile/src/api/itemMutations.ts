import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { useAuth } from '../auth/AuthContext';
import type { Item, ItemCreateFields, ItemUpdateFields, UploadablePhoto } from '../api/types';
import {
  analyzeItem,
  archiveItem,
  createItem,
  deleteItem,
  restoreItem,
  updateItem,
} from '../api/itemWrites';
import { userScope } from './hooks';

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
 * Every key is prefixed with the user scope so one account's writes can never
 * invalidate or seed another account's cache.
 */

/** Invalidates every page of the wardrobe list for this user. */
async function invalidateItemList(queryClient: QueryClient, userId: string | null): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: [...userScope(userId), 'items'] });
}

/** Invalidates the type filter counts, which change whenever items change. */
async function invalidateItemTypes(queryClient: QueryClient, userId: string | null): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: [...userScope(userId), 'item-types'] });
}

export function useCreateItem() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useMutation<Item, Error, { photo: UploadablePhoto; fields?: ItemCreateFields }>({
    mutationFn: ({ photo, fields }) => createItem(photo, fields),
    onSuccess: async (item) => {
      // Seed the detail cache so the "view this garment" action renders instantly.
      queryClient.setQueryData([...userScope(userId), 'item', item.id], item);
      await Promise.all([
        invalidateItemList(queryClient, userId),
        invalidateItemTypes(queryClient, userId),
      ]);
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
      await Promise.all([
        invalidateItemList(queryClient, userId),
        invalidateItemTypes(queryClient, userId),
      ]);
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
      await Promise.all([
        invalidateItemList(queryClient, userId),
        invalidateItemTypes(queryClient, userId),
      ]);
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
      await Promise.all([
        invalidateItemList(queryClient, userId),
        invalidateItemTypes(queryClient, userId),
      ]);
    },
  });
}

export function useDeleteItem(itemId: string) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useMutation<void, Error, void>({
    mutationFn: () => deleteItem(itemId),
    onSuccess: async () => {
      // Drop the detail entry rather than invalidate it: re-fetching a deleted
      // item would just 404, and a stale entry would render a phantom garment.
      queryClient.removeQueries({ queryKey: [...userScope(userId), 'item', itemId] });
      await Promise.all([
        invalidateItemList(queryClient, userId),
        invalidateItemTypes(queryClient, userId),
      ]);
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
      await invalidateItemList(queryClient, userId);
    },
  });
}
