import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Item } from '../api/types';
import { clothingTypeLabel } from '../api/itemVocab';
import { formatReferencePrice, sourceUrlHost } from '../api/toBuy';
import { useTheme } from '../theme/ThemeContext';
import { zh } from '../i18n/zh';
import { GarmentImage } from './GarmentImage';

/**
 * One 待购 tile.
 *
 * Deliberately not `ItemCard` with a flag: the two show different facts. A wardrobe
 * tile talks about wearing (favourite, needs-wash, "AI 分析中"); a 待购 tile talks about
 * buying — the reference price, the shop link, and a 待购 marker that must be visible
 * wherever the garment appears, because "this is not in the wardrobe yet" is the whole
 * point of the screen.
 *
 * A missing reference price prints 「未填参考价」 rather than ¥0: an unfilled field is
 * unknown, not free.
 */
export function ToBuyCard({ item, onPress }: { item: Item; onPress: () => void }) {
  const { colors, radius, spacing, cardShadow } = useTheme();

  const typeLabel = clothingTypeLabel(item.type);
  const label = item.name || typeLabel || zh.wardrobe.unnamedItem;
  const price = formatReferencePrice(item.reference_price);
  const host = sourceUrlHost(item.source_url);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${zh.toBuy.badge}：${label}`}
      style={({ pressed }) => [
        styles.card,
        {
          borderColor: colors.border,
          borderRadius: radius,
          backgroundColor: colors.card,
          opacity: pressed ? 0.9 : 1,
        },
        cardShadow,
      ]}
    >
      <View style={{ aspectRatio: 1, backgroundColor: colors.muted }}>
        <GarmentImage item={item} />

        {/* The un-bought marker, on the tile itself so it survives any layout. */}
        <View
          style={[
            styles.badge,
            { backgroundColor: colors.primary, borderRadius: radius },
          ]}
        >
          <Text style={{ color: colors.primaryForeground, fontSize: 11, fontWeight: '600' }}>
            {zh.toBuy.badge}
          </Text>
        </View>
      </View>

      <View style={{ padding: spacing.md, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '500', color: colors.foreground }}>
          {label}
        </Text>
        <Text
          numberOfLines={1}
          style={{ fontSize: 12, color: price ? colors.foreground : colors.mutedForeground }}
        >
          {price || zh.toBuy.card.noPrice}
        </Text>
        {host ? (
          <Text numberOfLines={1} style={{ fontSize: 11, color: colors.mutedForeground }}>
            {zh.toBuy.card.linkHost(host)}
          </Text>
        ) : (
          <Text numberOfLines={1} style={{ fontSize: 11, color: colors.mutedForeground }}>
            {typeLabel}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '48%',
    borderWidth: 1,
    overflow: 'hidden',
  },
  badge: {
    position: 'absolute',
    top: 8,
    left: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
});
