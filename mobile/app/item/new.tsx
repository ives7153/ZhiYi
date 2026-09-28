import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Camera, CheckCircle2, ImagePlus, Loader2, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, NetworkError } from '../../src/api/errors';
import { useCreateItem } from '../../src/api/itemMutations';
import { clothingTypeLabel } from '../../src/api/itemVocab';
import {
  TO_BUY,
  isToBuy,
  parseReferencePrice,
  parseSourceUrl,
} from '../../src/api/toBuy';
import { useCapabilities } from '../../src/api/hooks';
import type { Item, UploadablePhoto } from '../../src/api/types';
import { joinUrl } from '../../src/api/url';
import { apiBaseUrl } from '../../src/config/env';
import { Button } from '../../src/components/ui';
import {
  ColorSelect,
  InlineNotice,
  LabeledInput,
  TypeSelect,
} from '../../src/components/form';
import { captureWithCamera, pickFromLibrary, recoverPendingPick } from '../../src/media/photoPicker';
import { useTheme } from '../../src/theme/ThemeContext';
import { zh } from '../../src/i18n/zh';

/**
 * 添加单品 — the round-2 add flow.
 *
 * ---------------------------------------------------------------------------
 * The states this screen distinguishes (spec item 4)
 * ---------------------------------------------------------------------------
 * The spec requires the *file upload* to be visibly separate from the *AI
 * tagging*, because they fail differently and mean different things to the user:
 *
 *   idle          chose nothing yet
 *   preparing     the picker returned; the photo is being resized/re-encoded
 *   uploading     bytes are in flight (`uploadingPhoto`)
 *   analyzing     the server accepted the file; AI tagging is queued
 *   saved         the server returned an item with an id
 *   error         with the form fully intact for a retry
 *
 * Work out which of `saved`/`analyzing` applies from the **server's** returned
 * item, not from a client guess: `status === 'processing'` means a tagging job is
 * queued, anything else means the item is already usable. When internal AI is off
 * the server marks the item ready immediately, so the client must not promise an
 * analysis that will never happen.
 *
 * ---------------------------------------------------------------------------
 * Duplicate protection (spec item 7)
 * ---------------------------------------------------------------------------
 * Two independent guards:
 *  1. `createItem.isPending` disables the button, so a double tap cannot fire two
 *     requests. The `submittingRef` latch closes the remaining window where a tap
 *     lands in the same frame as the state update.
 *  2. A duplicate photo is rejected by the server with **409**, which is not an
 *     error to retry — the garment already exists. It is reported as such and the
 *     form is left clean rather than looking failed.
 */

type Phase = 'idle' | 'preparing' | 'uploading' | 'analyzing' | 'saved' | 'error';

/** Where a duplicate photo turned out to live, when the server answers 409. */
interface DuplicateTarget {
  itemId: string;
  ownership: string;
  name: string | null;
}

