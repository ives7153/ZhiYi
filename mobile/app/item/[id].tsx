import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  AlertCircle,
  ArrowLeft,
  Archive,
  Droplets,
  Heart,
  Loader2,
  Pencil,
  Trash2,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, AuthError, NetworkError } from '../../src/api/errors';
import { useItem } from '../../src/api/hooks';
import {
  useArchiveItem,
  useDeleteItem,
  useRestoreItem,
  useUpdateItem,
} from '../../src/api/itemMutations';
import type { Item, ItemUpdateFields } from '../../src/api/types';
import { clothingTypeLabel, colorLabel } from '../../src/api/itemVocab';
import { isToBuy } from '../../src/api/toBuy';
import { joinUrl, pickImageUrl } from '../../src/api/url';
import { apiBaseUrl } from '../../src/config/env';
import { Badge, Button } from '../../src/components/ui';
import { ColorSelect, InlineNotice, LabeledInput, TypeSelect } from '../../src/components/form';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { ErrorState } from '../../src/components/states';
import { useTheme } from '../../src/theme/ThemeContext';
import { zh } from '../../src/i18n/zh';

/**
 * 单品详情 — spec §6.5, extended in round 2 with edit, archive and delete.
 *
 * Three things this screen is careful about:
 *
 *  1. **No internal state names on screen.** `status` / `tagging_status` come back
 *     as `ready` / `pending` / … and the spec forbids showing those, so both are
 *     mapped through `zh.itemStatus`. Where the server's own error text is shown,
 *     it is labelled as a reason, not as a status.
 *
 *  2. **The confirmations state the real consequences**, which differ between the
 *     two destructive actions: archiving keeps the row, the photos and any outfit
 *     links (it only hides the item and stops it being suggested), while deleting
 *     removes the photos permanently and cascades to `outfit_items`. The copy was
 *     written from the handlers themselves, not from the button labels.
 *
 *  3. **Archive/delete wait for the server** before leaving the screen, and only
 *     then navigate back. Popping first and mutating afterwards would show the
 *     list before the change existed and then silently update it.
 */
