import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Image, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, CheckCircle2, ExternalLink, Pencil } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Item, ItemUpdateFields } from '../../src/api/types';
import { ApiError, AuthError, NetworkError } from '../../src/api/errors';
import { clothingTypeLabel, colorLabel } from '../../src/api/itemVocab';
import { useDeleteItem, usePurchaseItem, useUpdateItem } from '../../src/api/itemMutations';
import { useItem } from '../../src/api/hooks';
import {
  TO_BUY,
  formatReferencePrice,
  isHttpUrl,
  normalizeStoredPrice,
  parseReferencePrice,
  parseSourceUrl,
  sourceUrlHost,
} from '../../src/api/toBuy';
import { joinUrl } from '../../src/api/url';
import { apiBaseUrl } from '../../src/config/env';
import { Button } from '../../src/components/ui';
import { InlineNotice, LabeledInput, TypeSelect } from '../../src/components/form';
import { GarmentImage } from '../../src/components/GarmentImage';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { useTheme } from '../../src/theme/ThemeContext';
import { zh } from '../../src/i18n/zh';

/**
 * 待购单品详情 — view, edit, delete, trial and 「已购买，移入衣橱」 (round 4).
 *
 * The screen is written around what the server actually guarantees:
 *
 *  - **The record is the server's.** Everything shown comes from `GET /items/{id}`;
 *    nothing is derived from a list the user happened to scroll past. A 404 means the
 *    row is gone (deleted here or elsewhere) and the screen says so instead of rendering
 *    a phantom.
 *  - **Edit sends a diff.** `PATCH /items/{id}` records a manual classification when
 *    `type` (or a colour/tag field) is present, so only genuinely changed fields are
 *    sent; renaming a garment must not claim a person re-classified it.
 *  - **Buying keeps the same garment.** `POST /items/{id}/purchase` flips ownership on
 *    this row: same id, same image, same outfit links. The success panel therefore offers
 *    「去衣橱查看」 with the id it already has, and repeating the action is harmless —
 *    the endpoint is idempotent, which is why an uncertain result may be retried after
 *    checking instead of being warned against.
 *  - **A stale page cannot delete an owned garment.** The delete carries
 *    `ownership: 'to_buy'`; if another device bought the item in the meantime the server
 *    answers 409 `ITEM_OWNERSHIP_CHANGED` and the row is kept, which is exactly what the
 *    screen then says.
 *  - **Deleting is bigger than the label suggests**, so the confirmation says it:
 *    the row and its image files go, and `outfit_items` cascades, so any 试搭 that used
 *    this garment loses it. Nothing else in the wardrobe is touched.
 *  - **A link is opened, never fetched.** `source_url` is handed to the system browser
 *    on an explicit tap, and only after the client re-checks that it is http/https.
 */
