import React, { useCallback, useEffect, useMemo, useRef } from "react";
import {
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

import type { Item } from "../api/types";
import { clothingTypeLabel } from "../api/itemVocab";
import { isToBuy } from "../api/toBuy";
import { useTheme } from "../theme/ThemeContext";
import { zh } from "../i18n/zh";
import { GarmentImage, GarmentImageLoading } from "./GarmentImage";
import { stepCandidate } from "../outfits/draft";

const SWIPE_THRESHOLD = 30;

function isHorizontalDrag(dx: number, dy: number): boolean {
  return Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.4;
}

interface OutfitCanvasZoneProps {
  zoneKey: string;
  label: string;
  required?: boolean;
  garment: Item | null;
  candidates: Item[];
  height: number;
  isLoading?: boolean;
  onSelect: (item: Item) => void;
  onOpenPicker: () => void;
  onStep?: (direction: 1 | -1) => void;
}

export function OutfitCanvasZone({
  zoneKey,
  label,
  required = false,
  garment,
  candidates,
  height,
  isLoading = false,
  onSelect,
  onOpenPicker,
  onStep,
}: OutfitCanvasZoneProps) {
  const { colors, spacing, radius } = useTheme();
  const { width: windowWidth } = useWindowDimensions();

  const currentIndex = garment ? candidates.findIndex((c) => c.id === garment.id) : -1;
  const currentItem = garment;
  const hasCandidates = candidates.length > 0;

  const prevItem = useMemo(() => {
    if (!hasCandidates || candidates.length <= 1) return null;
    if (currentIndex > 0) return candidates[currentIndex - 1];
    return candidates[candidates.length - 1];
  }, [candidates, currentIndex, hasCandidates]);

  const nextItem = useMemo(() => {
    if (!hasCandidates || candidates.length <= 1) return null;
    if (currentIndex >= 0 && currentIndex < candidates.length - 1) return candidates[currentIndex + 1];
    return candidates[0];
  }, [candidates, currentIndex, hasCandidates]);

  const stepInternal = useCallback(
    (direction: 1 | -1) => {
      if (onStep) {
        onStep(direction);
        return;
      }
      const next = stepCandidate(candidates, garment?.id ?? null, direction);
      if (!next) return;
      const match = candidates.find((c) => c.id === next.id);
      if (match) onSelect(match);
    },
    [candidates, garment?.id, onSelect, onStep]
  );

  const stepRef = useRef(stepInternal);
  useEffect(() => {
    stepRef.current = stepInternal;
  }, [stepInternal]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_e, gesture) =>
          isHorizontalDrag(gesture.dx, gesture.dy),
        onMoveShouldSetPanResponder: (_e, gesture) =>
          isHorizontalDrag(gesture.dx, gesture.dy),
        onPanResponderTerminationRequest: () => true,
        onPanResponderRelease: (_e, gesture) => {
          if (gesture.dx <= -SWIPE_THRESHOLD) {
            stepRef.current(1);
          } else if (gesture.dx >= SWIPE_THRESHOLD) {
            stepRef.current(-1);
          }
        },
      }),
    []
  );

  const emptyAccessibilityLabel = !hasCandidates
    ? zh.outfits.slotNoItems(label)
    : `选择${label}单品`;
  const filledAccessibilityLabel = `更换${label}：${
    garment?.name || clothingTypeLabel(garment?.type || "") || "单品"
  }`;

  const centerCardWidth = Math.min(Math.round((windowWidth - 48) * 0.68), 300);
  const peekCardWidth = Math.round((windowWidth - 48 - centerCardWidth) / 2) - 8;

  return (
    <View
      accessibilityLabel={`${label}席位`}
      style={[styles.zoneContainer, { height }]}
      {...panResponder.panHandlers}
    >
      {/* Zone Header Label & Step Chevrons */}
      <View style={styles.zoneHeader}>
        <View style={styles.labelRow}>
          <Text style={[styles.zoneLabel, { color: colors.foreground }]}>
            {label}
            {required ? <Text style={{ color: colors.primary }}> *</Text> : null}
          </Text>
          {garment && isToBuy(garment) ? (
            <View style={[styles.toBuyBadge, { backgroundColor: colors.muted }]}>
              <Text style={[styles.toBuyText, { color: colors.primary }]}>待购</Text>
            </View>
          ) : null}
        </View>

        {candidates.length > 1 ? (
          <View style={styles.stepButtons}>
            <Pressable
              onPress={() => stepRef.current(-1)}
              accessibilityRole="button"
              accessibilityLabel="上一件"
              hitSlop={8}
              style={[styles.stepBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Text style={[styles.stepBtnText, { color: colors.mutedForeground }]}>‹</Text>
            </Pressable>
            <Pressable
              onPress={() => stepRef.current(1)}
              accessibilityRole="button"
              accessibilityLabel="下一件"
              hitSlop={8}
              style={[styles.stepBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Text style={[styles.stepBtnText, { color: colors.mutedForeground }]}>›</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {/* Main Visual Display */}
      {isLoading ? (
        <View style={[styles.loadingBox, { backgroundColor: colors.card, borderRadius: radius }]}>
          <GarmentImageLoading />
        </View>
      ) : !currentItem ? (
        /* Empty Slot */
        <Pressable
          onPress={onOpenPicker}
          accessibilityRole="button"
          accessibilityLabel={emptyAccessibilityLabel}
          style={[
            styles.emptyCard,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderRadius: radius,
            },
          ]}
        >
          {hasCandidates ? (
            <Text style={[styles.emptyPlus, { color: colors.primary }]}>+</Text>
          ) : null}
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            {emptyAccessibilityLabel}
          </Text>
        </Pressable>
      ) : (
        /* Carousel with Center Item and Peeking Left/Right Items */
        <View style={styles.carouselRow}>
          {/* Left Peeking Card */}
          {prevItem ? (
            <Pressable
              onPress={() => onSelect(prevItem)}
              accessibilityRole="button"
              accessibilityLabel="上一件备选"
              style={[
                styles.peekingCard,
                {
                  width: peekCardWidth,
                  height: height - 36,
                  borderRadius: radius,
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                },
              ]}
            >
              <GarmentImage item={prevItem} resizeMode="contain" />
            </Pressable>
          ) : (
            <View style={{ width: peekCardWidth }} />
          )}

          {/* Center Main Card */}
          <Pressable
            onPress={onOpenPicker}
            accessibilityRole="button"
            accessibilityLabel={filledAccessibilityLabel}
            style={[
              styles.centerCard,
              {
                width: centerCardWidth,
                height: height - 36,
                borderRadius: radius,
                borderColor: colors.primary,
                backgroundColor: colors.card,
              },
            ]}
          >
            <View style={styles.centerImageContainer}>
              <GarmentImage item={currentItem} resizeMode="contain" />
            </View>
            <View style={styles.centerNameOverlay}>
              <Text numberOfLines={1} style={[styles.centerGarmentName, { color: colors.foreground }]}>
                {currentItem.name || clothingTypeLabel(currentItem.type) || "单品"}
              </Text>
            </View>
          </Pressable>

          {/* Right Peeking Card */}
          {nextItem ? (
            <Pressable
              onPress={() => onSelect(nextItem)}
              accessibilityRole="button"
              accessibilityLabel="下一件备选"
              style={[
                styles.peekingCard,
                {
                  width: peekCardWidth,
                  height: height - 36,
                  borderRadius: radius,
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                },
              ]}
            >
              <GarmentImage item={nextItem} resizeMode="contain" />
            </Pressable>
          ) : (
            <View style={{ width: peekCardWidth }} />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  zoneContainer: {
    width: "100%",
    justifyContent: "center",
    marginBottom: 4,
  },
  zoneHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 8,
    marginBottom: 4,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  zoneLabel: {
    fontSize: 13,
    fontWeight: "600",
  },
  toBuyBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
  },
  toBuyText: {
    fontSize: 10,
    fontWeight: "600",
  },
  stepButtons: {
    flexDirection: "row",
    gap: 6,
  },
  stepBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
  },
  stepBtnText: {
    fontSize: 14,
    fontWeight: "bold",
    lineHeight: 16,
  },
  loadingBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyCard: {
    flex: 1,
    marginHorizontal: 12,
    borderWidth: 1.5,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  emptyPlus: {
    fontSize: 26,
    fontWeight: "300",
  },
  emptyText: {
    fontSize: 13,
  },
  carouselRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  peekingCard: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderWidth: 1,
    opacity: 0.55,
    transform: [{ scale: 0.88 }],
    padding: 4,
  },
  centerCard: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderWidth: 1.5,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 4,
  },
  centerImageContainer: {
    width: "100%",
    height: "82%",
    padding: 6,
  },
  centerNameOverlay: {
    width: "100%",
    height: "18%",
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  centerGarmentName: {
    fontSize: 12,
    fontWeight: "600",
  },
});
