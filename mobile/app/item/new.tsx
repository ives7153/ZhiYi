import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { ArrowLeft, Camera, CheckCircle2, ImagePlus, Loader2, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, NetworkError } from '../../src/api/errors';
import { useCreateItem } from '../../src/api/itemMutations';
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

export default function AddItemScreen() {
  const { colors, spacing, typography, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const createItem = useCreateItem();
  const capabilities = useCapabilities();

  const [photo, setPhoto] = useState<UploadablePhoto | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<string | null>(null);
  const [brand, setBrand] = useState('');
  const [colors_, setColors] = useState<string[]>([]);
  const [notes, setNotes] = useState('');

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
      setFailure(zh.addItem.errors.pickFailed);
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;

    setFailure(null);
    setIsDuplicate(false);
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
          // `skip_ai` is left false: if the server has vision enabled it should
          // tag the garment. When it is disabled the server returns the item
          // ready anyway, so this single code path covers both configurations.
          skip_ai: false,
        },
      });

      // The server decided whether tagging is running; mirror its answer.
      setSaved(item);
      setPhase(item.status === 'processing' ? 'analyzing' : 'saved');
    } catch (error) {
      setPhase('error');
      if (error instanceof ApiError && error.status === 409) {
        setIsDuplicate(true);
        setFailure(zh.addItem.errors.duplicate);
      } else if (error instanceof NetworkError) {
        setFailure(zh.addItem.errors.uploadFailed);
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
  }, [photo, type, name, brand, colors_, notes, createItem]);

  /** Clears the form for another garment after a successful add. */
  const onAddAnother = useCallback(() => {
    setSaved(null);
    setPhoto(null);
    setName('');
    setType(null);
    setBrand('');
    setColors([]);
    setNotes('');
    setFailure(null);
    setIsDuplicate(false);
    setPhase('idle');
  }, []);

  const aiVisionEnabled = capabilities.data?.ai.vision === true;
  const notice =
    failure != null ? (
      <InlineNotice
        // A duplicate is informational, not an error: the garment already exists
        // and nothing needs retrying, so it must not wear error styling.
        tone={isDuplicate ? 'neutral' : 'destructive'}
        title={isDuplicate ? zh.addItem.errors.duplicateTitle : undefined}
        message={failure}
      />
    ) : null;

  if (saved) {
    return (
      <SuccessPanel
        item={saved}
        phase={phase}
        aiVisionEnabled={aiVisionEnabled}
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
              {zh.addItem.title}
            </Text>
            <Text style={{ ...typography.subtitle, color: colors.mutedForeground, marginTop: 2 }}>
              {zh.addItem.subtitle}
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
                  ? zh.addItem.uploadingPhoto
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
  onAddAnother,
}: {
  item: Item;
  phase: Phase;
  aiVisionEnabled: boolean;
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
          {zh.addItem.savedTitle}
        </Text>
        <Text
          style={{
            ...typography.subtitle,
            color: colors.mutedForeground,
            textAlign: 'center',
            maxWidth: 320,
          }}
        >
          {isAnalyzing ? zh.addItem.savedAnalyzing : zh.addItem.savedReady}
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
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 14, fontWeight: '500' }}>
            {item.name || item.type}
          </Text>
        </View>
      </View>

      <View style={{ gap: spacing.md }}>
        <Button title={zh.addItem.viewItem} size="lg" onPress={() => router.replace(`/item/${item.id}`)} />
        <Button title={zh.addItem.goToWardrobe} variant="outline" onPress={() => router.replace('/(tabs)')} />
        <Button title={zh.addItem.submit} variant="ghost" onPress={onAddAnother} />
      </View>
    </View>
  );
}
