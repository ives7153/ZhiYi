import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Pencil } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Item, OutfitItem } from '../../src/api/types';
import { ApiError, AuthError, NetworkError } from '../../src/api/errors';
import { clothingTypeLabel } from '../../src/api/itemVocab';
import {
  useDeleteOutfit,
  useOutfit,
  usePatchOutfit,
  useSlotCandidates,
} from '../../src/api/outfitHooks';
import {
  OUTFIT_NAME_MAX_LENGTH,
  SLOTS,
  SLOT_LABELS,
  isUnsupportedFullBody,
  occasionLabel,
  outfitStatusLabel,
  type SlotKey,
} from '../../src/api/outfitVocab';
import {
  draftFromOutfitItems,
  draftItemIds,
  draftSignature,
  type OutfitDraft,
} from '../../src/outfits/draft';
import { Button, Input } from '../../src/components/ui';
import { GarmentImage } from '../../src/components/GarmentImage';
import { ConnectedSlotRow } from '../../src/components/SlotRowConnected';
import { ItemPickerSheet } from '../../src/components/ItemPickerSheet';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { useTheme } from '../../src/theme/ThemeContext';
import { zh } from '../../src/i18n/zh';

/**
 * 搭配详情 — one saved outfit, with edit and delete (round 3, step 3).
 *
 * Facts this screen is built around, all read from the API rather than assumed:
 *
 *  - Slots are **derived** from each garment's `type` (`src/api/outfitVocab.ts` explains why
 *    they are not stored), so reopening the outfit from a cold start reconstructs exactly
 *    the slots that were saved.
 *  - `PATCH /outfits/{id}` **replaces the whole item set**, so the editor sends the complete
 *    `items` array. Garments this round cannot place (连衣裙/连体衣, 待分类) are carried
 *    through unchanged rather than dropped: renaming an outfit must not quietly remove a
 *    garment from it.
 *  - `PATCH` answers **409 `OUTFIT_WORN_IMMUTABLE`** once the outfit has worn feedback
 *    (`StudioService.patch_outfit`), and **403 `OUTFIT_ITEM_OWNERSHIP`** for an item that is
 *    not `ready` — an archived garment. Both are reported in the user's own words instead of
 *    as a status code.
 *  - Deleting removes the outfit only. `outfit_items` rows cascade away with it, and no
 *    `ClothingItem` is touched, which is what the confirmation says.
 */