export default function AddItemScreen() {
  const { colors, spacing, typography, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  /**
   * `?mode=toBuy` turns this same screen into 加入待购 (round 4).
   *
   * The route is shared on purpose: the photo capture, the resize/re-encode, the
   * multipart upload, the permission and pending-pick recovery, the duplicate handling
   * and the 「结果不确定」 wording are the round-2 code paths, and a second screen would
   * have been a second copy of them — exactly the "两套图片/衣物系统" the round-4 spec
   * forbids. What differs is three strings, two optional fields and the `ownership`
   * value sent with the upload.
   */
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const isToBuyMode = mode === 'toBuy';

  const createItem = useCreateItem();
  const capabilities = useCapabilities();

  const [photo, setPhoto] = useState<UploadablePhoto | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<string | null>(null);
  const [brand, setBrand] = useState('');
  const [colors_, setColors] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  /** 待购-only fields (round 4). Both optional; the server validates them again. */
  const [referencePrice, setReferencePrice] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  /** Where the 409 duplicate points, so the panel can offer to open it. */
  const [duplicateTarget, setDuplicateTarget] = useState<DuplicateTarget | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  /** Which failure to render, if any. */
  const [failure, setFailure] = useState<string | null>(null);
  /** Set when the failure was a duplicate, so the copy can differ from an error. */
  const [isDuplicate, setIsDuplicate] = useState(false);
  /** The item the server created, for the success panel. */
  const [saved, setSaved] = useState<Item | null>(null);

  /** Re-entrancy latch: set synchronously, so a same-frame double tap is ignored. */
  const submittingRef = useRef(false);

  const isBusy = phase === 'preparing' || phase === 'uploading' || phase === 'analyzing';

  /**
   * Recovers a pick that Android dropped while the app was backgrounded.
   *
   * Android may destroy `MainActivity` to reclaim memory while the system picker
   * is in front; the chosen file then survives only inside expo-image-picker's
   * pending store. Without this, the user would return to an empty form and have
   * to pick again, with no explanation.
   */
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const recovered = await recoverPendingPick();
      if (!cancelled && recovered) setPhoto(recovered);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyPick = useCallback(async (run: () => Promise<Awaited<ReturnType<typeof pickFromLibrary>>>) => {
    setFailure(null);
    setIsDuplicate(false);
    setPhase('preparing');
    const result = await run();

    if (!result.ok) {
      setPhase('idle');
      const f = result.failure;
      // A cancelled picker is a normal user action, not an error: say nothing.
      if (f.kind === 'cancelled') return;
      if (f.kind === 'permission') {
        setFailure(
          f.source === 'library'
            ? f.canAskAgain
              ? zh.addItem.errors.permissionLibrary
              : zh.addItem.errors.permissionLibraryBlocked
            : f.canAskAgain
              ? zh.addItem.errors.permissionCamera
              : zh.addItem.errors.permissionCameraBlocked,
        );
        return;
      }
      if (f.kind === 'unsupported') {
        setFailure(f.message);
        return;
      }
      setFailure(f.message);
      return;
    }

    setPhoto(result.photo);
    setPhase('idle');
  }, []);

  const onPickLibrary = useCallback(() => {
    if (isBusy) return;
    void applyPick(pickFromLibrary);
  }, [applyPick, isBusy]);

  const onTakePhoto = useCallback(() => {
    if (isBusy) return;
    void applyPick(captureWithCamera);
  }, [applyPick, isBusy]);

  const onRemovePhoto = useCallback(() => {
    if (isBusy) return;
    setPhoto(null);
  }, [isBusy]);

  /**
   * Submits the garment.
   *
   * On failure nothing is reset except the phase: the photo and every typed field
   * stay exactly as they were, which is what makes the rendered promise
   * ("已保留，可以直接重试") true rather than aspirational.
   */
  const onSubmit = useCallback(async () => {
    if (!photo) {
      setFailure(isToBuyMode ? zh.toBuy.form.photoRequired : zh.addItem.errors.pickFailed);
      return;
    }

    // 待购 fields are checked here so a typo produces a Chinese sentence next to the
    // field instead of a 422 round trip. The rules are the server's own (see
    // `src/api/toBuy.ts`), and the server still validates whatever is sent.
    let referenceValue: string | undefined;
    let sourceValue: string | undefined;
    if (isToBuyMode) {
      const price = parseReferencePrice(referencePrice);
      if (!price.ok) {
        setFailure(price.message);
        return;
      }
      const link = parseSourceUrl(sourceUrl);
      if (!link.ok) {
        setFailure(link.message);
        return;
      }
      referenceValue = price.value ?? undefined;
      sourceValue = link.value ?? undefined;
    }

    if (submittingRef.current) return;
    submittingRef.current = true;

    setFailure(null);
    setIsDuplicate(false);
    setDuplicateTarget(null);
    setPhase('uploading');

    try {
      const item = await createItem.mutateAsync({
        photo,
        fields: {
          type: type ?? undefined,
          name: name.trim() || undefined,
          brand: brand.trim() || undefined,
          colors: colors_.length > 0 ? colors_.join(',') : undefined,
          primary_color: colors_[0],
          notes: notes.trim() || undefined,
          // Which side the garment lands on. Omitted for the wardrobe, so this branch
          // keeps posting exactly the fields it did before round 4.
          ...(isToBuyMode ? { ownership: TO_BUY } : {}),
          reference_price: referenceValue,
          source_url: sourceValue,
          /**
           * AI tagging, and why 待购 differs:
           *
           *  - wardrobe (round 2): always false — if the server has vision enabled it
           *    should classify the garment, and when it is off the server marks the item
           *    ready anyway.
           *  - 待购: a category the user picked is honoured and tagging is skipped, so the
           *    garment is `ready` and can be trialled immediately (with AI on, a
           *    `processing` item cannot enter an outfit at all — `validate_item_ownership`
           *    requires `ready`). With no category chosen the item is stored as
           *    待分类/待完善 and tagging is left to the server.
           */
          skip_ai: isToBuyMode ? Boolean(type) : false,
        },
      });

      // The server decided whether tagging is running; mirror its answer.
      setSaved(item);
      setPhase(item.status === 'processing' ? 'analyzing' : 'saved');
    } catch (error) {
      setPhase('error');
      if (error instanceof ApiError && error.status === 409) {
        // The photo already exists **on this account**, and the server says which side
        // it found (`detail.existing_ownership`) plus that row's id. Nothing was
        // created and nothing was moved: the panel names the side and offers to open
        // the existing record, which is the only honest way to "retry" a duplicate.
        const target = duplicateTargetOf(error);
        setIsDuplicate(true);
        setDuplicateTarget(target);
        if (isToBuyMode) {
          setFailure(
            target && isToBuy(target)
              ? zh.toBuy.form.duplicateInToBuy
              : zh.toBuy.form.duplicateOwned,
          );
        } else {
          setFailure(
            target && isToBuy(target)
              ? zh.toBuy.form.duplicateInToBuy
              : zh.addItem.errors.duplicate,
          );
        }
      } else if (error instanceof NetworkError) {
        // The photo and the form stay mounted on every failure path here, so the "已保留"
        // promise in `inputKept` is backed by behaviour. What differs between these two
        // sentences is the claim about the server: an upload that was dispatched and whose
        // reply was lost may have been stored, so it is reported as unconfirmed rather than
        // failed (`NetworkError.outcomeUnknown`).
        setFailure(
          error.outcomeUnknown
            ? isToBuyMode
              ? zh.toBuy.form.uploadUncertain
              : zh.addItem.errors.uploadUncertain
            : zh.addItem.errors.uploadFailed,
        );
      } else if (error instanceof ApiError) {
        // Prefer the server's own wording: it distinguishes "not an image" from
        // "too large" from "unsupported format", which generic copy cannot.
        setFailure(error.detail ?? zh.addItem.errors.saveFailed);
      } else {
        setFailure(zh.addItem.errors.saveFailed);
      }

      // The raw cause stays out of the UI (it is English plumbing text the user
      // cannot act on) but is surfaced in the device log: in a release build there
      // is otherwise no way to tell an unreachable backend from a malformed
      // multipart body.
      console.warn('[add-item] upload failed:', error);
    } finally {
      submittingRef.current = false;
    }
  }, [photo, type, name, brand, colors_, notes, referencePrice, sourceUrl, isToBuyMode, createItem]);

  /** Clears the form for another garment after a successful add. */
  const onAddAnother = useCallback(() => {
    setSaved(null);
    setPhoto(null);
    setName('');
    setType(null);
    setBrand('');
    setColors([]);
    setNotes('');
    setReferencePrice('');
    setSourceUrl('');
    setFailure(null);
    setIsDuplicate(false);
    setDuplicateTarget(null);
    setPhase('idle');
  }, []);

  const aiVisionEnabled = capabilities.data?.ai.vision === true;
  const notice =
    failure != null ? (
      <InlineNotice
        // A duplicate is informational, not an error: the garment already exists
        // and nothing needs retrying, so it must not wear error styling.
        tone={isDuplicate ? 'neutral' : 'destructive'}
        title={
          isDuplicate
            ? isToBuyMode
              ? zh.toBuy.form.duplicateTitle
              : zh.addItem.errors.duplicateTitle
            : undefined
        }
        message={failure}
        action={
          isDuplicate && duplicateTarget ? (
            <Button
              title={zh.toBuy.form.duplicateOpen}
              variant="outline"
              size="sm"
              onPress={() =>
                router.push(
                  isToBuy(duplicateTarget)
                    ? `/to-buy/${duplicateTarget.itemId}`
                    : `/item/${duplicateTarget.itemId}`,
                )
              }
            />
          ) : undefined
        }
      />
    ) : null;

  if (saved) {
    return (
      <SuccessPanel
        item={saved}
        phase={phase}
        aiVisionEnabled={aiVisionEnabled}
        toBuyMode={isToBuyMode}
        onAddAnother={onAddAnother}
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + spacing.md,
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.xxl * 2,
          gap: spacing.lg,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Button
            title=""
            variant="ghost"
            icon={<ArrowLeft size={20} color={colors.foreground} />}
            onPress={() => router.back()}
          />
          <View style={{ flex: 1 }}>
            <Text style={{ ...typography.screenTitle, color: colors.foreground }}>
              {isToBuyMode ? zh.toBuy.form.title : zh.addItem.title}
            </Text>
            <Text style={{ ...typography.subtitle, color: colors.mutedForeground, marginTop: 2 }}>
              {isToBuyMode ? zh.toBuy.form.subtitle : zh.addItem.subtitle}
            </Text>
          </View>
        </View>

        {/* ---------- photo ---------- */}
        <View style={{ gap: spacing.md }}>
          <PhotoWell photo={photo} onRemove={onRemovePhoto} disabled={isBusy} />

          {photo ? (
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <View style={{ flex: 1 }}>
                <Button
                  title={zh.addItem.changePhoto}
                  variant="outline"
                  size="sm"
                  disabled={isBusy}
                  onPress={onPickLibrary}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  title={zh.addItem.removePhoto}
                  variant="outline"
                  size="sm"
                  disabled={isBusy}
                  onPress={onRemovePhoto}
                />
              </View>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <View style={{ flex: 1 }}>
                <Button
                  title={zh.addItem.pickFromLibrary}
                  icon={<ImagePlus size={16} color={colors.primaryForeground} />}
                  disabled={isBusy}
                  onPress={onPickLibrary}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  title={zh.addItem.takePhoto}
                  variant="outline"
                  icon={<Camera size={16} color={colors.foreground} />}
                  disabled={isBusy}
                  onPress={onTakePhoto}
                />
              </View>
            </View>
          )}
        </View>

        {notice}

        {/* ---------- details ---------- */}
        <View style={{ gap: spacing.sm }}>
          <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: '600' }}>
            {zh.addItem.detailsTitle}
          </Text>
          <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
            {zh.addItem.detailsHint}
          </Text>
        </View>

        <LabeledInput
          label={zh.addItem.nameLabel}
          value={name}
          onChangeText={setName}
          placeholder={zh.addItem.namePlaceholder}
          editable={!isBusy}
          // Matches `ItemBase.name` max_length=100 on the server. Enforced here so
          // a long paste cannot produce a 422 that looks like a server fault.
          maxLength={100}
        />

        <TypeSelect value={type} onChange={setType} />

        <ColorSelect values={colors_} onChange={setColors} />

        <LabeledInput
          label={zh.addItem.brandLabel}
          value={brand}
          onChangeText={setBrand}
          placeholder={zh.addItem.brandPlaceholder}
          editable={!isBusy}
          maxLength={100}
        />

        {/* 待购-only fields. Both optional; leaving them empty stores NULL, not 0. */}
        {isToBuyMode ? (
          <>
            <LabeledInput
              label={zh.toBuy.form.referenceLabel}
              value={referencePrice}
              onChangeText={setReferencePrice}
              placeholder={zh.toBuy.form.referencePlaceholder}
              editable={!isBusy}
            />
            <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
              {zh.toBuy.form.referenceHint}
            </Text>

            <LabeledInput
              label={zh.toBuy.form.sourceUrlLabel}
              value={sourceUrl}
              onChangeText={setSourceUrl}
              placeholder={zh.toBuy.form.sourceUrlPlaceholder}
              editable={!isBusy}
            />
            <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
              {zh.toBuy.form.sourceUrlHint}
            </Text>
          </>
        ) : null}

        <LabeledInput
          label={zh.addItem.notesLabel}
          value={notes}
          onChangeText={setNotes}
          placeholder={zh.addItem.notesPlaceholder}
          editable={!isBusy}
          multiline
        />

        {/* ---------- submit ---------- */}
        {isBusy ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <ActivityIndicator size="small" color={colors.mutedForeground} />
            <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
              {phase === 'preparing'
                ? zh.addItem.submitting
                : phase === 'uploading'
                  ? isToBuyMode
                    ? zh.toBuy.form.submitting
                    : zh.addItem.uploadingPhoto
                  : zh.addItem.analyzing}
            </Text>
          </View>
        ) : null}

        {phase === 'error' && !isDuplicate ? (
          <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>{zh.addItem.inputKept}</Text>
        ) : null}

        <Button
          title={
            isDuplicate
              ? zh.addItem.keepEditing
              : phase === 'error'
                ? zh.addItem.retryUpload
                : isToBuyMode
                  ? zh.toBuy.form.submit
                  : zh.addItem.submit
          }
          size="lg"
          loading={isBusy}
          disabled={!photo || isBusy}
          onPress={() => void onSubmit()}
        />
      </ScrollView>
    </View>
  );
}

