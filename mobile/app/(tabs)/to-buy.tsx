import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Plus, Search, ShoppingBag, SearchX } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AuthError, NetworkError } from '../../src/api/errors';
import { flattenItems, useItems, useItemTypes, type ItemsFilters } from '../../src/api/hooks';
import { TO_BUY } from '../../src/api/toBuy';
import { clothingTypeLabel } from '../../src/api/itemVocab';
import type { Item } from '../../src/api/types';
import { ToBuyCard } from '../../src/components/ToBuyCard';
import {
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
 * 待购 — the list of garments the user is planning to buy (round 4).
 *
 * Rounds 1–3 shipped an honest placeholder here; this is the real screen.
 *
 * Everything on it comes from the server, scoped to `ownership=to_buy`:
 *
 *  - the list itself is `GET /items?ownership=to_buy` with the server's own paging, so
 *    search, the category chips and 「加载更多」 all operate on the complete 待购 set
 *    rather than on whatever pages the client happens to hold;
 *  - the per-category counts come from `GET /items/types?ownership=to_buy`, so they are
 *    the 待购 counts and not the wardrobe's;
 *  - the total is that list's `total`, i.e. the real number of un-bought garments. It is
 *    never added to the wardrobe's count anywhere — the subtitle says outright that
 *    these garments are not part of 衣橱.
 *
 * States handled explicitly: loading, empty, filtered-empty, network/API failure with
 * retry, credential expiry (the provider has already logged out). A newly added garment
 * appears because the screen refetches when it regains focus.
 */
export default function ToBuyScreen() {
  const { colors, spacing, typography, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signOut } = useAuth();

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined);

  // Typed explicitly: an untyped object literal widens `ownership: TO_BUY` to `string`,
  // which would stop the query from being the `to_buy` list at the type level.
  const filters = useMemo<ItemsFilters>(
    () => ({
      ownership: TO_BUY,
      search: search || undefined,
      type: typeFilter,
      sort_by: 'created_at',
      sort_order: 'desc',
    }),
    [search, typeFilter],
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

  // Its own query key (the ownership is part of the key), so these counts can never be
  // confused with the wardrobe's.
  const { data: typeCounts } = useItemTypes(TO_BUY);

  const items = flattenItems(data?.pages);
  const total = data?.pages[0]?.total ?? 0;
  const hasFilters = Boolean(search) || Boolean(typeFilter);

  /** Returning from 加入待购 or a detail screen must show the change, not a cached page. */
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
      : zh.toBuy.errors.loadFailed;

  const clearFilters = useCallback(() => {
    setSearch('');
    setSearchInput('');
    setTypeFilter(undefined);
  }, []);

  const openAdd = useCallback(() => router.push('/item/new?mode=toBuy'), [router]);
  const openDetail = useCallback(
    (item: Item) => router.push(`/to-buy/${item.id}`),
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
            {zh.toBuy.loadMore}
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
          {zh.toBuy.totalCount(total)}
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
                  {zh.toBuy.title}
                </Text>
                <Text style={{ ...typography.subtitle, color: colors.mutedForeground, marginTop: 2 }}>
                  {zh.toBuy.subtitle(total)}
                </Text>
              </View>
              <Button
                title={zh.toBuy.add}
                icon={<Plus size={16} color={colors.primaryForeground} />}
                onPress={openAdd}
              />
            </View>

            <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Input
                  value={searchInput}
                  onChangeText={setSearchInput}
                  placeholder={zh.toBuy.search}
                  onSubmitEditing={() => setSearch(searchInput.trim())}
                  autoCapitalize="none"
                  leadingIcon={<Search size={16} color={colors.mutedForeground} />}
                />
              </View>
            </View>

            {/* Category chips from the server's 待购 counts, not hardcoded. */}
            {typeCounts && typeCounts.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                <FilterChip
                  label={zh.toBuy.allTypes}
                  active={typeFilter === undefined}
                  onPress={() => setTypeFilter(undefined)}
                />
                {typeCounts.map((entry) => (
                  <FilterChip
                    key={entry.type}
                    label={`${clothingTypeLabel(entry.type)} (${entry.count})`}
                    active={typeFilter === entry.type}
                    onPress={() => setTypeFilter(entry.type)}
                  />
                ))}
              </View>
            ) : null}

            {hasFilters ? (
              <Pressable onPress={clearFilters}>
                <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
                  {zh.toBuy.clearFilters}
                </Text>
              </Pressable>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <ToBuyCard item={item} onPress={() => openDetail(item)} />
        )}
        ListEmptyComponent={
          isLoading ? (
            <ItemGridSkeleton count={4} />
          ) : isError ? (
            isAuthFailure ? (
              <ErrorState message={zh.login.sessionExpired} onRetry={() => void signOut()} />
            ) : (
              <ErrorState message={errorMessage} onRetry={() => void refetch()} />
            )
          ) : hasFilters ? (
            <StateBlock
              icon={SearchX}
              title={zh.toBuy.errors.noMatch}
              actionLabel={zh.toBuy.clearFilters}
              onAction={clearFilters}
            />
          ) : (
            <StateBlock
              icon={ShoppingBag}
              title={zh.toBuy.empty.title}
              description={zh.toBuy.empty.description}
              actionLabel={zh.toBuy.empty.addFirst}
              onAction={openAdd}
            />
          )
        }
        ListFooterComponent={renderFooter}
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
