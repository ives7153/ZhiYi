import { File as FsFile } from 'expo-file-system';

import { request, requestMultipart } from './client';
import type {
  BulkUploadResponse,
  BulkUploadResult,
  Item,
  ItemCreateFields,
  ItemUpdateFields,
  UploadablePhoto,
} from './types';

/**
 * Appends a local file as a multipart `Blob` part.
 *
 * `expo-file-system`'s `File` implements `Blob` (it exposes `bytes()`, `type`,
 * `size` and `name`), which is exactly the shape Expo's `fetch` serializes.
 * Passing `{ uri, name, type }` instead makes `fetch` throw `Unsupported
 * FormDataPart implementation` before any request is sent — see the long note on
 * `requestMultipart` in `client.ts`.
 *
 * The `name` argument to `append` becomes the multipart part's filename, which the
 * server validates against its allowed extensions, so the caller has to supply a
 * name with a valid extension (it does — see `preparePhoto`).
 */
function appendFilePart(form: FormData, field: string, photo: UploadablePhoto): void {
  const file = new FsFile(photo.uri);
  // `File` is a SharedRef-backed Blob; React Native's FormData typings only
  // accept the web `Blob`, hence the cast. This is the shape
  // `convertFormDataAsync` accepts.
  form.append(field, file as unknown as Blob, photo.name);
}

/**
 * Wardrobe write endpoints (round 2).
 *
 * Every function here maps 1:1 onto a real handler in
 * `backend/app/api/items.py`; none of them invent a field or a status code. The
 * semantics that matter to the UI are documented per function, because several of
 * them are non-obvious and were confirmed against the running server:
 *
 *  - a duplicate photo is rejected with **409**, not created twice
 *    (`ImageService.compute_phash` + `ItemService.find_duplicate_by_hash`);
 *  - `POST /items/bulk` with a repeated `upload_keys` value returns the
 *    **already-created** item (`duplicate: true`) instead of inserting again,
 *    enforced by a partial unique index on `(user_id, upload_key)`;
 *  - `skip_ai=true` yields `status: "ready"`, `tagging_status: "pending"` — i.e.
 *    usable for outfits immediately, with manual tagging left to the user.
 */

/**
 * `POST /items` — add one garment from one photo.
 *
 * `image` is the only required field. When `type` is omitted the server stores
 * `unknown` and lets AI fill it in later (`ItemCreate(type="unknown")`).
 *
 * Failures worth distinguishing in the UI:
 *  - **400** — the image failed `ImageService.validate_image`: not a JPEG/PNG/
 *    WebP/HEIC, unreadable, or over 20MB.
 *  - **409** — the same photo already exists in this wardrobe.
 */
export function createItem(
  photo: UploadablePhoto,
  fields: ItemCreateFields = {},
  signal?: AbortSignal,
): Promise<Item> {
  const form = new FormData();

  // A Blob part, not `{ uri, name, type }`. See `requestMultipart` in client.ts
  // for why the classic uri idiom silently fails under Expo SDK 57.
  appendFilePart(form, 'image', photo);

  if (fields.type) form.append('type', fields.type);
  if (fields.subtype) form.append('subtype', fields.subtype);
  if (fields.name) form.append('name', fields.name);
  if (fields.brand) form.append('brand', fields.brand);
  if (fields.notes) form.append('notes', fields.notes);
  if (fields.colors) form.append('colors', fields.colors);
  if (fields.primary_color) form.append('primary_color', fields.primary_color);
  form.append('favorite', String(fields.favorite ?? false));
  form.append('skip_ai', String(fields.skip_ai ?? false));

  return requestMultipart<Item>('/items', form, { signal });
}

/**
 * `POST /items/bulk` — add several garments at once.
 *
 * `uploadKeys` is the idempotency mechanism, and the only reason this client uses
 * the bulk endpoint at all rather than looping `createItem`. It is a list of
 * client-generated strings, same length and order as the photos. The server
 * looks each key up **before** reading or storing the file, and a retry that
 * reuses a key returns the existing item with `duplicate: true` rather than
 * inserting a second row. Without the keys, a retried upload of a photo the
 * server already accepted is only saved from duplication by the perceptual-hash
 * check — which reports a hard failure instead of succeeding idempotently.
 *
 * The server derives `type` per item; per-item metadata is not supported here,
 * so callers that need a type should create items one at a time.
 */
export function createItemsBulk(
  photos: UploadablePhoto[],
  options: { uploadKeys: string[]; skipAi?: boolean; signal?: AbortSignal },
): Promise<BulkUploadResponse> {
  if (options.uploadKeys.length !== photos.length) {
    // The server enforces this too (400), but failing here gives a stack that
    // points at the caller rather than at a network round-trip.
    throw new Error('uploadKeys and photos must have the same length');
  }

  const form = new FormData();
  for (const photo of photos) appendFilePart(form, 'images', photo);
  for (const key of options.uploadKeys) form.append('upload_keys', key);
  form.append('skip_ai', String(options.skipAi ?? false));

  return requestMultipart<BulkUploadResponse>('/items/bulk', form, {
    signal: options.signal,
  });
}

