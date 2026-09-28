import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Outfit } from '../../src/api/types';
import { ApiError, AuthError, NetworkError } from '../../src/api/errors';
import { flattenOutfits, useOutfits } from '../../src/api/outfitHooks';
import { SLOT_LABELS, occasionLabel, outfitStatusLabel } from '../../src/api/outfitVocab';
import { draftFromOutfitItems, filledSlots } from '../../src/outfits/draft';
import { Button, Input, ScreenHeader } from '../../src/components/ui';
import { GarmentImage } from '../../src/components/GarmentImage';
import { useTheme } from '../../src/theme/ThemeContext';
import { zh } from '../../src/i18n/zh';

/**
 * 已保存搭配 — the list of outfits this account has stored (round 3, step 3).
 *
 * The list is `GET /outfits` with the server's own paging (`page` 1-based, `has_more`
 * decides when to stop), searched through `search`. Each row summarises what the server
 * actually returned: the slot labels derived from the garments' types, and up to four
 * garment thumbnails — no placeholder counts and no invented names.
 *
 * A row whose server-reported `contains_to_buy` is true is a 试搭 and is labelled
 * 「试搭·含待购」. The flag comes from the API, computed from the garments' real ownership
 * on every read, so the badge cannot be faked by a client and disappears by itself once
 * the last un-bought garment is purchased. 正常搭配 (no 待购 garment) render exactly as
 * they did in round 3.
 */
export default function SavedOutfitsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, spacing, typography, radius } = useTheme();

  const [search, setSearch] = useState('');
  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useOutfits(search);

  const outfits = useMemo(() => flattenOutfits(data?.pages), [data]);
  const total = data?.pages?.[0]?.total ?? 0;

  const isAuthFailure = error instanceof AuthError;
  const errorMessage = isAuthFailure
    ? zh.login.sessionExpired
    : error instanceof NetworkError
      ? error.message
      : error instanceof ApiError && error.detail
        ? error.detail
        : zh.outfits.loadFailed;

  const onRetry = useCallback(() => {
    void refetch();
  }, [refetch]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: insets.top + spacing.lg,
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.xxl,
          gap: spacing.md,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={8}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
            <ArrowLeft size={16} color={colors.mutedForeground} />
            <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
              {zh.outfits.title}
            </Text>
          </View>
        </Pressable>

        <ScreenHeader title={zh.outfits.savedTitle} subtitle={zh.outfits.savedCount(total)} />

        <Input
          value={search}
          onChangeText={setSearch}
          placeholder={zh.outfits.savedSearch}
          autoCapitalize="none"
        />

        {isLoading ? (
          <View style={{ paddingVertical: spacing.xxl, alignItems: 'center' }}>
            <ActivityIndicator size="small" color={colors.mutedForeground} />
            <Text style={{ ...typography.caption, color: colors.mutedForeground, marginTop: spacing.md }}>
              {zh.common.loading}
            </Text>
          </View>
        ) : isError ? (
          <View style={{ paddingVertical: spacing.xxl, alignItems: 'center', gap: spacing.md }}>
            <Text style={{ ...typography.subtitle, color: colors.destructive, textAlign: 'center' }}>
              {errorMessage}
            </Text>
            <Button title={zh.common.retry} variant="outline" size="sm" onPress={onRetry} />
          </View>
        ) : outfits.length === 0 ? (
          <View style={{ paddingVertical: spacing.xxl, alignItems: 'center', gap: spacing.sm }}>
            <Text style={{ fontSize: 16, fontWeight: '600', color: colors.foreground }}>
              {zh.outfits.savedEmpty}
            </Text>
            <Text style={{ ...typography.caption, color: colors.mutedForeground, textAlign: 'center' }}>
              {zh.outfits.savedEmptyHint}
            </Text>
          </View>
        ) : (
          outfits.map((outfit) => (
            <OutfitRow
              key={outfit.id}
              outfit={outfit}
              onPress={() => router.push(`/outfit/${outfit.id}`)}
            />
          ))
        )}

        {hasNextPage ? (
          <View style={{ alignItems: 'center', paddingVertical: spacing.md }}>
            <Button
              title={isFetchingNextPage ? zh.common.loading : zh.outfits.loadMore}
              variant="outline"
              size="sm"
              loading={isFetchingNextPage}
              onPress={() => void fetchNextPage()}
            />
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** One saved outfit, summarised from the server's own response. */
function OutfitRow({ outfit, onPress }: { outfit: Outfit; onPress: () => void }) {
  const { colors, spacing, typography, radius } = useTheme();

  // Derived, not stored: the slot labels come from the garments' types, so the row says
  // exactly what the detail screen will show.
  const draft = draftFromOutfitItems(outfit.items);
  const slots = filledSlots(draft);
  const extra = draft.passthrough.length;
  const isTrial = outfit.contains_to_buy;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={outfit.name || zh.outfits.unnamed}
      style={({ pressed }) => ({
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius,
        backgroundColor: colors.card,
        padding: spacing.md,
        gap: spacing.sm,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm }}>
        <Text
          numberOfLines={1}
          style={{ ...typography.cardTitle, color: colors.foreground, flex: 1 }}
        >
          {outfit.name || zh.outfits.unnamed}
        </Text>
        <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
          {outfitStatusLabel(outfit.status)}
        </Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
        <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
          {occasionLabel(outfit.occasion)} · {zh.outfits.garmentCount(outfit.items.length)}
        </Text>
        {isTrial ? (
          <View
            style={{
              borderWidth: 1,
              borderColor: colors.primary,
              borderRadius: radius,
              paddingHorizontal: spacing.sm,
              paddingVertical: 2,
            }}
          >
            <Text style={{ ...typography.caption, color: colors.foreground }}>
              {zh.outfits.trialBadge}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', gap: spacing.xs, flexWrap: 'wrap' }}>
        {slots.map((slot) => (
          <View
            key={slot}
            style={{
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radius,
              paddingHorizontal: spacing.sm,
              paddingVertical: 2,
            }}
          >
            <Text style={{ ...typography.caption, color: colors.foreground }}>
              {SLOT_LABELS[slot]}
            </Text>
          </View>
        ))}
        {extra > 0 ? (
          <View
            style={{
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radius,
              paddingHorizontal: spacing.sm,
              paddingVertical: 2,
            }}
          >
            <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
              {zh.outfits.othersSection} {extra}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', gap: spacing.xs }}>
        {outfit.items.slice(0, 4).map((item) => (
          <View
            key={item.id}
            style={{
              width: 44,
              height: 44,
              borderRadius: radius,
              overflow: 'hidden',
              backgroundColor: colors.muted,
            }}
          >
            <GarmentImage item={item} />
          </View>
        ))}
      </View>
    </Pressable>
  );
}
