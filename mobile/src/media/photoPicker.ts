import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import {
  ALLOWED_UPLOAD_MIME_TYPES,
  UPLOAD_JPEG_QUALITY,
  UPLOAD_MAX_EDGE_PX,
} from '../config/env';
import type { UploadablePhoto } from '../api/types';
import { zh } from '../i18n/zh';

/**
 * Photo acquisition: pick from the gallery or shoot with the camera, then
 * normalize the result into something the backend will accept.
 *
 * ---------------------------------------------------------------------------
 * Why every picked photo is re-encoded before upload
 * ---------------------------------------------------------------------------
 * The backend applies `ImageOps.exif_transpose` while processing an upload
 * (`image_service.process_and_store`), so the stored pixels end up upright
 * whichever way the orientation was expressed. Orientation correctness therefore
 * does NOT depend on this re-encode, and an earlier version of this comment
 * overstated the case — see the note below. The re-encode is here for three
 * reasons that each hold on their own:
 *
 *  1. **Orientation stops depending on `quality`.** The picker has three
 *     exporters and they differ in whether the pixels are already rotated:
 *     `quality: 1` uses `RawImageExporter`, which copies the source bytes
 *     verbatim — pixels NOT rotated, orientation tag kept, so the backend's
 *     transpose is what makes it upright. Any `quality < 1` uses
 *     `CompressionImageExporter`, which decodes through Glide (rotating the
 *     pixels) and then calls `copyExifData`, which *excludes*
 *     `ExifInterface.TAG_ORIENTATION` — pixels rotated, no tag, so the backend's
 *     transpose is a no-op. Those two are complementary and both happen to work,
 *     but the correctness rests on an implicit contract in someone else's code.
 *     Re-encoding makes this file's own output unambiguous.
 *
 *  2. **The two hard server-side limits are met.** `validate_image` rejects
 *     anything over 20MB and `_open_bounded` rejects anything over
 *     `max_image_megapixels` (50MP). A modern phone photo can exceed either.
 *
 *  3. **The uploaded bytes are EXIF-clean by construction.**
 *     expo-image-manipulator's Android decoder never reads EXIF (there is no
 *     `ExifInterface` reference anywhere in the module) and `Bitmap.compress`
 *     writes none, so nothing downstream has to reason about a stale tag.
 *
 * Verified against the picker's own Kotlin (`exporters/*.kt`,
 * `ImagePickerUtils.kt:202-228`) and by running each path through the real
 * backend pipeline: `mobile/docs/第二轮-图片选择与上传调研.md` §3, and
 * `scripts/verify/exif-roundtrip.py` for the pipeline itself.
 */

/** What the caller has to do about a refused pick, so the UI can say it plainly. */
export type PhotoPickFailure =
  | { kind: 'cancelled' }
  | { kind: 'permission'; source: 'library' | 'camera'; canAskAgain: boolean }
  | { kind: 'unsupported'; message: string }
  | { kind: 'failed'; message: string };

export type PhotoPickResult =
  | { ok: true; photo: UploadablePhoto }
  | { ok: false; failure: PhotoPickFailure };

/**
 * Filename extension and MIME type used for every uploaded photo.
 *
 * The server validates the *extension* of the uploaded filename
 * (`ALLOWED_EXTENSIONS` in `backend/app/services/image_service.py`) independently
 * of the declared MIME type, so the two have to agree or the upload is a 400.
 * Everything is re-encoded to JPEG, so these are two constants rather than a
 * lookup table with a single entry.
 */
const JPEG_EXTENSION = 'jpg';
const JPEG_MIME_TYPE = 'image/jpeg';

/**
 * Normalizes a picked asset into an uploadable JPEG.
 *
 * `asset.width`/`asset.height` are typed as `number` but documented as possibly
 * `0` ("the system did not provide the width"), so the resize is only requested
 * when a real dimension is known. Everything else — quality, format, EXIF
 * removal — still applies in that case, since `saveAsync` re-encodes regardless.
 */
export async function preparePhoto(
  asset: ImagePicker.ImagePickerAsset,
): Promise<PhotoPickResult> {
  try {
    const context = ImageManipulator.manipulate(asset.uri);

    const width = asset.width;
    const height = asset.height;
    if (width > 0 && height > 0 && Math.max(width, height) > UPLOAD_MAX_EDGE_PX) {
      // Giving only the long edge keeps the aspect ratio: the manipulator
      // computes the other dimension itself.
      if (width >= height) context.resize({ width: UPLOAD_MAX_EDGE_PX });
      else context.resize({ height: UPLOAD_MAX_EDGE_PX });
    }

    const image = await context.renderAsync();
    const saved = await image.saveAsync({
      compress: UPLOAD_JPEG_QUALITY,
      format: SaveFormat.JPEG,
    });

    return {
      ok: true,
      photo: {
        uri: saved.uri,
        name: `wardrobe-${Date.now()}.${JPEG_EXTENSION}`,
        type: JPEG_MIME_TYPE,
      },
    };
  } catch {
    return {
      ok: false,
      failure: { kind: 'failed', message: zh.addItem.errors.prepareFailed },
    };
  }
}

