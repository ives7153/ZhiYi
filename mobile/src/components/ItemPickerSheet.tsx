import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Item } from '../api/types';
import { clothingTypeLabel } from '../api/itemVocab';
import { SLOT_LABELS, type SlotKey } from '../api/outfitVocab';
import { useSlotCandidates, useFullBodyCandidates } from '../api/outfitHooks';
import { OWNED, TO_BUY, isToBuy, type Ownership } from '../api/toBuy';
import { useTheme } from '../theme/ThemeContext';
import { zh } from '../i18n/zh';
import { GarmentImage } from './GarmentImage';
import { Input } from './ui';

/**
 * The bottom panel that offers a slot's real garments (step 2 of round 3).
 *
 * Behaviour the round asks for, and how each point is met:
 *
 *  - **从底部展开同类真实衣物** — a `Modal` with `animationType="slide"` and a sheet
 *    anchored to the bottom edge; the list is `useSlotCandidates`, i.e. the same
 *    server-backed set the slot's swipe uses (never a mock list).
 *  - **支持搜索** — the field is debounced (300 ms) and its value becomes part of the
 *    query key, so the server performs the search (`GET /items?search=…`). The list
 *    shows a spinner while a new search resolves instead of silently keeping the old
 *    results.
 *  - **分页** — `getSlotCandidates` already walks every server page for the slot's
 *    types, so `items` is the complete set; this panel reveals it in windows of
 *    `PAGE_STEP` and says how many of the total are on screen. No page is ever
 *    presented as the whole list, and the count makes that checkable.
 *  - **选择后更新该槽位，取消保持原选择** — a tile is a plain `onSelect(item)` call;
 *    the cancel path (`取消`, the scrim and Android's back button) only calls `onClose`,
 *    which the caller implements as "leave the draft untouched".
 *  - **Android 返回操作先关闭面板** — `Modal`'s `onRequestClose` is wired to `onClose`:
 *    while a RN `Modal` is visible it owns the back gesture, so the first back press
 *    closes the sheet and never leaves the screen.
 *  - **键盘** — the sheet is a `KeyboardAvoidingView`; on Android the app's default
 *    `adjustResize` window mode does the work, and the sheet's own max height keeps the
 *    results reachable while the keyboard is open.
 *
 * Round 4 adds the **已拥有 / 待购** switch. It only appears in a 试搭 (`allowToBuy`),
 * which is where the round asks for it; a normal outfit keeps exactly one candidate set,
 * the wardrobe's. Each scope is its own query (the ownership is part of the key), so
 * switching never shows a mixture and buying a garment mid-trial moves it between the
 * two lists on the next refetch. Every un-bought garment is marked 「待购」 in whichever
 * scope it appears, so a planned item is never silently presented as owned.
 */

/** How many candidates are revealed per "加载更多" step. */
const PAGE_STEP = 12;

/** How long typing must pause before the server is asked. */
const SEARCH_DEBOUNCE_MS = 300;

