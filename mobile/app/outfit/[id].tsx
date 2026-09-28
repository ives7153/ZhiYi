import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Pencil } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Item, OutfitItem } from '../../src/api/types';
import { ApiError, AuthError, NetworkError } from '../../src/api/errors';
import { clothingTypeLabel } from '../../src/api/itemVocab';
import { useItem } from '../../src/api/hooks';
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
  occasionLabel,
  outfitStatusLabel,
  type SlotKey,
} from '../../src/api/outfitVocab';
import {
  draftFromOutfitItems,
  draftItemIds,
  draftItemOverflow,
  draftSignature,
  passthroughReason,
  withoutPassthrough,
  type OutfitDraft,
} from '../../src/outfits/draft';
import {
  garmentAvailability,
  needsGarmentLookup,
  type GarmentAvailability,
  type GarmentLookup,
} from '../../src/outfits/garmentAvailability';
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
 *    the slots that were saved, and a rebuilt draft equals the saved one.
 *  - `PATCH /outfits/{id}` **replaces the whole item set**, so the editor sends the complete
 *    `items` array. Garments this round cannot place (连衣裙/连体衣, 待分类, and a second
 *    garment of a slot that is taken) are carried through unchanged rather than dropped:
 *    renaming an outfit must not quietly remove a garment from it.
 *  - Because that write *replaces*, the draft is never trimmed to fit the server's 20-item
 *    limit either. An outfit holding 20 garments plus one more is refused with the numbers and
 *    a per-row 从搭配中移除 action, instead of being saved from a shortened list that would
 *    delete the leftovers (round-3 review finding A).
 *  - `PATCH` answers **409 `OUTFIT_WORN_IMMUTABLE`** once the outfit has worn feedback
 *    (`StudioService.patch_outfit`), and **403 `OUTFIT_ITEM_OWNERSHIP`** for an item that is
 *    not `ready` — an archived or still-processing garment. Both are business answers for a
 *    valid session, so they keep the session, the cache and the edit, and are reported in the
 *    user's own words instead of as a status code (`errors.ts`: a 403 is only a credential
 *    failure when the server says the account is inactive).
 *  - A write whose answer never arrived is reported as **不确定**, never as "没保存": the
 *    request was already dispatched, and the server may have stored it (round-3 review
 *    finding B).
 *  - "这件单品已不在衣橱里" is only said on evidence — a 404 for that garment's id. A miss in
 *    the truncated candidate list is not evidence, and while it is being checked the row says
 *    nothing (`src/outfits/garmentAvailability.ts`, round-3 review finding C).
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
  /**
   * The over-limit state of the draft, if any.
   *
   * Read here rather than only inside `onSave` because the editor shows it next to the 其他单品
   * rows, where the user can act on it — the numbers in both places come from this one value.
   */
  const overflow = draft ? draftItemOverflow(draft) : null;

  /** Remove one 其他单品 garment from the outfit: the explicit exit from an over-limit draft. */
  const removeExtra = useCallback((garmentId: string) => {
    setDraft((current) => (current ? withoutPassthrough(current, garmentId) : current));
    setActionError(null);
  }, []);

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
    // More garments than the server accepts is a state the user must resolve, not one to send
    // truncated: `PATCH /outfits/{id}` deletes and recreates every `outfit_items` row from the
    // submitted list, so the garments left out would silently lose their association with this
    // outfit (round-3 review finding A — this used to send `draftItemIds`, which cut the list
    // to 20 without a word). The editor offers 从搭配中移除 for exactly this.
    const limit = draftItemOverflow(draft);
    if (limit) {
      setActionError(zh.outfits.saveTooManyItems(limit.total, limit.max, limit.excess));
      return;
    }

    try {
      // The item list is always sent: `PATCH` treats a missing `items` as "leave the garments
      // alone", and this editor has no way to express a partial garment change, so sending it
      // is the honest full update.
      //
      // The name is sent as a **string, including when it is empty**. `PATCH` distinguishes
      // "absent" from "empty" only by the value it receives: `PatchOutfitRequest.name` defaults
      // to `None` and `StudioService.patch_outfit` applies it under `if name is not None`, so
      // `null` is read as "leave the name alone" while `""` is stored as the cleared name.
      // Sending `name || null` therefore made clearing the field a silent no-op — the request
      // succeeded, the editor closed and the old name came back. Verified against the running
      // backend: `{"name":""}` → `GET` reports `name == ""`, `{"name":null}` → name unchanged.
      await patchOutfit.mutateAsync({ name: name.trim(), items });
      setEditing(false);
      setDraft(null);
    } catch (err) {
      if (err instanceof NetworkError) {
        // `outcomeUnknown` is true for every failure after dispatch — a timeout, a dropped
        // connection, a response body that never arrived — so the edit may already be stored
        // and the screen says so instead of claiming it failed (round-3 review finding B). The
        // wording is the editor's own: this `PATCH` replaces the item set of *this* outfit, so
        // saving again cannot create a second one and must not warn about that.
        setActionError(err.outcomeUnknown ? zh.outfits.saveUncertainEditMessage : err.message);
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
        // Only reachable because a business 403 stopped being an `AuthError`: before the fix
        // the global handler had already cleared the token and the query cache, so this
        // message never ran and the user was logged out with the edit discarded.
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
      if (err instanceof NetworkError && err.outcomeUnknown) {
        // The delete may have gone through: `DELETE /outfits/{id}` is idempotent, so a retry is
        // safe, but "删除失败" would be a claim the client cannot make.
        setActionError(zh.outfits.deleteUncertain);
        return;
      }
      setActionError(err instanceof ApiError && err.detail ? err.detail : zh.outfits.deleteFailed);
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

  /**
   * The 其他单品 rows: the passthrough garments that are **not** the one currently in a slot.
   *
   * A passthrough garment can become a slot garment while editing: pick, for its own slot, the
   * very garment that is sitting in 其他单品 (`ItemPickerSheet` marks the current garment of a
   * slot but does not exclude garments already in the draft), and `selection[slot].id` equals
   * that row's id. The row would then claim "同席位已有另一件" — which is no longer true — and
   * its 从搭配中移除 would remove only the now-redundant copy, so it would look like a button
   * that does nothing. `draftItemIds` de-duplicates by id, so the request was already correct;
   * this filter keeps the list and its rows from describing a state that is not there.
   */
  const selectedIds = useMemo(
    () =>
      new Set(
        Object.values(shown?.selection ?? {})
          .filter((garment): garment is Item => Boolean(garment))
          .map((garment) => garment.id),
      ),
    [shown],
  );
  const extraItems: OutfitItem[] = (shown?.passthrough ?? []).filter(
    (item) => !selectedIds.has(item.id),
  );

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
                {/*
                  The over-limit state, where it can still be acted on: the same numbers the
                  refused save reports, shown next to the rows that cause it. Nothing here is
                  trimmed automatically — `draftItemIds` sends every garment and
                  `PATCH /outfits/{id}` replaces the whole item set, so a shortened list would
                  delete the omitted garments' association while reporting success
                  (round-3 review finding A).
                */}
                {editing && overflow ? (
                  <Text style={{ ...typography.caption, color: colors.destructive }}>
                    {zh.outfits.saveTooManyItems(overflow.total, overflow.max, overflow.excess)}
                  </Text>
                ) : null}
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
                        {passthroughLabel(item)}
                      </Text>
                    </View>
                    {/*
                      Removal is offered only while editing, and only per garment: it is the
                      explicit, user-driven way out of the over-limit state, and the note under
                      the list says what it removes (the outfit's association, not the garment).
                    */}
                    {editing ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${zh.outfits.removeFromOutfit}：${item.name || zh.outfits.garmentUnnamed}`}
                        hitSlop={8}
                        onPress={() => removeExtra(item.id)}
                      >
                        <Text style={{ ...typography.caption, color: colors.destructive }}>
                          {zh.outfits.removeFromOutfit}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                ))}
                {editing ? (
                  <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
                    {zh.outfits.removeFromOutfitHint}
                  </Text>
                ) : null}
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
   * Is this garment still in the wardrobe?
   *
   * The slot query asks the server for the user's **non-archived** garments of that slot's
   * types, so a hit in its result is positive evidence. A *miss* is not negative evidence:
   * the merge stops after `MAX_PAGES_PER_TYPE` pages per type and reports `truncated` when it
   * does, and a garment re-classified in the wardrobe since it was saved is missing from its
   * old slot's list while being perfectly alive. The previous version of this row read the
   * miss as "这件单品已不在衣橱里（可能已归档）" and so told the user a live garment was gone
   * (round-3 review finding C).
   *
   * So a miss is resolved by asking about this one id instead — `GET /items/{id}` returns the
   * row whatever its `status` and `is_archived` (`ItemService.get_by_id` filters on id and
   * owner only), which makes the answer definite rather than inferred. The whole decision
   * table lives in `src/outfits/garmentAvailability.ts` so it can be tested off-device; this
   * component only turns its verdict into a sentence.
   */
  const { data: candidates, isSuccess: candidatesLoaded } = useSlotCandidates(slot, '');
  const foundInCandidates = Boolean(
    garment && (candidates?.items ?? []).some((item) => item.id === garment.id),
  );

  const lookupId = needsGarmentLookup({
    hasGarment: Boolean(garment),
    candidatesLoaded,
    foundInCandidates,
  })
    ? (garment?.id ?? null)
    : null;
  const {
    data: lookedUp,
    error: lookupError,
    isError: lookupFailed,
    isPending: lookupPending,
  } = useItem(lookupId);

  const lookup: GarmentLookup = !lookupId
    ? { state: 'idle' }
    : lookedUp
      ? { state: 'found', status: lookedUp.status, isArchived: lookedUp.is_archived }
      : lookupFailed
        ? lookupError instanceof ApiError && lookupError.status === 404
          ? { state: 'notFound' }
          : { state: 'error' }
        : lookupPending
          ? { state: 'loading' }
          : { state: 'idle' };

  const note = availabilityNote(
    garmentAvailability({
      hasGarment: Boolean(garment),
      candidatesLoaded,
      candidatesTruncated: candidates?.truncated ?? false,
      foundInCandidates,
      lookup,
    }),
  );

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
      {note ? (
        <Text
          numberOfLines={3}
          style={{
            ...typography.caption,
            maxWidth: 132,
            textAlign: 'right',
            color: note.destructive ? colors.destructive : colors.mutedForeground,
          }}
        >
          {note.text}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The sentence for one availability verdict, or `null` when there is nothing to report.
 *
 * `unknown` is deliberately muted and worded as "未能确认": the two situations that reach it
 * (the by-id check failed, or the server reported a status this build does not know) are not
 * evidence that the garment left the wardrobe.
 */
function availabilityNote(
  availability: GarmentAvailability,
): { text: string; destructive: boolean } | null {
  switch (availability) {
    case 'archived':
      return { text: zh.outfits.garmentArchivedNote, destructive: true };
    case 'missing':
      return { text: zh.outfits.garmentNotInWardrobe, destructive: true };
    case 'processing':
      return { text: zh.outfits.garmentProcessing, destructive: false };
    case 'failed':
      return { text: zh.outfits.garmentProcessingFailed, destructive: true };
    case 'unknown':
      return { text: zh.outfits.garmentStatusUnknown, destructive: false };
    case 'none':
    default:
      return null;
  }
}

/**
 * The 其他单品 subtitle for one garment.
 *
 * Three sentences, because there are three different reasons a garment has no slot in this
 * round, and saying "待分类" for a garment whose type the app knows perfectly well (a second
 * 上衣, say) is a false description of a same-slot conflict — round-3 review finding A.
 */
function passthroughLabel(garment: OutfitItem): string {
  switch (passthroughReason(garment)) {
    case 'sameSlotDuplicate':
      return zh.outfits.sameSlotDuplicate;
    case 'unsupportedFullBody':
      return zh.outfits.unsupportedItem;
    case 'unclassified':
    default:
      return zh.outfits.garmentUnclassified;
  }
}
