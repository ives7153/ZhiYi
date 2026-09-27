import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Droplets, Heart, Loader2 } from 'lucide-react-native';

import { pickImageUrl } from '../api/url';
import type { Item } from '../api/types';
import { clothingTypeLabel } from '../api/itemVocab';
import { apiBaseUrl } from '../config/env';
import { useTheme } from '../theme/ThemeContext';
import { zh } from '../i18n/zh';

/**
 * One wardrobe tile, mirroring the Web `ItemCard` in
 * `frontend/app/dashboard/wardrobe/page.tsx`.
 *
 * Deliberate differences from the Web tile:
 *  - round 1 has no selection checkbox or bulk-failure overlay (no write ops yet)
 *  - `status === 'processing'` still shows the overlay + spinner, because that
 *    state is reachable from the read path alone
 *  - every type the card prints goes through `clothingTypeLabel`: the tile used
 *    to fall back to the raw `item.type`, so an untagged garment read "unknown"
 *    and a tagged one read "shirt" (audit finding C17)
 */
export function ItemCard({ item, onPress }: { item: Item; onPress: () => void }) {
  const { colors, radius, spacing, semantic, cardShadow } = useTheme();

  const imageUrl = pickImageUrl(apiBaseUrl, item);
  const isProcessing = item.status === 'processing';
  const typeLabel = clothingTypeLabel(item.type);
  const label = item.name || typeLabel || zh.wardrobe.unnamedItem;
  const sublabel = item.subtype || typeLabel;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
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
        {imageUrl ? (
          <Image source={{ uri: imageUrl }} style={styles.image} resizeMode="cover" />
        ) : (
          <View style={styles.placeholder}>
            <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>{typeLabel}</Text>
          </View>
        )}

        {item.favorite ? (
          <View style={styles.topRight}>
            <Heart size={16} color={semantic.red500} fill={semantic.red500} />
          </View>
        ) : null}

        {item.needs_wash ? (
          <View style={styles.bottomRight}>
            <View style={[styles.washBadge, { backgroundColor: semantic.amber500 }]}>
              <Droplets size={14} color="#FFFFFF" />
            </View>
          </View>
        ) : null}

        {isProcessing ? (
          <View style={styles.processingOverlay}>
            <Loader2 size={24} color="#FFFFFF" />
            <Text style={styles.processingText}>{zh.wardrobe.analyzing}</Text>
          </View>
        ) : null}
      </View>

      <View style={{ padding: spacing.md }}>
        <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '500', color: colors.foreground }}>
          {label}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 12, color: colors.mutedForeground, marginTop: 2 }}>
          {sublabel}
        </Text>
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
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topRight: {
    position: 'absolute',
    top: 8,
    right: 8,
  },
  bottomRight: {
    position: 'absolute',
    bottom: 8,
    right: 8,
  },
  washBadge: {
    borderRadius: 999,
    padding: 4,
  },
  processingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  processingText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '500',
  },
});
