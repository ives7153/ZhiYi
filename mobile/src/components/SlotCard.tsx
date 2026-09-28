import React, { useEffect, useMemo, useRef } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Item } from '../api/types';
import { clothingTypeLabel } from '../api/itemVocab';
import { isToBuy } from '../api/toBuy';
import { useTheme } from '../theme/ThemeContext';
import { zh } from '../i18n/zh';
import { GarmentImage, GarmentImageLoading } from './GarmentImage';

/**
 * One席位 row: the garment currently in the slot, and the gesture that changes it.
 *
 * The swipe is implemented with `PanResponder` from react-native core rather than
 * `react-native-gesture-handler`/Reanimated. Reasons, in order of importance:
 *
 *  - no new native dependency, so no extra prebuild/rebuild cycle and nothing to
 *    configure in `app.json`;
 *  - the handler runs on the JS thread, which is where the draft state lives anyway —
 *    with a worklet the state update would have to cross back to JS, and this gesture
 *    has to work on a GPU-less emulator as well as a phone;
 *  - `onMoveShouldSetPanResponder` only claims **horizontal** movement
 *    (`|dx| > |dy|`), so the screen still scrolls vertically and the slot list stays
 *    usable on a small screen. Without that test the whole row would swallow the drag
 *    and vertical scrolling would look broken.
 *
 * The two chevron buttons call the same `onStep` as the gesture. They are not a
 * substitute: 左右滑动 is the required interaction and is the one exercised on the
 * device. They exist because a swipe cannot be performed by a screen reader or a
 * keyboard, and because a gesture that has a visible equivalent is much easier to
 * diagnose when it misbehaves.
 */

const SWIPE_THRESHOLD = 48;

/** True while the pointer is moving mostly sideways. */
function isHorizontalDrag(dx: number, dy: number): boolean {
  return Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.5;
}

