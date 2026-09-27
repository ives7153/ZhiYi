import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AlertCircle, LayoutGrid, Loader2, LucideIcon } from 'lucide-react-native';

import { useTheme } from '../theme/ThemeContext';
import { Button } from './ui';
import { zh } from '../i18n/zh';

/**
 * The list/query states required by spec §6.4. Each one is reachable from real
 * data — no state here is decorative.
 */

/** Initial load: 6 skeleton cards, matching the Web `ItemCardSkeleton` grid. */
export function ItemCardSkeleton() {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      style={[
        styles.skeletonCard,
        { borderColor: colors.border, borderRadius: radius, backgroundColor: colors.card },
      ]}
    >
      <View style={{ aspectRatio: 1, backgroundColor: colors.muted }} />
      <View style={{ padding: spacing.md, gap: spacing.sm }}>
        <View
          style={{ height: 14, width: '75%', backgroundColor: colors.muted, borderRadius: 4 }}
        />
        <View
          style={{ height: 11, width: '50%', backgroundColor: colors.muted, borderRadius: 4 }}
        />
      </View>
    </View>
  );
}

export function ItemGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <View style={styles.grid}>
      {Array.from({ length: count }).map((_, index) => (
        <ItemCardSkeleton key={index} />
      ))}
    </View>
  );
}

/** Centered state used by the empty / filtered-empty / error variants. */
export function StateBlock({
  icon: Icon,
  iconColor,
  title,
  description,
  actionLabel,
  onAction,
  circularIconBackground = true,
}: {
  icon: LucideIcon;
  iconColor?: string;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  circularIconBackground?: boolean;
}) {
  const { colors, spacing, iconSizes } = useTheme();

  return (
    <View style={[styles.stateBlock, { paddingVertical: spacing.xxl * 2, paddingHorizontal: spacing.lg }]}>
      <View
        style={{
          padding: circularIconBackground ? spacing.xl : 0,
          borderRadius: 999,
          backgroundColor: circularIconBackground ? colors.muted : 'transparent',
          marginBottom: spacing.lg,
        }}
      >
        <Icon size={circularIconBackground ? 48 : 40} color={iconColor ?? colors.mutedForeground} />
      </View>
      <Text
        style={{
          fontSize: 18,
          fontWeight: '600',
          color: colors.foreground,
          textAlign: 'center',
          marginBottom: spacing.sm,
        }}
      >
        {title}
      </Text>
      {description ? (
        <Text
          style={{
            fontSize: 14,
            color: colors.mutedForeground,
            textAlign: 'center',
            maxWidth: 320,
            marginBottom: spacing.xl,
          }}
        >
          {description}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <Button title={actionLabel} variant="outline" onPress={onAction} />
      ) : null}
    </View>
  );
}

/** Network/API failure with a retry affordance. */
export function ErrorState({ message, onRetry }: { message?: string; onRetry: () => void }) {
  const { colors } = useTheme();
  return (
    <StateBlock
      icon={AlertCircle}
      iconColor={colors.destructive}
      title={message ?? zh.wardrobe.errors.loadFailed}
      actionLabel={zh.common.retry}
      onAction={onRetry}
      circularIconBackground={false}
    />
  );
}

/** Empty wardrobe (no filters applied). */
export function EmptyWardrobe({ onAdd }: { onAdd?: () => void }) {
  return (
    <View>
      <StateBlock
        icon={LayoutGrid}
        title={zh.wardrobe.empty.title}
        description={zh.wardrobe.empty.description}
      />
      {onAdd ? (
        <View style={{ alignItems: 'center', paddingBottom: 48 }}>
          {/*
           * Round 2 wires this up: the button opens the add-item screen instead
           * of showing the round-1 "coming later" hint.
           */}
          <Button title={zh.wardrobe.empty.addFirstItem} onPress={onAdd} />
        </View>
      ) : null}
    </View>
  );
}

/** Loading-more row at the bottom of the list. */
export function LoadingMore() {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingVertical: spacing.lg }}>
      <Loader2 size={14} color={colors.mutedForeground} />
      <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>{zh.common.loading}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  skeletonCard: {
    width: '48%',
    borderWidth: 1,
    overflow: 'hidden',
  },
  stateBlock: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
