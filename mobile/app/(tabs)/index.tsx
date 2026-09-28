import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Plus, Search, SearchX, SlidersHorizontal } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AuthError, NetworkError } from '../../src/api/errors';
import { flattenItems, useItems, useItemTypes, type ItemsFilters } from '../../src/api/hooks';
import { OWNED } from '../../src/api/toBuy';
import { clothingTypeLabel } from '../../src/api/itemVocab';
import type { Item } from '../../src/api/types';
import { ItemCard } from '../../src/components/ItemCard';
import {
  EmptyWardrobe,
  ErrorState,
  ItemGridSkeleton,
  LoadingMore,
  StateBlock,
} from '../../src/components/states';
import { Button, Input } from '../../src/components/ui';
import { useAuth } from '../../src/auth/AuthContext';
import { useTheme } from '../../src/theme/ThemeContext';
import { zh } from '../../src/i18n/zh';

/**
 * 衣橱 (wardrobe) — the round-2 list.
 *
 * States handled explicitly (spec §6.4), each reachable from real data:
 *   initial loading → skeleton grid
 *   empty wardrobe  → EmptyWardrobe (with a working "add first item" action)
 *   filtered empty  → "no match" + clear filters
 *   network/API fail→ ErrorState with retry
 *   login expired   → AuthError text (the AuthProvider has already logged out)
 *   list + paging   → grid + automatic next page while has_more
 *
 * Round-2 additions over round 1:
 *   - the "添加单品" button is now live and opens `/item/new`;
 *   - filters cover favourites, needs-wash and sort order, all server-side
 *     (`GET /items` already accepts these; filtering on the client would only
 *     filter the pages that happen to be loaded);
 *   - the list refreshes when the screen regains focus, so returning from an add
 *     or an edit shows the change instead of a cached page.
 */

type SortChoice = 'newest' | 'oldest' | 'name';

const SORT_PARAMS: Record<SortChoice, { sort_by?: string; sort_order: 'asc' | 'desc' }> = {
  newest: { sort_order: 'desc' },
  oldest: { sort_order: 'asc' },
  // `sort_by: 'name'` is passed straight through; the server only accepts the
  // orderings it knows and ignores unknown ones.
  name: { sort_by: 'name', sort_order: 'asc' },
};

