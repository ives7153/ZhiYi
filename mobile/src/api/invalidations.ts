import type { QueryClient } from '@tanstack/react-query';

import { userScope } from './hooks';

/**
 * Cache invalidation for everything one garment or outfit can appear in.
 *
 * Round 4's rule is that a change must refresh **every** view it affects, not just the
 * one the user is looking at: buying a garment moves it from 待购 to 衣橱, changes both
 * lists' totals, both category counts, the candidate set of a slot, and the
 * 「试搭·含待购」 marker of every outfit that used it — possibly on screens that are
 * already mounted behind the current one. Editing, archiving or deleting has the same
 * spread.
 *
 * Every key is prefixed with the current `userId` (`userScope`), so invalidating for
 * one account can never touch another account's cached data; and because React Query
 * matches by key prefix, `['user', id, 'items']` refreshes every page and every filter
 * combination of the wardrobe/待购 lists at once.
 */

/** Wardrobe/待购 lists, their counts, slot candidates: everything derived from items. */
export async function invalidateItemViews(
  queryClient: QueryClient,
  userId: string | null,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: [...userScope(userId), 'items'] }),
    queryClient.invalidateQueries({ queryKey: [...userScope(userId), 'item-types'] }),
    // A slot's candidate list is a *view of the items*, filtered by ownership; a
    // garment that changed side must disappear from (or appear in) the right one.
    queryClient.invalidateQueries({ queryKey: [...userScope(userId), 'slot-candidates'] }),
  ]);
}

/**
 * Saved outfits and their markers.
 *
 * Needed after any item write because an outfit's `contains_to_buy` flag and each
 * garment's ownership are read from the item rows: a purchase can flip a marker on a
 * screen the user is not looking at.
 */
export async function invalidateOutfitViews(
  queryClient: QueryClient,
  userId: string | null,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: [...userScope(userId), 'outfits'] }),
    queryClient.invalidateQueries({ queryKey: [...userScope(userId), 'outfit'] }),
  ]);
}

/** The full spread: item writes change outfit markers, and vice versa. */
export async function invalidateWardrobeAndOutfits(
  queryClient: QueryClient,
  userId: string | null,
): Promise<void> {
  await Promise.all([
    invalidateItemViews(queryClient, userId),
    invalidateOutfitViews(queryClient, userId),
  ]);
}