export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, spacing, typography, radius, semantic } = useTheme();

  const itemId = id ?? '';
  const { data: item, isLoading, isError, error, refetch } = useItem(id ?? null);

  const updateItem = useUpdateItem(itemId);
  const archiveItem = useArchiveItem(itemId);
  const restoreItem = useRestoreItem(itemId);
  const deleteItem = useDeleteItem(itemId);

  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'archive' | 'delete' | null>(null);

  const isAuthFailure = error instanceof AuthError;
  const isNotFound = !isAuthFailure && error instanceof ApiError && error.status === 404;
  const errorMessage = isAuthFailure
    ? zh.login.sessionExpired
    : error instanceof NetworkError
      ? error.message
      : isNotFound
        ? zh.itemDetail.notFound
        : zh.wardrobe.errors.loadFailed;

  // Prefer the medium derivative for the hero image; fall back to the original.
  const heroUrl = item ? joinUrl(apiBaseUrl, item.medium_url) ?? pickImageUrl(apiBaseUrl, item) : null;

  /**
   * Every write handler below distinguishes "the server refused" from "we never learned".
   *
   * `ApiError` is a real answer (a 4xx/5xx the server sent), so its own wording or the
   * action's failure copy is accurate. A `NetworkError` with `outcomeUnknown` is not an
   * answer at all: the request was dispatched and the reply was lost, so the mutation may
   * well have taken effect — saying "归档失败" would assert something the client cannot know,
   * and the user would re-archive (or worse, re-delete) on a false premise.
   *
   * Nothing is reset on any failure path: the edit form and its typed values stay mounted
   * until a save actually succeeds, and the screen stays put rather than navigating back, so
   * the user can check the outcome before acting again.
   */
  const onSave = useCallback(
    async (fields: ItemUpdateFields) => {
      setActionError(null);
      try {
        await updateItem.mutateAsync(fields);
        setEditing(false);
      } catch (err) {
        if (err instanceof NetworkError && err.outcomeUnknown) {
          setActionError(zh.itemActions.saveUncertain);
          return;
        }
        setActionError(
          err instanceof ApiError && err.detail ? err.detail : zh.itemActions.saveFailed,
        );
      }
    },
    [updateItem],
  );

  const onArchive = useCallback(async () => {
    setActionError(null);
    try {
      await archiveItem.mutateAsync(undefined);
      setConfirm(null);
      router.back();
    } catch (err) {
      setConfirm(null);
      if (err instanceof NetworkError && err.outcomeUnknown) {
        setActionError(zh.itemActions.archiveUncertain);
        return;
      }
      setActionError(
        err instanceof ApiError && err.detail ? err.detail : zh.itemActions.archiveFailed,
      );
    }
  }, [archiveItem, router]);

  const onDelete = useCallback(async () => {
    setActionError(null);
    try {
      await deleteItem.mutateAsync();
      setConfirm(null);
      router.back();
    } catch (err) {
      setConfirm(null);
      if (err instanceof NetworkError && err.outcomeUnknown) {
        setActionError(zh.itemActions.deleteUncertain);
        return;
      }
      setActionError(
        err instanceof ApiError && err.detail ? err.detail : zh.itemActions.deleteFailed,
      );
    }
  }, [deleteItem, router]);

  const onRestore = useCallback(async () => {
    setActionError(null);
    try {
      await restoreItem.mutateAsync();
    } catch (err) {
      if (err instanceof NetworkError && err.outcomeUnknown) {
        setActionError(zh.itemActions.restoreUncertain);
        return;
      }
      setActionError(
        err instanceof ApiError && err.detail ? err.detail : zh.itemActions.archiveFailed,
      );
    }
  }, [restoreItem]);

  const isMutating =
    updateItem.isPending || archiveItem.isPending || deleteItem.isPending || restoreItem.isPending;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ headerShown: false }} />

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          paddingTop: insets.top + spacing.md,
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.md,
        }}
      >
        <Button
          title=""
          variant="ghost"
          icon={<ArrowLeft size={20} color={colors.foreground} />}
          onPress={() => router.back()}
        />
        <Text style={{ ...typography.screenTitle, color: colors.foreground, flex: 1 }}>
          {zh.itemDetail.title}
        </Text>
        {item && !editing ? (
          <Button
            title={zh.itemActions.edit}
            variant="outline"
            size="sm"
            icon={<Pencil size={14} color={colors.foreground} />}
            onPress={() => setEditing(true)}
          />
        ) : null}
      </View>

      {isLoading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : isError || !item ? (
        <ErrorState
          message={errorMessage}
          onRetry={isAuthFailure ? () => router.replace('/login') : () => void refetch()}
        />
      ) : (
        <ScrollView
          contentContainerStyle={{
            padding: spacing.lg,
            paddingBottom: spacing.xxl * 2,
            gap: spacing.lg,
          }}
        >
          {/*
            A 待购 garment opened on this route (a stale link, or a deep link) is not part
            of the wardrobe: it has no wear history, and the actions here are the wardrobe
            ones. Rather than hiding that, the screen says which side the garment is on and
            offers to open the screen built for it — where editing, 试搭 and 「已购买，移入
            衣橱」 live, and where the delete is guarded by the item's ownership.
          */}
          {isToBuy(item) ? (
            <InlineNotice
              tone="neutral"
              title={zh.toBuy.badge}
              message={zh.itemDetail.toBuyOnWardrobeRoute}
              action={
                <Button
                  title={zh.itemDetail.openToBuyDetail}
                  variant="outline"
                  size="sm"
                  onPress={() => router.replace(`/to-buy/${item.id}`)}
                />
              }
            />
          ) : null}

          <View
            style={{
              width: '100%',
              aspectRatio: 1,
              borderRadius: radius,
              overflow: 'hidden',
              backgroundColor: colors.muted,
            }}
          >
            {heroUrl ? (
              <Image source={{ uri: heroUrl }} style={styles.hero} resizeMode="cover" />
            ) : (
              <View style={styles.heroPlaceholder}>
                <Text style={{ color: colors.mutedForeground }}>
                  {clothingTypeLabel(item.type)}
                </Text>
              </View>
            )}

            {item.favorite ? (
              <View style={styles.heroTopRight}>
                <Heart size={20} color={semantic.red500} fill={semantic.red500} />
              </View>
            ) : null}
            {item.needs_wash ? (
              <View style={styles.heroBottomRight}>
                <View style={{ backgroundColor: semantic.amber500, borderRadius: 999, padding: 6 }}>
                  <Droplets size={16} color="#FFFFFF" />
                </View>
              </View>
            ) : null}

            {item.status === 'processing' ? (
              <View style={styles.processingOverlay}>
                <Loader2 size={24} color="#FFFFFF" />
                <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '500' }}>
                  {zh.wardrobe.analyzing}
                </Text>
              </View>
            ) : null}
          </View>

          {actionError ? <InlineNotice message={actionError} /> : null}

          {/* Status as plain words, never the raw enum. */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            <Badge label={statusLabel(item.status)} tone="secondary" />
            <Badge label={taggingLabel(item.tagging_status)} tone="secondary" />
            {item.is_archived ? <Badge label={zh.itemStatus.archived} tone="secondary" /> : null}
            {item.needs_wash ? <Badge label={zh.wardrobe.needsWash} tone="secondary" /> : null}
          </View>

          {/*
           * `ai_error` is the server's own failure reason. It is shown verbatim
           * because "the model returned no usable type" and "the endpoint was
           * unreachable" need different user reactions, and a generic message
           * would hide which one happened.
           */}
          {item.ai_error ? (
            <View
              style={{
                flexDirection: 'row',
                gap: spacing.sm,
                borderWidth: 1,
                borderColor: colors.destructive,
                backgroundColor: `${colors.destructive}1A`,
                borderRadius: radius,
                padding: spacing.md,
              }}
            >
              <AlertCircle size={16} color={colors.destructive} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.destructive, fontSize: 13, fontWeight: '500' }}>
                  {zh.itemDetail.aiError}
                </Text>
                <Text style={{ color: colors.destructive, fontSize: 13 }}>{item.ai_error}</Text>
              </View>
            </View>
          ) : null}

          {editing ? (
            <EditForm item={item} saving={updateItem.isPending} onSave={onSave} onCancel={() => setEditing(false)} />
          ) : (
            <View
              style={{
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radius,
                backgroundColor: colors.card,
                overflow: 'hidden',
              }}
            >
              <Field label={zh.itemDetail.type} value={clothingTypeLabel(item.type)} first />
              <Field label={zh.itemDetail.subtype} value={item.subtype} />
              <Field label={zh.itemDetail.name} value={item.name} />
              <Field label={zh.itemDetail.brand} value={item.brand} />
              <Field
                label={zh.itemDetail.colors}
                value={
                  item.colors && item.colors.length > 0
                    ? item.colors.map(colorLabel).join('、')
                    : null
                }
              />
              <Field label={zh.itemDetail.wearCount} value={String(item.wear_count)} />
              <Field label={zh.itemDetail.lastWornAt} value={item.last_worn_at} />
              <Field label={zh.itemDetail.createdAt} value={formatDate(item.created_at)} />
            </View>
          )}

          {/* ---------- destructive actions ---------- */}
          {!editing ? (
            <View style={{ gap: spacing.md, paddingTop: spacing.md }}>
              {item.is_archived ? (
                <Button
                  title={zh.itemActions.restore}
                  variant="outline"
                  loading={restoreItem.isPending}
                  disabled={isMutating}
                  onPress={() => void onRestore()}
                />
              ) : (
                <Button
                  title={zh.itemActions.archive}
                  variant="outline"
                  icon={<Archive size={16} color={colors.foreground} />}
                  disabled={isMutating}
                  onPress={() => setConfirm('archive')}
                />
              )}
              <Button
                title={zh.itemActions.delete}
                variant="destructive"
                icon={<Trash2 size={16} color={colors.destructive} />}
                disabled={isMutating}
                onPress={() => setConfirm('delete')}
              />
            </View>
          ) : null}
        </ScrollView>
      )}

      <ConfirmDialog
        visible={confirm === 'archive'}
        title={zh.itemActions.archiveTitle}
        message={zh.itemActions.archiveMessage}
        confirmLabel={zh.itemActions.archive}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void onArchive()}
      />
      <ConfirmDialog
        visible={confirm === 'delete'}
        title={zh.itemActions.deleteTitle}
        message={zh.itemActions.deleteMessage}
        confirmLabel={zh.itemActions.deleteConfirm}
        destructive
        onCancel={() => setConfirm(null)}
        onConfirm={() => void onDelete()}
      />
    </View>
  );
}