export default function OutfitDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const outfitId = id ?? '';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, spacing, typography, radius } = useTheme();

  const { data: outfit, isLoading, isError, error, refetch } = useOutfit(id ?? null);
  const patchOutfit = usePatchOutfit(outfitId);
  const deleteOutfit = useDeleteOutfit(outfitId);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<OutfitDraft | null>(null);
  const [name, setName] = useState('');
  const [baseline, setBaseline] = useState('');
  const [pickerSlot, setPickerSlot] = useState<SlotKey | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'leave' | null>(null);

  /** What the server currently holds, in slot form. */
  const serverDraft = useMemo(
    () => (outfit ? draftFromOutfitItems(outfit.items) : null),
    [outfit],
  );

  /** What the user is (or should be) looking at: their draft while editing. */
  const shown = editing && draft ? draft : serverDraft;

  const isAuthFailure = error instanceof AuthError;
  const isNotFound = !isAuthFailure && error instanceof ApiError && error.status === 404;
  const loadError = isAuthFailure
    ? zh.login.sessionExpired
    : error instanceof NetworkError
      ? error.message
      : isNotFound
        ? zh.outfits.notFound
        : zh.outfits.loadFailed;

  const startEdit = useCallback(() => {
    if (!serverDraft || !outfit) return;
    setDraft(serverDraft);
    setName(outfit.name ?? '');
    setBaseline(`${draftSignature(serverDraft)}|${outfit.name ?? ''}`);
    setActionError(null);
    setEditing(true);
  }, [outfit, serverDraft]);

  const cancelEdit = useCallback(() => {
    setDraft(null);
    setEditing(false);
    setPickerSlot(null);
    setActionError(null);
  }, []);

  const currentSignature = draft ? `${draftSignature(draft)}|${name}` : '';
  const dirty = editing && currentSignature !== baseline;
  const nameTooLong = name.trim().length > OUTFIT_NAME_MAX_LENGTH;

  const onSave = useCallback(async () => {
    if (!draft) return;
    setActionError(null);

    if (nameTooLong) {
      setActionError(zh.outfits.saveNameTooLong(OUTFIT_NAME_MAX_LENGTH));
      return;
    }
    const items = draftItemIds(draft);
    if (items.length === 0) {
      setActionError(zh.outfits.saveNeedsItem);
      return;
    }

    try {
      // The name is always sent, and the item list is always sent: `PATCH` treats a missing
      // `items` as "leave the garments alone", and this editor has no way to express a
      // partial garment change, so sending both is the honest full update.
      await patchOutfit.mutateAsync({ name: name.trim() || null, items });
      setEditing(false);
      setDraft(null);
    } catch (err) {
      if (err instanceof NetworkError && err.timedOut) {
        setActionError(zh.outfits.saveUncertainMessage);
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        setActionError(zh.outfits.saveWornImmutable);
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        setActionError(zh.outfits.saveNotFound);
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setActionError(zh.outfits.saveItemUnavailable);
        return;
      }
      setActionError(err instanceof ApiError && err.detail ? err.detail : zh.outfits.saveFailed);
    }
  }, [draft, name, nameTooLong, patchOutfit]);

  const onDelete = useCallback(async () => {
    setActionError(null);
    try {
      await deleteOutfit.mutateAsync();
      setConfirm(null);
      router.back();
    } catch (err) {
      setConfirm(null);
      setActionError(
        err instanceof ApiError && err.detail ? err.detail : zh.outfits.deleteFailed,
      );
    }
  }, [deleteOutfit, router]);

  /**
   * Android back while editing: revert the edit instead of leaving the screen, so the
   * unsaved change is not lost silently. With no pending change the default behaviour
   * (leave the screen) is kept.
   */
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (pickerSlot) return false;
      if (!editing || !dirty) return false;
      setConfirm('leave');
      return true;
    });
    return () => subscription.remove();
  }, [dirty, editing, pickerSlot]);

  const extraItems: OutfitItem[] = shown?.passthrough ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ headerShown: false }} />
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
              {zh.outfits.savedTitle}
            </Text>
          </View>
        </Pressable>

        {isLoading ? (
          <Text style={{ ...typography.subtitle, color: colors.mutedForeground }}>
            {zh.common.loading}
          </Text>
        ) : isError ? (
          <View style={{ gap: spacing.md, paddingVertical: spacing.xl }}>
            <Text style={{ ...typography.subtitle, color: colors.destructive }}>{loadError}</Text>
            {!isNotFound ? (
              <Button
                title={zh.common.retry}
                variant="outline"
                size="sm"
                onPress={() => void refetch()}
              />
            ) : null}
          </View>
        ) : outfit && shown ? (
          <>
            <Text style={{ ...typography.screenTitle, color: colors.foreground }}>
              {editing ? zh.outfits.edit : outfit.name || zh.outfits.unnamed}
            </Text>
            <Text
              style={{ ...typography.caption, color: colors.mutedForeground }}
              accessibilityLabel={zh.outfits.detailTitle}
            >
              {zh.outfits.detailOccasion} {occasionLabel(outfit.occasion)} ·{' '}
              {zh.outfits.detailStatus} {outfitStatusLabel(outfit.status)}
            </Text>

            {editing ? (
              <View style={{ gap: spacing.xs }}>
                <Text style={{ ...typography.cardTitle, color: colors.foreground }}>
                  {zh.outfits.nameLabel}
                </Text>
                <Input value={name} onChangeText={setName} placeholder={zh.outfits.namePlaceholder} />
                <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
                  {zh.outfits.editHint}
                </Text>
              </View>
            ) : null}

            <Text style={{ ...typography.cardTitle, color: colors.foreground }}>
              {zh.outfits.detailItems}
            </Text>

            {SLOTS.map((slot) => {
              const garment = shown.selection[slot] ?? null;
              if (editing) {
                return (
                  <ConnectedSlotRow
                    key={slot}
                    slot={slot}
                    garment={garment}
                    onSelect={(item) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              selection: { ...current.selection, [slot]: item },
                            }
                          : current,
                      )
                    }
                    onOpenPicker={() => setPickerSlot(slot)}
                  />
                );
              }
              return (
                <ReadOnlySlotRow
                  key={slot}
                  slot={slot}
                  label={SLOT_LABELS[slot]}
                  garment={garment}
                  emptyText={zh.outfits.slotEmpty}
                />
              );
            })}

            {extraItems.length > 0 ? (
              <View style={{ gap: spacing.sm }}>
                <Text style={{ ...typography.cardTitle, color: colors.foreground }}>
                  {zh.outfits.othersSection}
                </Text>
                <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
                  {zh.outfits.othersNote}
                </Text>
                {extraItems.map((item) => (
                  <View
                    key={item.id}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: spacing.md,
                      borderWidth: 1,
                      borderColor: colors.border,
                      borderRadius: radius,
                      padding: spacing.md,
                    }}
                  >
                    <View
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: radius,
                        overflow: 'hidden',
                        backgroundColor: colors.muted,
                      }}
                    >
                      <GarmentImage item={item} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        numberOfLines={1}
                        style={{ ...typography.cardTitle, color: colors.foreground }}
                      >
                        {item.name || zh.outfits.garmentUnnamed}
                      </Text>
                      <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
                        {isUnsupportedFullBody(item.type)
                          ? zh.outfits.unsupportedItem
                          : zh.outfits.garmentUnclassified}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            {actionError ? (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: colors.destructive,
                  borderRadius: radius,
                  padding: spacing.md,
                }}
              >
                <Text style={{ ...typography.caption, color: colors.destructive }}>
                  {actionError}
                </Text>
              </View>
            ) : null}

            <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
              {editing ? (
                <>
                  <Button
                    title={patchOutfit.isPending ? zh.outfits.saving : zh.outfits.save}
                    loading={patchOutfit.isPending}
                    disabled={!dirty}
                    onPress={onSave}
                  />
                  <Button title={zh.outfits.cancel} variant="outline" onPress={cancelEdit} />
                </>
              ) : (
                <>
                  <Button
                    title={zh.outfits.edit}
                    icon={<Pencil size={16} color={colors.primaryForeground} />}
                    onPress={startEdit}
                  />
                  <Button
                    title={zh.outfits.delete}
                    variant="destructive"
                    onPress={() => setConfirm('delete')}
                  />
                </>
              )}
            </View>
          </>
        ) : null}
      </ScrollView>

      <ItemPickerSheet
        visible={pickerSlot !== null}
        slot={pickerSlot ?? 'top'}
        selectedId={pickerSlot ? (draft?.selection[pickerSlot]?.id ?? null) : null}
        onSelect={(item: Item) => {
          if (pickerSlot) {
            setDraft((current) =>
              current
                ? { ...current, selection: { ...current.selection, [pickerSlot]: item } }
                : current,
            );
          }
          setPickerSlot(null);
        }}
        onClose={() => setPickerSlot(null)}
      />

      <ConfirmDialog
        visible={confirm === 'delete'}
        title={zh.outfits.deleteTitle}
        message={zh.outfits.deleteMessage}
        confirmLabel={zh.outfits.deleteConfirm}
        cancelLabel={zh.outfits.cancel}
        destructive
        onConfirm={onDelete}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        visible={confirm === 'leave'}
        title={zh.outfits.leaveTitle}
        message={zh.outfits.leaveEditMessage}
        confirmLabel={zh.outfits.leaveConfirm}
        cancelLabel={zh.outfits.keepEditing}
        destructive
        onConfirm={() => {
          setConfirm(null);
          cancelEdit();
        }}
        onCancel={() => setConfirm(null)}
      />
    </View>
  );
}

