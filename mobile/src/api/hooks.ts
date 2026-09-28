import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { getCapabilities, getItem, getItemTypes, getUserProfile, getItems } from '../api/items';
import { OWNED, type Ownership } from '../api/toBuy';
import type {
  CapabilitiesResponse,
  Item,
  ItemListParams,
  ItemListResponse,
  ItemTypeCount,
  UserProfile,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import {
  ITEMS_PAGE_SIZE,
  ITEMS_STALE_TIME_MS,
  POLL_IDLE_MS,
  POLL_PROCESSING_MS,
} from '../config/env';
import { ApiError, AuthError, NetworkError } from '../api/errors';

/**
 * Server-state hooks.
 *
 * EVERY query key is prefixed with the current `userId`. That is the user
 * isolation requirement (spec §8): without it, logging out and back in as a
 * different account would serve the previous user's cached wardrobe until
 * something happened to invalidate it. The prefix makes the caches disjoint by
 * construction rather than by remembering to clear them.
 *
 * `retry` never retries an auth failure — a confirmed credential rejection (401 everywhere,
 * 403 only when the server says the account is inactive) means retrying just repeats it.
 * A business 403 is an `ApiError` and is not retried either, but for its own reason: it will
 * keep answering the same way until the caller changes the request.
 */

/** Query key root for everything scoped to one user. */
export function userScope(userId: string | null): readonly [string, string] {
  return ['user', userId ?? 'anonymous'] as const;
}

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof AuthError) return false;
  // Network errors are worth retrying; genuine API errors (404 etc.) are not.
  if (error instanceof NetworkError) return failureCount < 2;
  if (error instanceof ApiError) return false;
  return failureCount < 2;
}

export interface ItemsFilters {
  search?: string;
  type?: string;
  favorite?: boolean;
  needs_wash?: boolean;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  /**
   * Which side of the wardrobe this list is about. Part of the query key, so the
   * 衣橱 list and the 待购 list are separate cache entries and can never show each
   * other's rows — including right after a purchase, when the same garment has just
   * moved from one to the other.
   */
  ownership?: Ownership;
}

/**
 * Paginated wardrobe list.
 *
 * Uses `useInfiniteQuery` so "load more" appends instead of re-fetching, and the
 * cursor is the page number because the server is page-based
 * (`page` 1-based, `has_more` tells us when to stop).
 */
export function useItems(filters: ItemsFilters) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useInfiniteQuery<ItemListResponse, Error>({
    queryKey: [...userScope(userId), 'items', filters],
    enabled: Boolean(userId),
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => {
      const params: ItemListParams = {
        page: pageParam as number,
        page_size: ITEMS_PAGE_SIZE,
        search: filters.search?.trim() || undefined,
        type: filters.type || undefined,
        favorite: filters.favorite || undefined,
        needs_wash: filters.needs_wash || undefined,
        sort_by: filters.sort_by || undefined,
        sort_order: filters.sort_order,
        // Archived garments are a separate concern in every round: they are not in
        // the 衣橱 list, the 待购 list or any candidate set.
        is_archived: false,
        // Sent explicitly rather than left to the server default, so the request
        // states which side it wants and the key above matches what was asked for.
        ownership: filters.ownership ?? OWNED,
      };
      return getItems(params, signal);
    },
    getNextPageParam: (lastPage) => (lastPage.has_more ? lastPage.page + 1 : undefined),
    staleTime: ITEMS_STALE_TIME_MS,
    retry: shouldRetry,
    // Poll faster while anything is still being processed, matching the Web
    // `useItems` refetchInterval behaviour.
    refetchInterval: (query) => {
      const pages = query.state.data?.pages;
      const hasProcessing = pages?.some((page) =>
        page.items.some((item) => item.status === 'processing'),
      );
      return hasProcessing ? POLL_PROCESSING_MS : POLL_IDLE_MS;
    },
  });
}

/** Single item detail. */
export function useItem(itemId: string | null) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useQuery<Item, Error>({
    queryKey: [...userScope(userId), 'item', itemId],
    enabled: Boolean(userId) && Boolean(itemId),
    queryFn: ({ signal }) => getItem(itemId as string, signal),
    staleTime: ITEMS_STALE_TIME_MS,
    retry: shouldRetry,
  });
}

/**
 * Available item types with counts, for a type filter row.
 *
 * Per ownership: the 衣橱 chips must not count 待购 garments, and the 待购 screen shows
 * its own counts, so the scope is part of the key as well as the request.
 */
export function useItemTypes(ownership: Ownership = OWNED) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useQuery<ItemTypeCount[], Error>({
    queryKey: [...userScope(userId), 'item-types', ownership],
    enabled: Boolean(userId),
    queryFn: ({ signal }) => getItemTypes(ownership, signal),
    staleTime: 5 * 60_000,
    retry: shouldRetry,
  });
}

/**
 * Server capability flags (`GET /capabilities`).
 *
 * Used to decide whether offering an "AI will tag this" message is honest.
 * Deliberately NOT gated on `userId`: the answer depends only on the server's own
 * configuration, so caching it per user would just cause needless refetches.
 * A failure here is non-fatal — callers treat `undefined` as "unknown" and fall
 * back to wording that is true either way.
 */
export function useCapabilities() {
  return useQuery<CapabilitiesResponse, Error>({
    queryKey: ['capabilities'],
    queryFn: ({ signal }) => getCapabilities(signal),
    // The flags only change when the server restarts with a different config.
    staleTime: 5 * 60_000,
    retry: shouldRetry,
  });
}

/** Current user's profile, for the 我的 screen. */
export function useUserProfile() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useQuery<UserProfile, Error>({
    queryKey: [...userScope(userId), 'profile'],
    enabled: Boolean(userId),
    queryFn: ({ signal }) => getUserProfile(signal),
    staleTime: 5 * 60_000,
    retry: shouldRetry,
  });
}

/** Flattens the infinite pages into one array for rendering. */
export function flattenItems(data: ItemListResponse[] | undefined): Item[] {
  if (!data) return [];
  return data.flatMap((page) => page.items);
}