/** Maps the server's `status` onto user-facing Chinese. */
function statusLabel(status: string): string {
  switch (status) {
    case 'processing':
      return zh.itemStatus.processing;
    case 'ready':
      return zh.itemStatus.ready;
    case 'error':
      return zh.itemStatus.error;
    case 'archived':
      return zh.itemStatus.archived;
    default:
      return zh.itemStatus.unknown;
  }
}

/** Maps the server's `tagging_status` onto user-facing Chinese. */
function taggingLabel(status: string): string {
  switch (status) {
    case 'pending':
      return zh.itemStatus.taggingPending;
    case 'tagged':
      return zh.itemStatus.taggingTagged;
    default:
      return zh.itemStatus.taggingUnknown;
  }
}

/** ISO timestamp → `YYYY-MM-DD`, which is what a person reads. */
function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : iso;
}

/**
 * The inline edit form.
 *
 * Only `ItemUpdate` fields are offered. `favorite` gets a toggle because it is one
 * of them and is otherwise unreachable from the app; `status` is deliberately
 * absent — it is the server's to own, and letting a client write `ready` would
 * bypass the AI/processing lifecycle the spec says not to work around.
 */
function EditForm({
  item,
  saving,
  onSave,
  onCancel,
}: {
  item: Item;
  saving: boolean;
  onSave: (fields: ItemUpdateFields) => void;
  onCancel: () => void;
}) {
  const { colors, spacing } = useTheme();

  // `unknown` is what the server stores when nothing was supplied. Presenting it
  // as a chosen category would be misleading, so it shows as "not chosen" and
  // stays absent from the payload unless the user picks something.
  const [type, setType] = useState<string | null>(
    item.type && item.type !== 'unknown' ? item.type : null,
  );
  const [name, setName] = useState(item.name ?? '');
  const [brand, setBrand] = useState(item.brand ?? '');
  const [colors_, setColors] = useState<string[]>(item.colors ?? []);
  const [favorite, setFavorite] = useState(item.favorite);

  /**
   * Submits **only the fields that actually changed**.
   *
   * This matters more than a normal PATCH diff would, because the server treats a
   * write to `type`, `subtype`, `colors`, `primary_color` or `tags` as a manual
   * tagging action (`TAG_WRITEBACK_FIELDS` in `backend/app/api/items.py`): it then
   * sets `tagging_status = "tagged"` and `tagged_by = "manual"`. Sending the
   * unchanged `type` on every save therefore relabelled an untouched garment as
   * manually tagged — so merely toggling the favourite flag, or renaming, would
   * flip a `pending` item to `tagged` and claim a person had classified it.
   *
   * An earlier version sent `type: type ?? 'unknown'` unconditionally, which did
   * exactly that. Omitting unchanged fields is the fix, and it is also what PATCH
   * means: `ItemUpdate` is applied with `exclude_unset=True` server-side.
   *
   * A cleared category is deliberately NOT sent. `clothing_items.type` is
   * `nullable=False`, so clearing it would be a constraint violation rather than
   * "reset to unclassified"; leaving the field out keeps the existing value and
   * the user can still pick a different one.
   */
  const submit = useCallback(() => {
    const fields: ItemUpdateFields = {};

    const originalType = item.type && item.type !== 'unknown' ? item.type : null;
    if (type !== null && type !== originalType) fields.type = type;

    const trimmedName = name.trim();
    if (trimmedName !== (item.name ?? '')) fields.name = trimmedName || null;

    const trimmedBrand = brand.trim();
    if (trimmedBrand !== (item.brand ?? '')) fields.brand = trimmedBrand || null;

    const originalColors = item.colors ?? [];
    if (!sameStringSet(colors_, originalColors)) {
      fields.colors = colors_;
      fields.primary_color = colors_[0] ?? null;
    }

    if (favorite !== item.favorite) fields.favorite = favorite;

    // Nothing changed: close the editor instead of firing a no-op PATCH that the
    // server would still count as activity.
    if (Object.keys(fields).length === 0) {
      onCancel();
      return;
    }

    onSave(fields);
  }, [onSave, onCancel, item, type, name, brand, colors_, favorite]);

  return (
    <View style={{ gap: spacing.lg }}>
      <LabeledInput
        label={zh.itemDetail.name}
        value={name}
        onChangeText={setName}
        editable={!saving}
        maxLength={100}
        placeholder={zh.addItem.namePlaceholder}
      />

      <TypeSelect value={type} onChange={setType} />

      <ColorSelect values={colors_} onChange={setColors} />

      <LabeledInput
        label={zh.itemDetail.brand}
        value={brand}
        onChangeText={setBrand}
        editable={!saving}
        maxLength={100}
        placeholder={zh.addItem.brandPlaceholder}
      />

      <ToggleRow
        label={zh.wardrobe.favorites}
        value={favorite}
        disabled={saving}
        onChange={() => setFavorite((v) => !v)}
      />

      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        <View style={{ flex: 1 }}>
          <Button title={zh.itemActions.cancel} variant="outline" disabled={saving} onPress={onCancel} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title={zh.itemActions.save} loading={saving} onPress={submit} />
        </View>
      </View>

      <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{zh.addItem.detailsHint}</Text>
    </View>
  );
}