/** Read-only slot row: the same shape as the editor's, without the controls. */
function ReadOnlySlotRow({
  slot,
  label,
  garment,
  emptyText,
}: {
  label: string;
  garment: Item | null;
  emptyText: string;
  /** Slot key, used only to reuse the candidate query for the "still in the wardrobe" check. */
  slot: SlotKey;
}) {
  const { colors, spacing, typography, radius } = useTheme();
  // The garment's own type, in Chinese — never the raw enum (the rule at the top of zh.ts).
  const typeLabel = garment ? clothingTypeLabel(garment.type) : '';

  /**
   * Is this garment still a live candidate for its slot?
   *
   * The slot query asks for the user's **non-archived** garments, and archiving sets
   * `status = archived` server-side. So a garment that appears in the outfit but not in its
   * slot's candidate list is one the wardrobe no longer offers — the honest way to say
   * "this may have been archived" without inventing an `is_archived` flag that
   * `OutfitItemResponse` does not return. Nothing is shown until that query has answered,
   * so a still-loading list never produces a false warning.
   */
  const { data: candidates, isSuccess: candidatesLoaded } = useSlotCandidates(slot, '');
  const notInWardrobe =
    Boolean(garment) &&
    candidatesLoaded &&
    !(candidates?.items ?? []).some((item) => item.id === garment?.id);

  return (
    <View
      accessibilityLabel={`${label}席位`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius,
        backgroundColor: colors.card,
        padding: spacing.md,
      }}
    >
      <View style={{ width: 48 }}>
        <Text style={{ ...typography.cardTitle, color: colors.foreground }}>{label}</Text>
      </View>
      {garment ? (
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: radius,
            overflow: 'hidden',
            backgroundColor: colors.muted,
          }}
        >
          <GarmentImage item={garment} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ ...typography.cardTitle, color: colors.foreground }}>
          {garment ? garment.name || zh.outfits.garmentUnnamed : emptyText}
        </Text>
        {typeLabel ? (
          <Text style={{ ...typography.caption, color: colors.mutedForeground }}>{typeLabel}</Text>
        ) : null}
      </View>
        {notInWardrobe ? (
          <Text style={{ ...typography.caption, color: colors.destructive }}>
            {zh.outfits.garmentNotInWardrobe}
          </Text>
        ) : null}
    </View>
  );
}