export default function WardrobeScreen() {
  const { colors, spacing, typography, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signOut } = useAuth();

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [needsWashOnly, setNeedsWashOnly] = useState(false);
  const [sort, setSort] = useState<SortChoice>('newest');
  const [showFilters, setShowFilters] = useState(false);

  // `ownership: OWNED` is the server's own default too, but it is stated here so the
  // wardrobe is unambiguous: 待购 garments are never part of this list, its count, its
  // category chips or its search (round 4).
  const filters = useMemo<ItemsFilters>(
    () => ({
      ownership: OWNED,
      search: search || undefined,
      type: typeFilter,
      favorite: favoritesOnly || undefined,
      needs_wash: needsWashOnly || undefined,
      sort_by: SORT_PARAMS[sort].sort_by,
      sort_order: SORT_PARAMS[sort].sort_order,
    }),
    [search, typeFilter, favoritesOnly, needsWashOnly, sort],
  );

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useItems(filters);

  // Wardrobe category counts: `owned` is explicit so a 待购 garment can never show up
  // as part of 「衣橱里有几件」.
  const { data: itemTypes } = useItemTypes(OWNED);

  const items = flattenItems(data?.pages);
  const total = data?.pages[0]?.total ?? 0;
  const hasFilters =
    Boolean(search) || Boolean(typeFilter) || favoritesOnly || needsWashOnly || sort !== 'newest';

  /**
   * Re-fetch when the screen regains focus.
   *
   * This is what keeps the grid honest after an add, an edit or an archive: the
   * detail and add screens live elsewhere in the stack, so without this the user
   * would return to a stale page that still shows the old name. `isRefetching` is
   * true during it, so the pull-to-refresh spinner reflects reality rather than
   * being faked.
   */
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  const isAuthFailure = error instanceof AuthError;
  const errorMessage = isAuthFailure
    ? zh.login.sessionExpired
    : error instanceof NetworkError
      ? error.message
      : zh.wardrobe.errors.loadFailed;

  /** Commits the typed search; the query key only changes on submit. */
  const applySearch = useCallback((value: string) => setSearch(value), []);

  const clearFilters = useCallback(() => {
    setSearch('');
    setSearchInput('');
    setTypeFilter(undefined);
    setFavoritesOnly(false);
    setNeedsWashOnly(false);
    setSort('newest');
  }, []);

  const openAddItem = useCallback(() => router.push('/item/new'), [router]);

  const handleItemPress = useCallback(
    (item: Item) => router.push(`/item/${item.id}`),
    [router],
  );

  const renderFooter = useCallback(() => {
    if (isFetchingNextPage) return <LoadingMore />;
    if (hasNextPage) {
      return (
        <Pressable
          onPress={() => void fetchNextPage()}
          style={({ pressed }) => ({
            alignItems: 'center',
            paddingVertical: spacing.lg,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '500' }}>
            {zh.wardrobe.loadMore}
          </Text>
        </Pressable>
      );
    }
    if (items.length > 0) {
      return (
        <Text
          style={{
            textAlign: 'center',
            color: colors.mutedForeground,
            fontSize: 12,
            paddingVertical: spacing.lg,
          }}
        >
          {zh.wardrobe.totalCount(total)}
        </Text>
      );
    }
    return null;
  }, [isFetchingNextPage, hasNextPage, fetchNextPage, items.length, total, colors, spacing]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        numColumns={2}
        columnWrapperStyle={styles.column}
        contentContainerStyle={{
          paddingTop: insets.top + spacing.lg,
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.xxl * 2,
          flexGrow: 1,
        }}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching && !isFetchingNextPage}
            onRefresh={() => void refetch()}
            tintColor={colors.mutedForeground}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: spacing.lg, marginBottom: spacing.lg }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ ...typography.screenTitle, color: colors.foreground }}>
                  {zh.wardrobe.title}
                </Text>
                <Text style={{ ...typography.subtitle, color: colors.mutedForeground, marginTop: 2 }}>
                  {zh.wardrobe.itemCount(total)}
                </Text>
              </View>

              <Button
                title={zh.wardrobe.addItem}
                icon={<Plus size={16} color={colors.primaryForeground} />}
                onPress={openAddItem}
              />
            </View>

            <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Input
                  value={searchInput}
                  onChangeText={setSearchInput}
                  placeholder={zh.wardrobe.search}
                  onSubmitEditing={() => applySearch(searchInput.trim())}
                  autoCapitalize="none"
                  leadingIcon={<Search size={16} color={colors.mutedForeground} />}
                />
              </View>
              <Pressable
                onPress={() => setShowFilters((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ expanded: showFilters }}
                style={{
                  borderWidth: 1,
                  borderColor: hasFilters ? colors.primary : colors.border,
                  borderRadius: radius,
                  padding: spacing.md,
                  backgroundColor: hasFilters ? colors.primary : 'transparent',
                }}
              >
                <SlidersHorizontal
                  size={18}
                  color={hasFilters ? colors.primaryForeground : colors.mutedForeground}
                />
              </Pressable>
            </View>

            {/* Type filter — populated from the backend, not hardcoded. */}
            {itemTypes && itemTypes.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                <FilterChip
                  label={zh.wardrobe.allTypes}
                  active={typeFilter === undefined}
                  onPress={() => setTypeFilter(undefined)}
                />
                {itemTypes.map((entry) => (
                  <FilterChip
                    key={entry.type}
                    label={`${clothingTypeLabel(entry.type)} (${entry.count})`}
                    active={typeFilter === entry.type}
                    onPress={() => setTypeFilter(entry.type)}
                  />
                ))}
              </View>
            ) : null}

            {showFilters ? (
              <View style={{ gap: spacing.md }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                  <FilterChip
                    label={zh.wardrobe.filters.favorites}
                    active={favoritesOnly}
                    onPress={() => setFavoritesOnly((v) => !v)}
                  />
                  <FilterChip
                    label={zh.wardrobe.filters.needsWash}
                    active={needsWashOnly}
                    onPress={() => setNeedsWashOnly((v) => !v)}
                  />
                </View>

                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                  {(
                    [
                      ['newest', zh.wardrobe.sort.newest],
                      ['oldest', zh.wardrobe.sort.oldest],
                      ['name', zh.wardrobe.sort.name],
                    ] as [SortChoice, string][]
                  ).map(([value, label]) => (
                    <FilterChip
                      key={value}
                      label={label}
                      active={sort === value}
                      onPress={() => setSort(value)}
                    />
                  ))}
                </View>
              </View>
            ) : null}

            {hasFilters ? (
              <Pressable onPress={clearFilters}>
                <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
                  {zh.wardrobe.clearFilters}
                </Text>
              </Pressable>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <ItemCard item={item} onPress={() => handleItemPress(item)} />
        )}
        ListEmptyComponent={
          isLoading ? (
            <ItemGridSkeleton count={6} />
          ) : isError ? (
            isAuthFailure ? (
              <ErrorState message={zh.login.sessionExpired} onRetry={() => void signOut()} />
            ) : (
              <ErrorState message={errorMessage} onRetry={() => void refetch()} />
            )
          ) : hasFilters ? (
            // Filtered-empty is not an error: neutral icon, "clear filters" action.
            <StateBlock
              icon={SearchX}
              title={zh.wardrobe.errors.noItemsFound}
              actionLabel={zh.wardrobe.clearFilters}
              onAction={clearFilters}
            />
          ) : (
            <EmptyWardrobe onAdd={openAddItem} />
          )
        }
        ListFooterComponent={renderFooter}
        // Load the next page automatically when the user nears the end, which is
        // what "scroll to the bottom" means on a phone.
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
        }}
      />
    </View>
  );
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { colors, radius, spacing } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={{
        borderWidth: 1,
        borderColor: active ? colors.primary : colors.border,
        backgroundColor: active ? colors.primary : 'transparent',
        borderRadius: radius,
        paddingHorizontal: spacing.md,
        paddingVertical: 4,
      }}
    >
      <Text
        style={{
          color: active ? colors.primaryForeground : colors.mutedForeground,
          fontSize: 12,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  column: {
    gap: 12,
    marginBottom: 12,
  },
});