export default function ToBuyItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const itemId = id ?? '';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, spacing, typography, radius } = useTheme();

  const { data: item, isLoading, isError, error, refetch } = useItem(itemId || null);
  const updateItem = useUpdateItem(itemId);
  const purchaseItem = usePurchaseItem(itemId);
  // The ownership guard: this screen only ever deletes 待购 records.
  const deleteItem = useDeleteItem(itemId, TO_BUY);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [baseline, setBaseline] = useState('');

  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'purchase' | 'leave' | null>(null);
  const [purchased, setPurchased] = useState<Item | null>(null);
  const [linkNote, setLinkNote] = useState<string | null>(null);

  const isAuthFailure = error instanceof AuthError;
  const isNotFound = !isAuthFailure && error instanceof ApiError && error.status === 404;

  /** The form's fields as strings, so "changed?" is a comparison the user can predict. */
  const formSignature = useMemo(
    () => [name.trim(), type ?? '', price.trim(), url.trim(), notes.trim()].join('\u0000'),
    [name, type, price, url, notes],
  );
  const dirty = editing && formSignature !== baseline;

  const startEdit = useCallback(() => {
    if (!item) return;
    setName(item.name ?? '');
    setType(item.type);
    setPrice(normalizeStoredPrice(item.reference_price) ?? '');
    setUrl(item.source_url ?? '');
    setNotes(item.notes ?? '');
    setBaseline(
      [
        (item.name ?? '').trim(),
        item.type,
        (normalizeStoredPrice(item.reference_price) ?? '').trim(),
        (item.source_url ?? '').trim(),
        (item.notes ?? '').trim(),
      ].join('\u0000'),
    );
    setActionError(null);
    setLinkNote(null);
    setEditing(true);
  }, [item]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setActionError(null);
  }, []);

  const onSave = useCallback(async () => {
    if (!item) return;
    setActionError(null);

    const parsedPrice = parseReferencePrice(price);
    if (!parsedPrice.ok) {
      setActionError(parsedPrice.message);
      return;
    }
    const parsedUrl = parseSourceUrl(url);
    if (!parsedUrl.ok) {
      setActionError(parsedUrl.message);
      return;
    }

    // A 待购 garment is stored with a `type` (the column is NOT NULL, and an unclassified
    // garment has no slot to be trialled in), so "cleared the category" cannot be stored.
    // Refused with a sentence instead of silently saving nothing: sending `type: null` would
    // be read as "leave it alone" and the field would look broken.
    if (!type) {
      setActionError(zh.toBuy.detail.typeRequired);
      return;
    }

    // Only what changed. `type` is the load-bearing one: `ItemService.update` flips
    // `tagging_status` to `tagged` / `tagged_by` to `manual` whenever `type`, `subtype`,
    // `colors`, `primary_color` or `tags` is present, so sending an unchanged type would
    // turn a price edit into a manual classification event.
    const fields: ItemUpdateFields = {};
    if (name.trim() !== (item.name ?? '')) fields.name = name.trim();
    if (type && type !== item.type) fields.type = type;
    const storedPrice = normalizeStoredPrice(item.reference_price);
    if ((parsedPrice.value ?? null) !== storedPrice) fields.reference_price = parsedPrice.value;
    if ((parsedUrl.value ?? null) !== (item.source_url ?? null)) fields.source_url = parsedUrl.value;
    if (notes.trim() !== (item.notes ?? '')) fields.notes = notes.trim();

    if (Object.keys(fields).length === 0) {
      setEditing(false);
      return;
    }

    try {
      await updateItem.mutateAsync(fields);
      setEditing(false);
    } catch (err) {
      if (err instanceof NetworkError) {
        setActionError(err.outcomeUnknown ? zh.toBuy.detail.saveUncertain : err.message);
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        setActionError(zh.toBuy.detail.purchaseGone);
        return;
      }
      setActionError(err instanceof ApiError && err.detail ? err.detail : zh.toBuy.detail.saveFailed);
    }
  }, [item, name, type, price, url, notes, updateItem]);

  const onPurchase = useCallback(async () => {
    setActionError(null);
    try {
      const updated = await purchaseItem.mutateAsync();
      setConfirm(null);
      setPurchased(updated);
    } catch (err) {
      setConfirm(null);
      if (err instanceof NetworkError) {
        // Dispatched already; the transition is idempotent, so "check, then repeat if it
        // really is not there" is the honest advice.
        setActionError(err.outcomeUnknown ? zh.toBuy.detail.purchaseUncertain : err.message);
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        setActionError(zh.toBuy.detail.purchaseGone);
        return;
      }
      if (err instanceof ApiError && err.errorCode === 'ITEM_ARCHIVED') {
        setActionError(zh.toBuy.detail.purchaseArchived);
        return;
      }
      setActionError(
        err instanceof ApiError && err.detail ? err.detail : zh.toBuy.detail.purchaseFailed,
      );
    }
  }, [purchaseItem]);

  const onDelete = useCallback(async () => {
    setActionError(null);
    try {
      await deleteItem.mutateAsync();
      setConfirm(null);
      router.back();
    } catch (err) {
      setConfirm(null);
      if (err instanceof NetworkError) {
        setActionError(err.outcomeUnknown ? zh.toBuy.detail.deleteUncertain : err.message);
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        // Already gone: the user's intent is satisfied, so return to the list rather than
        // pretending the delete failed.
        router.back();
        return;
      }
      if (err instanceof ApiError && err.errorCode === 'ITEM_OWNERSHIP_CHANGED') {
        setActionError(zh.toBuy.detail.deleteOwnershipChanged);
        return;
      }
      setActionError(err instanceof ApiError && err.detail ? err.detail : zh.toBuy.detail.deleteFailed);
    }
  }, [deleteItem, router]);

  const openLink = useCallback(async () => {
    const target = item?.source_url ?? '';
    if (!isHttpUrl(target)) {
      setLinkNote(zh.toBuy.detail.linkInvalid);
      return;
    }
    try {
      await Linking.openURL(target);
      setLinkNote(zh.toBuy.detail.linkOpened);
    } catch {
      setLinkNote(zh.toBuy.detail.linkInvalid);
    }
  }, [item]);

  /**
   * Android's back button with unsaved edits asks first.
   *
   * Its own `'leave'` state on purpose: reusing the delete dialog here would offer to
   * permanently destroy the garment to someone who only wanted to abandon a price edit.
   */
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!dirty) return false;
      setConfirm('leave');
      return true;
    });
    return () => subscription.remove();
  }, [dirty]);

  const loadError = isAuthFailure
    ? zh.login.sessionExpired
    : error instanceof NetworkError
      ? error.message
      : isNotFound
        ? zh.toBuy.detail.notFound
        : zh.toBuy.errors.loadFailed;

  if (purchased) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          paddingTop: insets.top + spacing.lg,
          paddingHorizontal: spacing.lg,
          gap: spacing.lg,
        }}
      >
        <Stack.Screen options={{ headerShown: false }} />
        <View style={{ alignItems: 'center', gap: spacing.md, paddingTop: spacing.xl }}>
          <View style={{ padding: spacing.lg, borderRadius: 999, backgroundColor: colors.muted }}>
            <CheckCircle2 size={40} color={colors.primary} />
          </View>
          <Text style={{ ...typography.screenTitle, color: colors.foreground }}>
            {zh.toBuy.detail.purchaseDoneTitle}
          </Text>
          <Text
            style={{
              ...typography.subtitle,
              color: colors.mutedForeground,
              textAlign: 'center',
              maxWidth: 320,
            }}
          >
            {zh.toBuy.detail.purchaseDoneMessage}
          </Text>
        </View>

        <View
          style={{
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius,
            padding: spacing.md,
            flexDirection: 'row',
            gap: spacing.md,
            alignItems: 'center',
          }}
        >
          <View style={{ width: 64, height: 64, borderRadius: radius, overflow: 'hidden', backgroundColor: colors.muted }}>
            <GarmentImage item={purchased} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ ...typography.cardTitle, color: colors.foreground }}>
              {purchased.name || clothingTypeLabel(purchased.type) || zh.wardrobe.unnamedItem}
            </Text>
            <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
              {formatReferencePrice(purchased.reference_price) || zh.toBuy.card.noPrice}
            </Text>
          </View>
        </View>

        <View style={{ gap: spacing.md }}>
          <Button
            title={zh.toBuy.detail.viewInWardrobe}
            size="lg"
            onPress={() => router.replace(`/item/${purchased.id}`)}
          />
          <Button
            title={zh.toBuy.detail.backToList}
            variant="outline"
            onPress={() => router.back()}
          />
        </View>
      </View>
    );
  }

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
              {zh.toBuy.title}
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
              <Button title={zh.common.retry} variant="outline" size="sm" onPress={() => void refetch()} />
            ) : null}
          </View>
        ) : item ? (
          <>
            <Text style={{ ...typography.screenTitle, color: colors.foreground }}>
              {editing ? zh.toBuy.detail.edit : item.name || clothingTypeLabel(item.type) || zh.wardrobe.unnamedItem}
            </Text>
            <Text
              style={{ ...typography.caption, color: colors.mutedForeground }}
              accessibilityLabel={zh.toBuy.detail.title}
            >
              {zh.toBuy.badge} · {zh.toBuy.detail.type} {clothingTypeLabel(item.type) || zh.itemDetail.none}
            </Text>

            <View
              style={{
                width: '100%',
                aspectRatio: 1,
                borderRadius: radius,
                overflow: 'hidden',
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.muted,
              }}
            >
              <Image
                source={{
                  uri: joinUrl(apiBaseUrl, item.thumbnail_url) ?? joinUrl(apiBaseUrl, item.image_url) ?? undefined,
                }}
                style={{ width: '100%', height: '100%' }}
                resizeMode="cover"
              />
            </View>

            {/* Archival state: the purchase button is refused server-side, so say why. */}
            {item.is_archived ? (
              <InlineNotice tone="neutral" message={zh.toBuy.detail.archived} />
            ) : null}

            {editing ? (
              <View style={{ gap: spacing.md }}>
                <LabeledInput
                  label={zh.addItem.nameLabel}
                  value={name}
                  onChangeText={setName}
                  placeholder={zh.addItem.namePlaceholder}
                  maxLength={100}
                  editable={!updateItem.isPending}
                />
                <TypeSelect
                  value={type}
                  onChange={setType}
                  label={zh.addItem.typeLabel}
                />
                <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
                  {zh.toBuy.detail.editHint}
                </Text>
                <LabeledInput
                  label={zh.toBuy.form.referenceLabel}
                  value={price}
                  onChangeText={setPrice}
                  placeholder={zh.toBuy.form.referencePlaceholder}
                  editable={!updateItem.isPending}
                />
                <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
                  {zh.toBuy.form.referenceHint}
                </Text>
                <LabeledInput
                  label={zh.toBuy.form.sourceUrlLabel}
                  value={url}
                  onChangeText={setUrl}
                  placeholder={zh.toBuy.form.sourceUrlPlaceholder}
                  editable={!updateItem.isPending}
                />
                <LabeledInput
                  label={zh.addItem.notesLabel}
                  value={notes}
                  onChangeText={setNotes}
                  placeholder={zh.addItem.notesPlaceholder}
                  multiline
                  editable={!updateItem.isPending}
                />
              </View>
            ) : (
              <View style={{ gap: spacing.sm }}>
                <DetailRow label={zh.toBuy.detail.referencePrice} value={formatReferencePrice(item.reference_price) || zh.toBuy.card.noPrice} />
                <DetailRow
                  label={zh.toBuy.detail.sourceUrl}
                  value={item.source_url ? sourceUrlHost(item.source_url) : zh.itemDetail.none}
                />
                {item.source_url ? (
                  <Pressable onPress={() => void openLink()} accessibilityRole="button" hitSlop={6}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
                      <ExternalLink size={14} color={colors.primary} />
                      <Text style={{ ...typography.caption, color: colors.primary }}>
                        {zh.toBuy.detail.openLink}
                      </Text>
                    </View>
                  </Pressable>
                ) : null}
                <DetailRow label={zh.toBuy.detail.brand} value={item.brand || zh.itemDetail.none} />
                <DetailRow
                  label={zh.toBuy.detail.colors}
                  value={
                    item.colors && item.colors.length > 0
                      ? item.colors.map((color) => colorLabel(color)).join('、')
                      : zh.itemDetail.none
                  }
                />
                <DetailRow label={zh.toBuy.detail.notes} value={item.notes || zh.itemDetail.none} />
              </View>
            )}

            {linkNote ? <InlineNotice tone="neutral" message={linkNote} /> : null}

            {actionError ? <InlineNotice message={actionError} /> : null}

            {editing ? (
              <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
                <Button
                  title={updateItem.isPending ? zh.toBuy.detail.saving : zh.toBuy.detail.save}
                  loading={updateItem.isPending}
                  disabled={!dirty}
                  onPress={onSave}
                />
                <Button title={zh.toBuy.detail.cancel} variant="outline" onPress={cancelEdit} />
              </View>
            ) : (
              <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
                <View style={{ gap: spacing.xs }}>
                  <Button
                    title={zh.toBuy.detail.trial}
                    onPress={() => router.push(`/(tabs)/outfits?trialItemId=${encodeURIComponent(item.id)}`)}
                  />
                  <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
                    {zh.toBuy.detail.trialHint}
                  </Text>
                </View>

                <View style={{ gap: spacing.xs }}>
                  <Button
                    title={
                      purchaseItem.isPending ? zh.toBuy.detail.saving : zh.toBuy.detail.purchase
                    }
                    loading={purchaseItem.isPending}
                    disabled={item.is_archived}
                    onPress={() => setConfirm('purchase')}
                  />
                  <Text style={{ ...typography.caption, color: colors.mutedForeground }}>
                    {zh.toBuy.detail.purchaseHint}
                  </Text>
                </View>

                <Button
                  title={zh.toBuy.detail.edit}
                  variant="outline"
                  icon={<Pencil size={16} color={colors.foreground} />}
                  onPress={startEdit}
                />
                <Button
                  title={zh.toBuy.detail.delete}
                  variant="destructive"
                  onPress={() => setConfirm('delete')}
                />
              </View>
            )}
          </>
        ) : null}
      </ScrollView>

      <ConfirmDialog
        visible={confirm === 'purchase'}
        title={zh.toBuy.detail.purchaseTitle}
        message={zh.toBuy.detail.purchaseMessage}
        confirmLabel={zh.toBuy.detail.purchaseConfirm}
        cancelLabel={zh.toBuy.detail.cancel}
        onConfirm={onPurchase}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        visible={confirm === 'delete'}
        title={zh.toBuy.detail.deleteTitle}
        message={zh.toBuy.detail.deleteMessage}
        confirmLabel={zh.toBuy.detail.deleteConfirm}
        cancelLabel={zh.toBuy.detail.cancel}
        destructive
        onConfirm={onDelete}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        visible={confirm === 'leave'}
        title={zh.toBuy.detail.leaveTitle}
        message={zh.toBuy.detail.leaveMessage}
        confirmLabel={zh.toBuy.detail.leaveConfirm}
        cancelLabel={zh.toBuy.detail.keepEditing}
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

function DetailRow({ label, value }: { label: string; value: string }) {
  const { colors, typography } = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <Text style={{ ...typography.caption, color: colors.mutedForeground, width: 76 }}>{label}</Text>
      <Text style={{ ...typography.caption, color: colors.foreground, flex: 1 }}>{value}</Text>
    </View>
  );
}