/** A labelled on/off row. */
function ToggleRow({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>{label}</Text>
      <Button
        title={value ? zh.addItem.favoriteOn : zh.addItem.favoriteOff}
        variant={value ? 'default' : 'outline'}
        size="sm"
        disabled={disabled}
        onPress={onChange}
      />
    </View>
  );
}

function Field({
  label,
  value,
  first = false,
}: {
  label: string;
  value: string | null | undefined;
  first?: boolean;
}) {
  const { colors, spacing } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: spacing.lg,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: colors.border,
      }}
    >
      <Text style={{ color: colors.mutedForeground, fontSize: 14 }}>{label}</Text>
      <Text
        numberOfLines={2}
        style={{ color: colors.foreground, fontSize: 14, flex: 1, textAlign: 'right' }}
      >
        {value && value.length > 0 ? value : zh.itemDetail.none}
      </Text>
    </View>
  );
}

/**
 * Order-insensitive comparison of two colour lists.
 *
 * `colors` is stored as a Postgres array and comes back in the server's own order,
 * so comparing joined strings would report a change whenever the same set arrived
 * in a different order — and then send a tag-writing PATCH for nothing.
 */
function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

const styles = StyleSheet.create({
  hero: { width: '100%', height: '100%' },
  heroPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  heroTopRight: { position: 'absolute', top: 12, right: 12 },
  heroBottomRight: { position: 'absolute', bottom: 12, right: 12 },
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
});
