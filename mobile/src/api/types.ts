/**
 * Response/request types, transcribed from the real backend schemas.
 *
 * Sources:
 *  - `backend/app/api/auth.py`, `backend/app/schemas/user.py`
 *  - `backend/app/schemas/item.py` (`ItemResponse`, `ItemListResponse`)
 *  - live responses captured while bringing the backend up (see
 *    `docs/知衣-开发进度.md`)
 */

/** `GET /api/v1/auth/config` */
export interface AuthConfigOIDC {
  enabled: boolean;
  issuer_url: string | null;
  client_id: string | null;
}

export interface AuthConfigResponse {
  oidc: AuthConfigOIDC;
  /** `settings.debug && !oidc_configured` — the dev form renders only when true. */
  dev_mode: boolean;
  password_auth?: boolean;
  registration_enabled?: boolean;
}

/** `GET /api/v1/auth/status` */
export interface AuthStatusResponse {
  configured: boolean;
  mode: 'oidc' | 'dev' | 'unknown';
  error: string | null;
}

/** `POST /api/v1/auth/sync` request. */
export interface UserSyncRequest {
  external_id: string;
  email?: string | null;
  display_name: string;
  avatar_url?: string | null;
  /** Required only when OIDC is configured. */
  id_token?: string | null;
  provider?: string | null;
}

/** `POST /api/v1/auth/sync` response. */
export interface UserSyncResponse {
  id: string;
  email: string;
  display_name: string;
  is_new_user: boolean;
  onboarding_completed: boolean;
  access_token: string;
}

export interface SendCodeRequest {
  email: string;
  purpose: 'register' | 'reset_password';
}

export interface SendCodeResponse {
  success: boolean;
  message: string;
  delivery_mode: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  code: string;
  display_name?: string | null;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface ResetPasswordRequest {
  email: string;
  code: string;
  new_password: string;
}

export interface ChangePasswordRequest {
  old_password: string;
  new_password: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  user: SessionUser;
}
/** `GET /api/v1/auth/session` — `UserResponse`. */
export interface SessionUser {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  timezone: string;
  locale: string;
  location_lat: number | null;
  location_lon: number | null;
  location_name: string | null;
  external_id: string;
  family_id: string | null;
  role: string;
  is_active: boolean;
  onboarding_completed: boolean;
  email_verified?: boolean;
  has_password?: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `GET /api/v1/users/me` — `UserProfileResponse`.
 *
 * Deliberately a separate type from `SessionUser`: the profile response omits
 * `external_id`/`is_active`/timestamps and adds `body_measurements`. Modelling it
 * as one "user" type would paper over a real difference between the endpoints.
 */
export interface UserProfile {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  timezone: string;
  locale: string;
  location_lat: number | null;
  location_lon: number | null;
  location_name: string | null;
  family_id: string | null;
  role: string;
  onboarding_completed: boolean;
  email_verified?: boolean;
  has_password?: boolean;
  body_measurements: Record<string, unknown> | null;
}

/** One item as returned by the list and detail endpoints. */
export interface Item {
  id: string;
  user_id: string;
  type: string;
  subtype: string | null;
  name: string | null;
  brand: string | null;
  notes: string | null;
  purchase_date: string | null;
  purchase_price: string | number | null;
  favorite: boolean;
  /**
   * `owned` = 已拥有, `to_buy` = 待购 (round 4). One garment table, two sides: the
   * server decides which list, count or candidate set an item belongs to, and this
   * field is echoed back so no screen has to infer it from the endpoint it called.
   */
  ownership: string;
  /**
   * Reference price typed while the garment is only planned. A `string`-or-number
   * decimal, exactly as the server stores it (`Numeric(10, 2)`): it is NEVER turned
   * into a float, because 199.99 would not survive the round trip. `null` means
   * "not filled in", which is not the same as 0.
   */
  reference_price: string | number | null;
  /** Manually typed product page, http/https only. Never fetched by the app. */
  source_url: string | null;

  /** Server-side storage paths (not directly fetchable). */
  image_path: string;
  thumbnail_path: string | null;
  medium_path: string | null;
  original_image_path: string | null;

  tags: Record<string, unknown>;
  colors: string[];
  primary_color: string | null;
  pattern: string | null;
  material: string | null;
  style: string[];
  formality: string | null;
  season: string[];

  status: string;
  ai_processed: boolean;
  ai_confidence: number | string | null;
  ai_description: string | null;
  ai_error: string | null;
  ai_started_at: string | null;
  processing_kind: string | null;
  tagging_status: string;
  tagged_by: string | null;
  tagged_at: string | null;

