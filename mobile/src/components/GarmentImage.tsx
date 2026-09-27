import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import type { OutfitItem } from '../api/types';
import { clothingTypeLabel } from '../api/itemVocab';
import { joinUrl } from '../api/url';
import { apiBaseUrl } from '../config/env';
import { useTheme } from '../theme/ThemeContext';
import { zh } from '../i18n/zh';

/**
 * One garment image, with the fallback chain and — new in round 3 — a **real failure
 * state**.
 *
 * Why this exists instead of reusing `ItemCard`'s image block:
 *
 *  - `ItemCard` renders `<Image>` with no `onError`, so a garment whose image cannot be
 *    loaded (an expired signed URL, a missing derivative file) shows an empty grey box
 *    forever with no explanation. The round-3 requirement is that an image failure has
 *    recoverable feedback, which needs the failure to be state, not silence.
 *  - The slot row and the picker tile both need the same tile at a different size, and
 *    both draw from `Item` (wardrobe) and `OutfitItem` (inside an outfit) — the two
 *    differ only in `medium_url`, which this component does not need.
 *
 * Fallback order matches the spec (§5.3) and the Web: `thumbnail_url` → `image_url`.
 * When neither URL loads, the placeholder prints 图片加载失败 plus a retry that both
 * re-mounts the image and asks the caller to refetch, so a renewed signature is really
 * tried again rather than the same dead URL.
 *
 * The component always fills its container; callers size the container. That keeps the
 * `<Image>` style typed as the `ImageStyle` RN expects without casting a `ViewStyle`.
 */
export function GarmentImage({
  item,
  resizeMode = 'cover',
  onRequestRetry,
}: {
  item: Pick<OutfitItem, 'id' | 'type' | 'thumbnail_url' | 'image_url'>;
  resizeMode?: 'cover' | 'contain';
  /** Called by the retry affordance; the caller refetches so new signed URLs arrive. */
  onRequestRetry?: () => void;
}) {
  const { colors, spacing } = useTheme();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // A new garment in the same slot is a new image: clear the previous verdict.
  useEffect(() => {
    setFailed(false);
  }, [item.id]);

  const url = joinUrl(apiBaseUrl, item.thumbnail_url) ?? joinUrl(apiBaseUrl, item.image_url);
  const typeLabel = clothingTypeLabel(item.type);

  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((value) => value + 1);
    onRequestRetry?.();
  }, [onRequestRetry]);

  if (!url || failed) {
    return (
      <View
        style={[
          styles.fill,
          styles.placeholder,
          { backgroundColor: colors.muted, padding: spacing.sm },
        ]}
      >
        <Text
          numberOfLines={2}
          style={{ color: colors.mutedForeground, fontSize: 12, textAlign: 'center' }}
        >
          {url ? zh.outfits.imageFailed : typeLabel || zh.outfits.garmentUnclassified}
        </Text>
        {url ? (
          <Pressable onPress={retry} accessibilityRole="button" hitSlop={8}>
            <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: '600' }}>
              {zh.common.retry}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <Image
      // Re-mounting on retry is what makes a renewed signed URL take effect.
      key={`${item.id}:${attempt}`}
      source={{ uri: url }}
      style={styles.fill}
      resizeMode={resizeMode}
      onError={() => setFailed(true)}
    />
  );
}

/** Small spinner used while a slot's candidates are still loading. */
export function GarmentImageLoading() {
  const { colors } = useTheme();
  return (
    <View style={[styles.fill, styles.placeholder, { backgroundColor: colors.muted }]}>
      <ActivityIndicator size="small" color={colors.mutedForeground} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
});