export function SlotCard({
  label,
  required,
  garment,
  candidates,
  isLoading,
  error,
  truncated,
  note,
  onPick,
  onStep,
  onRetry,
}: {
  label: string;
  required: boolean;
  garment: Item | null;
  candidates: Item[];
  isLoading: boolean;
  error: Error | null;
  truncated: boolean;
  /** Extra line under the row, e.g. this garment is no longer in the wardrobe. */
  note?: string;
  onPick: () => void;
  onStep: (direction: 1 | -1) => void;
  onRetry: () => void;
}) {
  const { colors, radius, spacing } = useTheme();

  // Keep the latest callbacks reachable from the responder without recreating it:
  // PanResponder captures the functions it is created with, and rebuilding it on every
  // render would drop an in-flight gesture.
  const stepRef = useRef(onStep);
  useEffect(() => {
    stepRef.current = onStep;
  }, [onStep]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Claimed in the **capture** phase as well, so a drag that starts on the tile (a
        // Pressable, which would otherwise hold the responder for its own press) is still
        // seen as a swipe. Measured on the emulator: with only the bubble-phase handler, a
        // horizontal swipe that began on the tile never reached the responder and the slot
        // did not change — the tile's press won.
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          isHorizontalDrag(gesture.dx, gesture.dy),
        onMoveShouldSetPanResponder: (_event, gesture) =>
          isHorizontalDrag(gesture.dx, gesture.dy),
        onPanResponderTerminationRequest: () => true,
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dx <= -SWIPE_THRESHOLD) {
            // Swiped left: the next garment slides in from the right.
            stepRef.current(1);
          } else if (gesture.dx >= SWIPE_THRESHOLD) {
            stepRef.current(-1);
          }
        },
      }),
    [],
  );

  const typeLabel = garment ? clothingTypeLabel(garment.type) : '';
  const name = garment ? garment.name || typeLabel || zh.outfits.garmentUnnamed : '';
  /**
   * A 待购 garment sitting in a slot.
   *
   * The badge comes from the garment's own `ownership` (the server's value), so a
   * planned item is visibly not part of the wardrobe even while it is being tried out,
   * and `index` above is simply absent for it — the "第 N / M 件" line counts the
   * candidate set the swipe walks, which is the wardrobe's.
   */
  const toBuy = isToBuy(garment);
  const index = garment ? candidates.findIndex((candidate) => candidate.id === garment.id) : -1;
  const hasCandidates = candidates.length > 0;

  return (
    <View
      accessibilityLabel={`${label}席位`}
      style={[
        styles.row,
        {
          borderColor: colors.border,
          borderRadius: radius,
          backgroundColor: colors.card,
          padding: spacing.md,
          gap: spacing.md,
        },
      ]}
      {...responder.panHandlers}
    >
      <View style={styles.labelColumn}>
        <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '600' }}>
          {label}
          {required ? ' *' : ''}
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          garment
            ? `更换${label}：${name}${toBuy ? `（${zh.outfits.toBuyMarker}）` : ''}`
            : `选择${label}单品`
        }
        onPress={onPick}
        style={{
          width: 88,
          height: 88,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius,
          overflow: 'hidden',
          backgroundColor: colors.muted,
        }}
      >
        {isLoading && !garment ? (
          <GarmentImageLoading />
        ) : garment ? (
          <GarmentImage item={garment} onRequestRetry={onRetry} />
        ) : (
          <View style={[styles.fill, styles.placeholder]}>
            <Text style={{ color: colors.mutedForeground, fontSize: 12, textAlign: 'center' }}>
              {hasCandidates || isLoading ? zh.outfits.slotChoose : zh.outfits.slotEmpty}
            </Text>
          </View>
        )}
        {toBuy ? (
          <View
            style={{
              position: 'absolute',
              top: 4,
              left: 4,
              backgroundColor: colors.primary,
              borderRadius: radius,
              paddingHorizontal: 5,
              paddingVertical: 1,
            }}
          >
            <Text style={{ color: colors.primaryForeground, fontSize: 10, fontWeight: '600' }}>
              {zh.outfits.toBuyMarker}
            </Text>
          </View>
        ) : null}
      </Pressable>

      <View style={{ flex: 1, minWidth: 0, justifyContent: 'center', gap: 2 }}>
        {error ? (
          <>
            <Text style={{ color: colors.destructive, fontSize: 13 }}>
              {zh.outfits.slotLoadFailed}
            </Text>
            <Pressable onPress={onRetry} accessibilityRole="button">
              <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '600' }}>
                {zh.common.retry}
              </Text>
            </Pressable>
          </>
        ) : isLoading && !garment ? (
          <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
            {zh.outfits.slotLoading}
          </Text>
        ) : !hasCandidates ? (
          <>
            <Text style={{ color: colors.foreground, fontSize: 13 }}>
              {zh.outfits.slotNoItems(label)}
            </Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
              {zh.outfits.slotNoItemsHint}
            </Text>
          </>
        ) : garment ? (
          <>
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 14, fontWeight: '500' }}>
              {name}
            </Text>
            <Text numberOfLines={1} style={{ color: colors.mutedForeground, fontSize: 12 }}>
              {typeLabel}
            </Text>
            {index >= 0 ? (
              <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
                {zh.outfits.candidates(index + 1, candidates.length)}
              </Text>
            ) : null}
          </>
        ) : (
          <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
            {zh.outfits.swipeHint}
          </Text>
        )}

        <View style={[styles.actions, { gap: spacing.md, marginTop: spacing.xs }]}>
          <StepButton label={zh.outfits.prevCandidate} disabled={!hasCandidates} onPress={() => onStep(-1)} />
          <StepButton label={zh.outfits.nextCandidate} disabled={!hasCandidates} onPress={() => onStep(1)} />
        </View>

        {truncated ? (
          <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{zh.outfits.slotTruncated}</Text>
        ) : null}

        {note ? (
          <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{note}</Text>
        ) : null}
      </View>
    </View>
  );
}

function StepButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      hitSlop={6}
    >
      <Text
        style={{
          color: disabled ? colors.mutedForeground : colors.foreground,
          fontSize: 13,
          fontWeight: '500',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
  },
  labelColumn: {
    width: 48,
  },
  fill: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