/**
 * Reads the existing row out of a 409 duplicate answer.
 *
 * The server sends `detail.existing_item_id` and `detail.existing_ownership` for exactly
 * this purpose; when an older backend (or a proxy) answers with a plain string instead,
 * this returns `null` and the panel simply shows the message without the button.
 */
function duplicateTargetOf(error: ApiError): DuplicateTarget | null {
  const body = error.body;
  if (!body || typeof body !== 'object') return null;
  const detail = (body as Record<string, unknown>).detail;
  if (!detail || typeof detail !== 'object') return null;
  const record = detail as Record<string, unknown>;
  const itemId = record.existing_item_id;
  if (typeof itemId !== 'string' || !itemId) return null;
  return {
    itemId,
    ownership: typeof record.existing_ownership === 'string' ? record.existing_ownership : 'owned',
    name: typeof record.existing_name === 'string' ? record.existing_name : null,
  };
}

/**
 * The photo slot. Shows the local pick (already re-encoded and safe to display),
 * or a dashed prompt when nothing is chosen.
 */
function PhotoWell({
  photo,
  onRemove,
  disabled,
}: {
  photo: UploadablePhoto | null;
  onRemove: () => void;
  disabled: boolean;
}) {
  const { colors, radius, spacing } = useTheme();

  return (
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
      {photo ? (
        <>
          <Image source={{ uri: photo.uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
          <Pressable
            onPress={onRemove}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={zh.addItem.removePhoto}
            style={{
              position: 'absolute',
              top: spacing.sm,
              right: spacing.sm,
              backgroundColor: 'rgba(0,0,0,0.55)',
              borderRadius: 999,
              padding: 6,
            }}
          >
            <X size={16} color="#FFFFFF" />
          </Pressable>
        </>
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm }}>
          <ImagePlus size={32} color={colors.mutedForeground} />
          <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>{zh.addItem.noPhotoYet}</Text>
        </View>
      )}
    </View>
  );
}