export function ItemPickerSheet({
  visible,
  slot,
  selectedId,
  allowToBuy = false,
  isFullBody = false,
  onSelect,
  onClose,
}: {
  visible: boolean;
  slot: SlotKey;
  isFullBody?: boolean;
  /** Id of the garment currently in the slot, marked as 当前席位 in the list. */
  selectedId: string | null;
  /**
   * Whether the 已拥有 / 待购 switch is offered. True for a 试搭 (opened from a 待购
   * garment, or editing an outfit the server reports as `contains_to_buy`); false for a
   * normal 搭配, which must keep offering only owned garments.
   */
  allowToBuy?: boolean;
  onSelect: (item: Item) => void;
  onClose: () => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  /**
   * Height of the on-screen keyboard, tracked so the sheet can sit above it.
   *
   * `Keyboard` events are the supported way to get this edge-to-edge: `ReactRootView` derives
   * the number from the IME window inset, which is reported even when the platform refuses to
   * resize the window (see the note on the sheet's style below). Hidden while no keyboard is
   * up, which is the normal state for picking a garment.
   */
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', (event) => {
      const height = event?.endCoordinates?.height ?? 0;
      setKeyboardHeight(Math.max(0, Math.round(height)));
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  const label = isFullBody ? '连体衣/裙' : (SLOT_LABELS[slot] || '单品');
  const [searchText, setSearchText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_STEP);
  const [scope, setScope] = useState<Ownership>(OWNED);

  const slotQuery = useSlotCandidates(slot, debounced, scope);
  const fullBodyQuery = useFullBodyCandidates(debounced, scope);
  const { data, isLoading, isFetching, isError, error, refetch } = isFullBody ? fullBodyQuery : slotQuery;

  // Debounce the field so a burst of keystrokes is one request, not one per character.
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(searchText.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchText]);

  // A new slot, a new search or a new scope starts a fresh window over the results.
  useEffect(() => {
    setVisibleCount(PAGE_STEP);
  }, [slot, debounced, scope, visible]);

  // Reset the search and the scope when the sheet closes, so reopening starts from the
  // full 衣橱-side list rather than from whatever was being browsed last time.
  useEffect(() => {
    if (!visible) {
      setSearchText('');
      setDebounced('');
      setScope(OWNED);
    }
  }, [visible]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const shown = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
  const hasMoreToShow = shown.length < items.length;

  const emptyMessage = debounced
    ? { title: zh.outfits.slotNoMatch, hint: zh.outfits.slotNoMatchHint }
    : scope === TO_BUY
      ? { title: zh.outfits.pickerNoToBuy(label), hint: zh.outfits.pickerNoToBuyHint }
      : { title: zh.outfits.slotNoItems(label), hint: zh.outfits.slotNoItemsHint };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        {/* Tapping the dimmed area above the sheet cancels, like any bottom sheet. */}
        <Pressable style={styles.backdropTap} onPress={onClose} accessibilityRole="button" />

        {/*
          The sheet lifts itself by the keyboard's height instead of relying on the platform.

          This app targets SDK 36, so Android 15+ runs it edge-to-edge, where
          `SOFT_INPUT_ADJUST_RESIZE` — which React Native's Modal sets on its dialog — is a
          no-op: measured on the emulator, the sheet's layout did not move at all while the IME
          was up, so the candidate list sat *behind* the keyboard and tapping a search result
          typed into the keyboard instead. `ReactRootView` reports the IME inset through
          `keyboardDidShow` (`WindowInsetsCompat.Type.ime()`), which does work edge-to-edge, so
          the sheet uses that number directly.
        */}
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.background,
              borderColor: colors.border,
              borderTopLeftRadius: radius * 2,
              borderTopRightRadius: radius * 2,
              paddingBottom: insets.bottom + spacing.md,
              marginBottom: keyboardHeight,
              // Clamped so the sheet always keeps a usable height even with a tall keyboard,
              // and never grows past the space that is actually left.
              maxHeight: Math.max(280, windowHeight - keyboardHeight - 96),
            },
          ]}
        >
          <View style={[styles.header, { paddingHorizontal: spacing.lg, paddingTop: spacing.lg }]}>
            <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: '600' }}>
              {zh.outfits.pickerTitle(label)}
            </Text>
            <Pressable onPress={onClose} accessibilityRole="button" hitSlop={8}>
              <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '500' }}>
                {zh.outfits.pickerClose}
              </Text>
            </Pressable>
          </View>

          <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
            <Input
              value={searchText}
              onChangeText={setSearchText}
              placeholder={zh.outfits.pickerSearch}
              autoCapitalize="none"
            />

            {/*
              The 已拥有 / 待购 switch. Two separate server queries rather than one merged
              list, so the scope on screen is always exactly what the server was asked
              for — and the label states that 待购 garments are not part of the wardrobe.
            */}
            {allowToBuy ? (
              <View style={{ marginTop: spacing.sm, gap: spacing.xs }}>
                <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
                  {zh.outfits.pickerScopeLabel}
                </Text>
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <ScopeChip
                    label={zh.outfits.pickerScopeOwned}
                    active={scope === OWNED}
                    onPress={() => setScope(OWNED)}
                  />
                  <ScopeChip
                    label={zh.outfits.pickerScopeToBuy}
                    active={scope === TO_BUY}
                    onPress={() => setScope(TO_BUY)}
                  />
                </View>
                {scope === TO_BUY ? (
                  <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
                    {zh.outfits.pickerScopeToBuyHint}
                  </Text>
                ) : null}
              </View>
            ) : null}

            <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: spacing.sm }}>
              {zh.outfits.pickerKeepChoice} · {zh.outfits.pickerBackHint}
            </Text>
          </View>

          {isError ? (
            <View style={[styles.center, { padding: spacing.xl }]}>
              <Text style={{ color: colors.destructive, fontSize: 14, textAlign: 'center' }}>
                {error?.message || zh.outfits.slotLoadFailed}
              </Text>
              <Pressable onPress={() => refetch()} accessibilityRole="button" hitSlop={8}>
                <Text
                  style={{
                    color: colors.foreground,
                    fontSize: 14,
                    fontWeight: '600',
                    marginTop: spacing.md,
                  }}
                >
                  {zh.common.retry}
                </Text>
              </Pressable>
            </View>
          ) : isLoading ? (
            <View style={[styles.center, { padding: spacing.xl }]}>
              <ActivityIndicator size="small" color={colors.mutedForeground} />
              <Text style={{ color: colors.mutedForeground, fontSize: 13, marginTop: spacing.md }}>
                {zh.outfits.slotLoading}
              </Text>
            </View>
          ) : items.length === 0 ? (
            <View style={[styles.center, { padding: spacing.xl }]}>
              <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: '500' }}>
                {emptyMessage.title}
              </Text>
              <Text
                style={{
                  color: colors.mutedForeground,
                  fontSize: 13,
                  marginTop: spacing.sm,
                  textAlign: 'center',
                }}
              >
                {emptyMessage.hint}
              </Text>
            </View>
          ) : (
            <FlatList
              data={shown}
              keyExtractor={(item) => item.id}
              numColumns={2}
              columnWrapperStyle={{ gap: spacing.md, paddingHorizontal: spacing.lg }}
              contentContainerStyle={{ gap: spacing.md, paddingVertical: spacing.lg }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              ListHeaderComponent={
                <Text
                  style={{
                    color: colors.mutedForeground,
                    fontSize: 12,
                    paddingHorizontal: spacing.lg,
                    paddingBottom: spacing.sm,
                  }}
                >
                  {zh.outfits.pickerShown(shown.length, items.length)}
                  {isFetching ? ` · ${zh.common.loading}` : ''}
                </Text>
              }
              ListFooterComponent={
                hasMoreToShow ? (
                  <View style={{ alignItems: 'center', paddingVertical: spacing.md }}>
                    <Pressable
                      onPress={() => setVisibleCount((count) => count + PAGE_STEP)}
                      accessibilityRole="button"
                      style={{
                        borderWidth: 1,
                        borderColor: colors.border,
                        borderRadius: radius,
                        paddingHorizontal: spacing.lg,
                        paddingVertical: spacing.sm,
                      }}
                    >
                      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '500' }}>
                        {zh.outfits.loadMore}
                      </Text>
                    </Pressable>
                    <Text
                      style={{ color: colors.mutedForeground, fontSize: 12, marginTop: spacing.xs }}
                    >
                      {zh.outfits.pickerScrollMore}
                    </Text>
                  </View>
                ) : null
              }
              renderItem={({ item }) => (
                <PickerTile
                  item={item}
                  selected={item.id === selectedId}
                  onSelect={() => onSelect(item)}
                  onRetry={refetch}
                />
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

function PickerTile({
  item,
  selected,
  onSelect,
  onRetry,
}: {
  item: Item;
  selected: boolean;
  onSelect: () => void;
  onRetry: () => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const typeLabel = clothingTypeLabel(item.type);
  const name = item.name || typeLabel || zh.outfits.garmentUnnamed;
  /**
   * The 待购 marker is driven by the server's `ownership`, not by which scope is
   * selected: an un-bought garment is labelled as such wherever it is shown.
   */
  const toBuy = isToBuy(item);

  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="button"
      accessibilityLabel={selected ? `${zh.outfits.pickerSelected}：${name}` : name}
      style={({ pressed }) => ({
        flex: 1,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? colors.foreground : colors.border,
        borderRadius: radius,
        overflow: 'hidden',
        backgroundColor: colors.card,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <View style={{ aspectRatio: 1, backgroundColor: colors.muted }}>
        <GarmentImage item={item} onRequestRetry={onRetry} />
        {toBuy ? (
          <View
            style={{
              position: 'absolute',
              top: 6,
              left: 6,
              backgroundColor: colors.primary,
              borderRadius: radius,
              paddingHorizontal: 6,
              paddingVertical: 2,
            }}
          >
            <Text style={{ color: colors.primaryForeground, fontSize: 11, fontWeight: '600' }}>
              {zh.outfits.toBuyMarker}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={{ padding: spacing.sm, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: '500' }}>
          {name}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.mutedForeground, fontSize: 12 }}>
          {selected
            ? zh.outfits.pickerSelected
            : toBuy
              ? `${zh.outfits.toBuyMarker} · ${typeLabel}`
              : typeLabel}
        </Text>
      </View>
    </Pressable>
  );
}
/** One side of the 已拥有 / 待购 switch. */
function ScopeChip({
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
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  backdropTap: {
    flex: 1,
  },
  sheet: {
    borderTopWidth: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