/**
 * Guards the declared MIME type against the server's allow-list.
 *
 * The picker's `mimeType` is optional and can be absent on Android, which is not
 * an error — the re-encode below decides the real type. This exists so that an
 * asset claiming an unsupported type (e.g. a GIF) is refused with a clear message
 * instead of being uploaded and rejected with a 400 that reads like a server
 * fault.
 */
function assertSupportedMimeType(asset: ImagePicker.ImagePickerAsset): PhotoPickFailure | null {
  const mime = asset.mimeType?.toLowerCase();
  if (!mime) return null;
  if ((ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(mime)) return null;
  return { kind: 'unsupported', message: zh.addItem.errors.unsupportedFormat };
}

/** True when the permission response means "we may proceed". */
function permissionAllows(response: ImagePicker.PermissionResponse | null): boolean {
  return response?.granted === true;
}

/**
 * Picks one image from the device gallery.
 *
 * On Android the photo-library permission is NOT what gates picking, and the exact
 * reason is worth writing down because it is counter-intuitive:
 *
 *  - `getMediaLibraryPermissions()` returns an **empty** array on API 33+
 *    (`ImagePickerModule.kt:258-266` — `emptyArray<String>()`); the system photo
 *    picker grants per-URI read access and needs no manifest permission.
 *  - An empty array produces an empty native result map, and `PermissionsService.kt:141`
 *    computes `areAllGranted = map.all { ... }`, which is **vacuously true** for an
 *    empty map. So `granted` comes back `true`.
 *
 * On modern Android this call therefore succeeds without prompting, and its
 * `granted` flag carries no real information — the **pick result is the
 * authoritative signal**. The check below blocks only in the one case that genuinely
 * cannot proceed: a device where the permission is required (pre-API-33), was
 * denied, and can no longer be asked for (`canAskAgain === false`). Then the UI
 * points at Settings instead of offering a button that would silently do nothing.
 *
 * Read from the shipped Kotlin, not assumed — see
 * `mobile/docs/第二轮-图片选择与上传调研.md` §5.
 * not guaranteed on newer Android: on API 33+ the system photo picker needs no
 * runtime permission at all, so `requestMediaLibraryPermissionsAsync` may return
 * a denial that does not actually block picking. We therefore ask, and treat a
 * denial as *informational only when the picker still succeeds* — the
 * authoritative signal is the pick result itself. A denial that the user cannot
 * reverse (`canAskAgain === false`) is surfaced so the UI can point at Settings
 * instead of offering a button that will silently do nothing.
 */
export async function pickFromLibrary(): Promise<PhotoPickResult> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permissionAllows(permission) && permission.canAskAgain === false) {
    return {
      ok: false,
      failure: { kind: 'permission', source: 'library', canAskAgain: false },
    };
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: false,
    // Cropping is deliberately off: it would add a square-crop step the Web does
    // not have, and `allowsEditing` also forces the picker to export a fresh copy
    // rather than the original.
    allowsEditing: false,
    quality: 1,
    exif: false,
  });

  if (result.canceled) return { ok: false, failure: { kind: 'cancelled' } };

  const asset = result.assets[0];
  if (!asset) return { ok: false, failure: { kind: 'cancelled' } };

  const unsupported = assertSupportedMimeType(asset);
  if (unsupported) return { ok: false, failure: unsupported };

  return preparePhoto(asset);
}

/**
 * Takes a photo with the camera.
 *
 * The camera permission is a genuine requirement (the module declares
 * `android.permission.CAMERA`), so a denial is reported as such rather than being
 * optimistically ignored.
 */
export async function captureWithCamera(): Promise<PhotoPickResult> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permissionAllows(permission)) {
    return {
      ok: false,
      failure: {
        kind: 'permission',
        source: 'camera',
        canAskAgain: permission.canAskAgain !== false,
      },
    };
  }

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 1,
    exif: false,
  });

  if (result.canceled) return { ok: false, failure: { kind: 'cancelled' } };

  const asset = result.assets[0];
  if (!asset) return { ok: false, failure: { kind: 'cancelled' } };

  const unsupported = assertSupportedMimeType(asset);
  if (unsupported) return { ok: false, failure: unsupported };

  return preparePhoto(asset);
}

/**
 * A retry of Android's dropped picker result.
 *
 * Android may destroy `MainActivity` while the picker is in the foreground; the
 * chosen file then survives only in the module's pending store. Without this, the
 * user picks a photo, the app restarts, and the selection silently vanishes.
 * Returns null when there is nothing to recover — the normal case.
 */
export async function recoverPendingPick(): Promise<UploadablePhoto | null> {
  try {
    const pending = await ImagePicker.getPendingResultAsync();
    if (!pending || 'code' in pending) return null;
    if (pending.canceled) return null;
    const asset = pending.assets?.[0];
    if (!asset) return null;
    const photo = await preparePhoto(asset);
    return photo.ok ? photo.photo : null;
  } catch {
    return null;
  }
}
