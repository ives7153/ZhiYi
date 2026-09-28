import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Item } from '../../src/api/types';
import { ApiError, NetworkError } from '../../src/api/errors';
import { useItemTypes } from '../../src/api/hooks';
import { useCreateOutfit } from '../../src/api/outfitHooks';
import {
  DEFAULT_OUTFIT_OCCASION,
  OUTFIT_NAME_MAX_LENGTH,
  SLOTS,
  SLOT_LABELS,
  UNSUPPORTED_FULL_BODY_TYPES,
  isUnclassified,
  type SlotKey,
} from '../../src/api/outfitVocab';
import {
  draftBlocker,
  draftItemIds,
  draftItemOverflow,
  emptyDraft,
  isDraftEmpty,
  missingRequiredSlots,
  type OutfitDraft,
} from '../../src/outfits/draft';
import { Button, Input, ScreenHeader } from '../../src/components/ui';
import { ConnectedSlotRow } from '../../src/components/SlotRowConnected';
import { ItemPickerSheet } from '../../src/components/ItemPickerSheet';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { useTheme } from '../../src/theme/ThemeContext';
import { zh } from '../../src/i18n/zh';

/**
 * 搭配 — the slot builder (round 3, steps 1 and 3).
 *
 * The screen owns the draft and nothing else server-side: candidates come from
 * `useSlotCandidates` (one query per slot, via `ConnectedSlotRow`), saving goes through
 * `useCreateOutfit`. What it is careful about:
 *
 *  1. **A swipe changes exactly one slot.** `setSlot` writes a single key of the draft, so
 *     "左右滑动只替换当前槽位" is a property of the data shape, not of the gesture code.
 *  2. **Nothing is invented about the wardrobe.** Garments this round cannot place
 *     (连衣裙/连体衣) and garments the server has not classified are counted from
 *     `GET /items/types` and reported as such; they are never quietly filed under 上衣.
 *  3. **A draft is not silently lost.** Leaving with an unsaved draft asks first, and an
 *     unsaved draft is never written anywhere (no offline queue — the round-1 rule).
 *  4. **A save that times out is not reported as success.** `POST /outfits/suggestions`
 *     has no idempotency key, so the screen says the outcome is unknown, offers to check
 *     the saved list, and warns that retrying may create a second outfit.
 */