  wear_count: number;
  last_worn_at: string | null;
  last_suggested_at: string | null;
  suggestion_count: number;
  acceptance_count: number;
  wears_since_wash: number;
  last_washed_at: string | null;
  wash_interval: number | null;
  needs_wash: boolean;

  additional_images: unknown[];
  is_archived: boolean;
  archived_at: string | null;
  archive_reason: string | null;
  created_at: string;
  updated_at: string;

  /**
   * Computed by the backend. RELATIVE signed paths that already include
   * `/api/v1`, e.g. `/api/v1/images/<uuid>/<file>.jpg?expires=...&sig=...`.
   * Run them through `joinUrl` before handing them to <Image>.
   */
  image_url: string;
  thumbnail_url: string | null;
  medium_url: string | null;

  effective_wash_interval: number;
}

/** `GET /api/v1/items?page=&page_size=` */
export interface ItemListResponse {
  items: Item[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

/** Query parameters accepted by the list endpoint. */
export interface ItemListParams {
  page?: number;
  page_size?: number;
  type?: string;
  subtype?: string;
  colors?: string;
  status?: string;
  tagging_status?: string;
  favorite?: boolean;
  needs_wash?: boolean;
  is_archived?: boolean;
  search?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  /**
   * `GET /items?ownership=` — defaults to `owned` server-side. `to_buy` is what the
   * 待购 list sends; the wardrobe never needs to (the server's default is already the
   * wardrobe), but it is sent explicitly there anyway so the intent stays readable.
   */
  ownership?: 'owned' | 'to_buy';
}

/** `GET /api/v1/items/types` */
export interface ItemTypeCount {
  type: string;
  count: number;
}

/**
 * `POST /api/v1/items` form fields. Every one except `image` is optional.
 *
 * Round-4 additions: `ownership` selects which side the garment lands on (omitted
 * means the wardrobe, exactly as before), and `reference_price` / `source_url` are the
 * two optional 待购 fields. `reference_price` travels as the string the user typed —
 * never a `number` — so the amount reaches the server's `Numeric(10, 2)` column
 * without a float ever touching it.
 */
export interface ItemCreateFields {
  type?: string;
  subtype?: string;
  name?: string;
  brand?: string;
  notes?: string;
  colors?: string;
  primary_color?: string;
  favorite?: boolean;
  skip_ai?: boolean;
  ownership?: 'owned' | 'to_buy';
  reference_price?: string;
  source_url?: string;
}

/**
 * `PATCH /api/v1/items/{id}` body — `ItemUpdate` in `backend/app/schemas/item.py`.
 *
 * `ownership` is deliberately absent: buying a 待购 garment is
 * `POST /items/{id}/purchase`, which is idempotent and keeps the same row, not an
 * attribute the edit form may flip.
 */
export interface ItemUpdateFields {
  type?: string;
  subtype?: string | null;
  name?: string | null;
  brand?: string | null;
  notes?: string | null;
  colors?: string[] | null;
  primary_color?: string | null;
  favorite?: boolean;
  reference_price?: string | null;
  source_url?: string | null;
}

/**
 * A local photo, normalized and ready to upload.
 *
 * `uri` is a local file path; `name` and `type` become the multipart part's
 * filename and Content-Type, both of which the server validates.
 */
export interface UploadablePhoto {
  uri: string;
  name: string;
  type: string;
}

/** `GET /api/v1/capabilities` */
export interface CapabilitiesResponse {
  ai: { vision: boolean; text: boolean };
  features: Record<string, boolean>;
  version: string;
}

/* ------------------------------------------------------------------ *
 * Round-2 write types.
 *
 * Sources: `backend/app/schemas/item.py` (ItemUpdate,
 * BulkUploadResult, BulkUploadResponse) and the live responses captured in
 * `docs/知衣-开发进度.md`. The write *payload* types live in `itemVocab.ts`
 * alongside the enum vocabularies the forms need.
 * ------------------------------------------------------------------ */

/** One entry of `BulkUploadResponse.results`. */
export interface BulkUploadResult {
  filename: string;
  success: boolean;
  item: Item | null;
  error: string | null;
  /**
   * True when the server recognised this as a retry of an upload it had already
   * accepted (matched by `upload_keys`). `item` then holds the EXISTING item, so
   * the caller must treat it as success-with-no-new-row rather than a failure.
   */
  duplicate: boolean;
  existing_item_id: string | null;
}

/** `POST /api/v1/items/bulk` */
export interface BulkUploadResponse {
  total: number;
  successful: number;
  failed: number;
  results: BulkUploadResult[];
}
export interface CapabilitiesResponse {
  ai: { vision: boolean; text: boolean };
  features: Record<string, boolean>;
  version: string;
}

/* ------------------------------------------------------------------ *
 * Round-3 outfit types.
 *
 * Sources: `backend/app/api/outfits.py` (`OutfitResponse`,
 * `OutfitItemResponse`, `OutfitListResponse`, `SuggestionCreateRequest`,
 * `PatchOutfitRequest`) plus live responses captured from this backend
 * while implementing round 3 (`docs/第三轮-验收报告.md`). Note that
 * `OutfitResponse` carries no `user_id`: the API only ever returns the
 * caller's own outfits (`Outfit.user_id == current_user.id`), and a
 * foreign id answers 404 rather than exposing another account's row.
 * ------------------------------------------------------------------ */

/**
 * One garment inside an outfit — `OutfitItemResponse`.
 *
 * `image_url` / `thumbnail_url` are relative signed paths, exactly like the
 * wardrobe's, and must go through `joinUrl` before being handed to `<Image>`.
 * `layer_type` is present but is `null` for everything this app writes, because
 * no request schema accepts it (see `src/api/outfitVocab.ts`); the round-3 slot is
 * derived from `type` instead.
 */
export interface OutfitItem {
  id: string;
  type: string;
  subtype: string | null;
  name: string | null;
  primary_color: string | null;
  colors: string[];
  image_path: string | null;
  thumbnail_path: string | null;
  layer_type: string | null;
  position: number;
  image_url: string | null;
  thumbnail_url: string | null;
  /** Read from the garment row by the server: `owned` / `to_buy`. */
  ownership: string;
}

/** `OutfitResponse`. */
export interface Outfit {
  id: string;
  occasion: string;
  scheduled_for: string | null;
  status: string;
  name: string | null;
  replaces_outfit_id: string | null;
  cloned_from_outfit_id: string | null;
  source: string;
  reasoning: string | null;
  style_notes: string | null;
  season: string | null;
  formality: string | null;
  palette: string[] | null;
  notes: string | null;
  highlights: string[] | null;
  weather: Record<string, unknown> | null;
  items: OutfitItem[];
  feedback: Record<string, unknown> | null;
  family_ratings: unknown[] | null;
  family_rating_average: number | null;
  family_rating_count: number | null;
  is_starter_suggestion: boolean;
  /**
   * Server-computed truth about this outfit's side: true when at least one of its
   * garments is still 待购, i.e. this is a 试搭 built to decide a purchase. The app
   * renders its 「试搭·含待购」 marker from this flag rather than from a client-side
   * label, so it cannot drift from the real ownership and disappears by itself once
   * the last un-bought garment is purchased.
   */
  contains_to_buy: boolean;
  created_at: string;
}

/** `GET /api/v1/outfits?page=&page_size=` */
export interface OutfitListResponse {
  outfits: Outfit[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

/** Query parameters accepted by the outfit list endpoint. */
export interface OutfitListParams {
  page?: number;
  page_size?: number;
  search?: string;
}

/**
 * `POST /api/v1/outfits/suggestions` body — `SuggestionCreateRequest`.
 *
 * `items` is capped at 20 by the server and `occasion` must be one of
 * `VALID_OCCASIONS`. The schema sets `extra="forbid"`, so sending any other key
 * (including a `layer_type`-style slot field) is a 422.
 */
export interface OutfitCreateFields {
  items: string[];
  occasion: string;
  name?: string | null;
}

/**
 * `PATCH /api/v1/outfits/{id}` body — `PatchOutfitRequest`. Also `extra="forbid"`.
 *
 * `name` is `string`, **not** `string | null`, and that is the point: the server reads `null`
 * as "leave the name alone" (`PatchOutfitRequest.name` defaults to `None`, and
 * `StudioService.patch_outfit` applies it under `if name is not None`), while `""` is a real
 * value that clears it. Allowing `null` here is what let the editor send `name || null` and
 * turn "clear the name" into a silent no-op; the narrower type makes that mistake a compile
 * error instead of a wrong screen. Verified against the running backend: `{"name":""}` →
 * `GET` reports `name == ""`; `{"name":null}` → the stored name is unchanged.
 *
 * Both fields stay optional: `PATCH` requires at least one of them
 * (`PATCH_EMPTY` 400 otherwise), and omitting `items` means "leave the garments alone".
 */
export interface OutfitPatchFields {
  name?: string;
  items?: string[];
}