/**
 * Post-add panel.
 *
 * Distinguishes the two honest outcomes:
 *  - the file is stored and the garment is already usable (AI off, or nothing to
 *    tag) — say so, and offer to go straight to the wardrobe;
 *  - AI tagging is genuinely queued — say that it is running in the background,
 *    and do not pretend the category is known yet.
 *
 * `aiVisionEnabled` is only used to avoid claiming a background analysis when the
 * client already knows the server has none configured.
 */
function SuccessPanel({
  item,
  phase,
  aiVisionEnabled,
  toBuyMode,
  onAddAnother,
}: {
  item: Item;
  phase: Phase;
  aiVisionEnabled: boolean;
  /** `?mode=toBuy`: the panel talks about 待购 and offers the 待购 detail route. */
  toBuyMode: boolean;
  onAddAnother: () => void;
}) {
  const { colors, spacing, typography, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const isAnalyzing = phase === 'analyzing' || item.status === 'processing';

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
        <View
          style={{
            padding: spacing.lg,
            borderRadius: 999,
            backgroundColor: colors.muted,
          }}
        >
          {isAnalyzing ? (
            <Loader2 size={40} color={colors.mutedForeground} />
          ) : (
            <CheckCircle2 size={40} color={colors.primary} />
          )}
        </View>
        <Text style={{ ...typography.screenTitle, color: colors.foreground }}>
          {toBuyMode ? zh.toBuy.form.savedTitle : zh.addItem.savedTitle}
        </Text>
        <Text
          style={{
            ...typography.subtitle,
            color: colors.mutedForeground,
            textAlign: 'center',
            maxWidth: 320,
          }}
        >
          {isAnalyzing
            ? zh.addItem.savedAnalyzing
            : toBuyMode
              ? zh.toBuy.form.savedReady
              : zh.addItem.savedReady}
        </Text>
        {isAnalyzing && aiVisionEnabled ? (
          <Text style={{ color: colors.mutedForeground, fontSize: 12, textAlign: 'center' }}>
            {zh.addItem.savedAnalyzingHint}
          </Text>
        ) : null}
      </View>

      <View
        style={{
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius,
          overflow: 'hidden',
          flexDirection: 'row',
          gap: spacing.md,
          padding: spacing.md,
          alignItems: 'center',
        }}
      >
        <View style={{ width: 64, height: 64, borderRadius: radius, overflow: 'hidden', backgroundColor: colors.muted }}>
          <Image
            // `image_url` is a RELATIVE signed path; it must be joined with the API
            // base before it can be loaded. Thumbnail first, matching the list.
            source={{
              uri:
                joinUrl(apiBaseUrl, item.thumbnail_url) ??
                joinUrl(apiBaseUrl, item.image_url) ??
                undefined,
            }}
            style={{ width: '100%', height: '100%' }}
          />
        </View>
        <View style={{ flex: 1 }}>
          {/* Same fallback as ItemCard. `item.type` is a backend enum
              (`unknown`, `shirt`, …); the unnamed-add path used to print it raw. */}
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 14, fontWeight: '500' }}>
            {item.name || clothingTypeLabel(item.type) || zh.wardrobe.unnamedItem}
          </Text>
          {toBuyMode ? (
            <Text numberOfLines={1} style={{ color: colors.mutedForeground, fontSize: 12 }}>
              {zh.toBuy.badge}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={{ gap: spacing.md }}>
        <Button
          title={toBuyMode ? zh.toBuy.form.viewItem : zh.addItem.viewItem}
          size="lg"
          onPress={() => router.replace(toBuyMode ? `/to-buy/${item.id}` : `/item/${item.id}`)}
        />
        <Button
          title={toBuyMode ? zh.toBuy.form.goToList : zh.addItem.goToWardrobe}
          variant="outline"
          onPress={() => router.replace(toBuyMode ? '/(tabs)/to-buy' : '/(tabs)')}
        />
        <Button
          title={toBuyMode ? zh.toBuy.form.addAnother : zh.addItem.submit}
          variant="ghost"
          onPress={onAddAnother}
        />
      </View>
    </View>
  );
}