export default function OutfitsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, spacing, typography, radius } = useTheme();

  const [draft, setDraft] = useState<OutfitDraft>(emptyDraft);
  const [name, setName] = useState('');
  const [pickerSlot, setPickerSlot] = useState<SlotKey | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveUncertain, setSaveUncertain] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const createOutfit = useCreateOutfit();
  const { data: typeCounts } = useItemTypes();

  /**
   * Wardrobe facts the slot model cannot express, straight from `GET /items/types`
   * (non-archived counts per type). Both numbers are shown so the user understands why a
   * garment never appears as a candidate.
   */
  const notes = useMemo(() => {
    const counts = typeCounts ?? [];
    const unclassified = counts
      .filter((entry) => isUnclassified(entry.type))
      .reduce((sum, entry) => sum + entry.count, 0);
    const fullBody = counts
      .filter((entry) => UNSUPPORTED_FULL_BODY_TYPES.includes(entry.type))
      .reduce((sum, entry) => sum + entry.count, 0);
    return { unclassified, fullBody };
  }, [typeCounts]);

  const setSlot = useCallback((slot: SlotKey, garment: Item) => {
    setDraft((current) => ({
      ...current,
      selection: { ...current.selection, [slot]: garment },
    }));
    setSaveError(null);
    setSaveUncertain(false);
  }, []);

  const missing = missingRequiredSlots(draft);
  const draftHasContent = !isDraftEmpty(draft);
  const nameTooLong = name.trim().length > OUTFIT_NAME_MAX_LENGTH;

  const onSave = useCallback(async () => {
    setSaveError(null);
    setSaveUncertain(false);

    const blocker = draftBlocker(draft, nameTooLong);
    if (blocker === 'empty') {
      setSaveError(zh.outfits.saveNeedsItem);
      return;
    }
    if (blocker === 'tooLong') {
      setSaveError(zh.outfits.saveNameTooLong(OUTFIT_NAME_MAX_LENGTH));
      return;
    }
    if (blocker === 'tooManyItems') {
      // Unreachable from *this* screen — five slots and no passthrough, so a new outfit
      // cannot exceed five garments — but handled explicitly rather than falling through:
      // `draftItemIds` returns every garment now, and sending more than the server's 20
      // would be a 422 instead of the refusal the user needs to see.
      const overflow = draftItemOverflow(draft);
      setSaveError(
        overflow
          ? zh.outfits.saveTooManyItems(overflow.total, overflow.max, overflow.excess)
          : zh.outfits.saveFailed,
      );
      return;
    }

    const items = draftItemIds(draft);
    try {
      const outfit = await createOutfit.mutateAsync({
        items,
        // The endpoint requires an occasion and this round does not ask for one; see
        // `DEFAULT_OUTFIT_OCCASION`. The stored value is shown back on the detail screen.
        occasion: DEFAULT_OUTFIT_OCCASION,
        name: name.trim() || null,
      });
      // Wait for the save to succeed before clearing: if it failed, the draft is what the
      // user needs to retry with.
      setDraft(emptyDraft());
      setName('');
      router.push(`/outfit/${outfit.id}`);
    } catch (error) {
      if (error instanceof NetworkError) {
        // Anything the transport broke after the request went out leaves the outcome open:
        // a timeout, a dropped connection, a body that never arrived. The old code treated
        // only a timeout that way and told the user a refused connection "一定没写入", which
        // the client cannot know (round-3 review finding B).
        if (error.outcomeUnknown) {
          setSaveUncertain(true);
          setSaveError(error.message);
          return;
        }
        // `outcomeUnknown: false` happens only before dispatch (no API base URL configured),
        // which is the one case where "没有保存" is a fact.
        setSaveError(error.message);
        return;
      }
      if (error instanceof ApiError && error.status === 403) {
        // `validate_item_ownership` rejects an item that is not `ready` — the realistic
        // cause here is that a chosen garment was archived or is still processing. A
        // business refusal, so the session and the draft both stay.
        setSaveError(zh.outfits.saveItemUnavailable);
        return;
      }
      setSaveError(error instanceof ApiError && error.detail ? error.detail : zh.outfits.saveFailed);
    }
  }, [createOutfit, draft, name, nameTooLong, router]);

  /**
   * Android's back button on this screen would otherwise leave the tab (and the app),
   * discarding the draft with no warning. While a draft exists the press is intercepted and
   * the user chooses. With nothing to lose, the default behaviour is left alone.
   */
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      // The picker's own Modal consumes back while it is open (`onRequestClose`), so this
      // handler only runs when no panel is showing.
      if (pickerSlot) return false;
      if (!draftHasContent && !name.trim()) return false;
      setConfirmLeave(true);
      return true;
    });
    return () => subscription.remove();
  }, [draftHasContent, name, pickerSlot]);

  const onDiscardAndLeave = useCallback(() => {
    setConfirmLeave(false);
    setDraft(emptyDraft());
    setName('');
    // The press that opened this dialog was a request to leave the screen; with the draft
    // gone there is nothing left to protect, so let the platform finish the job.
    BackHandler.exitApp();
  }, []);

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
        <ScreenHeader
          title={zh.outfits.title}
          subtitle={zh.outfits.subtitle}
          right={
            <Pressable
              onPress={() => router.push('/outfit')}
              accessibilityRole="button"
              hitSlop={8}
            >
              <Text style={{ ...typography.cardTitle, color: colors.foreground }}>
                {zh.outfits.savedListLink}
              </Text>
            </Pressable>
          }
        />

        {notes.unclassified > 0 ? (
          <Notice text={zh.outfits.unclassifiedNote(notes.unclassified)} />
        ) : null}
        {notes.fullBody > 0 ? <Notice text={zh.outfits.fullBodyNote} /> : null}

        <View style={{ gap: spacing.sm }}>
          <Text style={{ ...typography.cardTitle, color: colors.foreground }}>
            {zh.outfits.slotsSection}
          </Text>
          <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
            {zh.outfits.basicSlotsNote}
          </Text>
        </View>

        {SLOTS.map((slot) => (
          <ConnectedSlotRow
            key={slot}
            slot={slot}
            garment={draft.selection[slot] ?? null}
            onSelect={(item) => setSlot(slot, item)}
            onOpenPicker={() => setPickerSlot(slot)}
          />
        ))}

        {missing.length > 0 ? (
          <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
            {zh.outfits.missingRequired(
              missing.map((slot) => SLOT_LABELS[slot]).join('、'),
            )}
          </Text>
        ) : null}

        <View style={{ gap: spacing.xs, marginTop: spacing.sm }}>
          <Text style={{ ...typography.cardTitle, color: colors.foreground }}>
            {zh.outfits.nameLabel}
          </Text>
          <Input
            value={name}
            onChangeText={setName}
            placeholder={zh.outfits.namePlaceholder}
            autoCapitalize="sentences"
          />
        </View>

        {saveError ? (
          <View
            style={{
              borderWidth: 1,
              borderColor: colors.destructive,
              borderRadius: radius,
              padding: spacing.md,
              gap: spacing.sm,
            }}
          >
            <Text style={{ ...typography.cardTitle, color: colors.destructive }}>
              {saveUncertain ? zh.outfits.saveUncertainTitle : zh.outfits.saveFailedTitle}
            </Text>
            {/*
              Both facts, in the order they matter: what the transport reported (specific,
              from the typed error) and then what the user has to do about it. When the
              outcome is uncertain the guidance is `saveUncertainMessage`, which warns that a
              retry may create a second outfit — `POST /outfits/suggestions` has no
              idempotency key, so that warning is the only protection there is.
            */}
            <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
              {saveError}
            </Text>
            {saveUncertain ? (
              <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
                {zh.outfits.saveUncertainMessage}
              </Text>
            ) : null}
            {saveUncertain ? (
              <View style={{ flexDirection: 'row', gap: spacing.md }}>
                <Button
                  title={zh.outfits.checkSaved}
                  variant="outline"
                  size="sm"
                  onPress={() => router.push('/outfit')}
                />
                <Button title={zh.outfits.retrySave} size="sm" onPress={onSave} />
              </View>
            ) : null}
          </View>
        ) : null}

      </ScrollView>

      <View
        style={{
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.sm,
          paddingBottom: spacing.md,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          backgroundColor: colors.background,
        }}
      >
        <Button
          title={createOutfit.isPending ? zh.outfits.saving : zh.outfits.save}
          onPress={onSave}
          loading={createOutfit.isPending}
        />
      </View>

      <ItemPickerSheet
        visible={pickerSlot !== null}
        slot={pickerSlot ?? 'top'}
        selectedId={pickerSlot ? (draft.selection[pickerSlot]?.id ?? null) : null}
        onSelect={(item) => {
          if (pickerSlot) setSlot(pickerSlot, item);
          setPickerSlot(null);
        }}
        onClose={() => setPickerSlot(null)}
      />

      <ConfirmDialog
        visible={confirmLeave}
        title={zh.outfits.leaveTitle}
        message={zh.outfits.leaveMessage}
        confirmLabel={zh.outfits.leaveConfirm}
        cancelLabel={zh.outfits.keepEditing}
        destructive
        onConfirm={onDiscardAndLeave}
        onCancel={() => setConfirmLeave(false)}
      />
    </View>
  );
}

/** Small bordered note used for the two "these garments have no slot" statements. */
function Notice({ text }: { text: string }) {
  const { colors, radius, spacing, typography } = useTheme();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius,
        padding: spacing.md,
        backgroundColor: colors.muted,
      }}
    >
      <Text style={{ ...typography.caption, color: colors.mutedForeground }}>{text}</Text>
    </View>
  );
}