/**
 * `PATCH /items/{id}` — edit the user-maintainable attributes.
 *
 * Only these fields are accepted by `ItemUpdate`; anything else (like `status`)
 * is ignored by the server, which is the correct behaviour — it must not be
 * possible for a client to fabricate a `ready` state for an item the server
 * considers broken.
 *
 * Side effect the UI must account for: writing any of `type`, `subtype`, `colors`,
 * `primary_color` or `tags` makes the server set `tagging_status = "tagged"` and
 * `tagged_by = "manual"` (`TAG_WRITEBACK_FIELDS`). Editing only a name, brand or
 * favourite does not.
 *
 * That distinction is why callers must send **only the changed fields** and never
 * a default-filled `type`. Sending an unchanged `type` on every save turns a plain
 * rename into a manual-classification event; the item stops reporting itself as
 * needing tags, and `tagged_by` claims a person classified it. The edit form in
 * `app/item/[id].tsx` builds its payload as a real diff for exactly this reason
 * — do not "simplify" it back into an unconditional object.
 * `primary_color` or `tags` makes the server set `tagging_status = "tagged"` and
 * `tagged_by = "manual"` (`TAG_WRITEBACK_FIELDS`). Editing a name alone does not.
 */
export function updateItem(
  itemId: string,
  fields: ItemUpdateFields,
  signal?: AbortSignal,
): Promise<Item> {
  return request<Item>(`/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    body: fields,
    signal,
  });
}

/**
 * `DELETE /items/{id}` — permanent, and wider-reaching than the label suggests.
 *
 * The handler deletes the row **and** every stored image file (original, medium,
 * thumbnail, backup). `outfit_items.item_id` is `ON DELETE CASCADE`, so the
 * garment is also removed from any outfit that referenced it. There is no undo.
 * The UI must say so before calling this.
 */
export function deleteItem(itemId: string, signal?: AbortSignal): Promise<void> {
  return request<void>(`/items/${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
    signal,
  });
}

/**
 * `POST /items/{id}/archive` — the reversible alternative to delete.
 *
 * Sets `is_archived = true` and `status = "archived"`, which removes the item
 * from the default list (`is_archived` defaults to false in `ItemListFilter`) and
 * from outfit generation (`recommendation_service` and `pairing_service` both
 * require `status == ready`). The row and its images stay, so `restore` brings it
 * back. `outfit_items` rows are untouched.
 *
 * The confirmation copy must therefore not claim the garment disappears from
 * existing outfits — it does not.
 */
export function archiveItem(
  itemId: string,
  reason?: string,
  signal?: AbortSignal,
): Promise<Item> {
  return request<Item>(`/items/${encodeURIComponent(itemId)}/archive`, {
    method: 'POST',
    body: { reason: reason ?? null },
    signal,
  });
}

/** `POST /items/{id}/restore` — undo an archive. */
export function restoreItem(itemId: string, signal?: AbortSignal): Promise<Item> {
  return request<Item>(`/items/${encodeURIComponent(itemId)}/restore`, {
    method: 'POST',
    signal,
  });
}

/**
 * `POST /items/{id}/analyze` — ask the server to (re)run AI tagging.
 *
 * Returns the server's own decision rather than the client assuming one:
 *  - `deferred` — AI vision is off server-side; the item was marked ready so it
 *    stays manually manageable. Nothing to wait for.
 *  - `queued`   — a job is queued; the list will poll it to completion.
 *  - `cooldown` — the item is in `error` and the retry cooldown has not elapsed.
 */
export function analyzeItem(
  itemId: string,
  signal?: AbortSignal,
): Promise<AnalyzeResponse> {
  return request<AnalyzeResponse>(`/items/${encodeURIComponent(itemId)}/analyze`, {
    method: 'POST',
    signal,
  });
}

export type AnalyzeResponse = {
  status: 'deferred' | 'queued' | 'already_queued' | 'cooldown';
  job_id?: string | null;
  reason?: string;
  retry_after_seconds?: number;
};

/** Result of a bulk upload, flattened for the confirmation screen. */
export type BulkOutcome = {
  created: BulkUploadResult[];
  duplicates: BulkUploadResult[];
  failed: BulkUploadResult[];
};

/** Groups `BulkUploadResponse.results` by outcome, preserving server order. */
export function groupBulkResults(response: BulkUploadResponse): BulkOutcome {
  const outcome: BulkOutcome = { created: [], duplicates: [], failed: [] };
  for (const result of response.results) {
    if (!result.success) outcome.failed.push(result);
    else if (result.duplicate) outcome.duplicates.push(result);
    else outcome.created.push(result);
  }
  return outcome;
}
