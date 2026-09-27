/**
 * Round-3 slot vocabulary for slot-based outfits (插槽式搭配).
 *
 * Everything here was transcribed from the real backend and the Web client; nothing
 * is invented:
 *
 *  - `backend/app/models/outfit.py`      — `Outfit` / `OutfitItem` (`position`,
 *                                          `layer_type String(20) NULL`)
 *  - `backend/app/utils/clothing.py`     — `ITEM_ROLE` (the authoritative
 *                                          type → body-role table) and
 *                                          `canonical_item_order`
 *  - `frontend/lib/studio/canonical-order.ts` — the same table on the Web side
 *                                          (verified byte-for-byte equal to the
 *                                          backend's, key for key)
 *  - `backend/app/api/outfits.py`        — `VALID_OCCASIONS`, `OutfitResponse`,
 *                                          `OutfitItemResponse`, `SuggestionCreateRequest`
 *  - `frontend/messages/zh-CN/constants.json` — Chinese labels for types and occasions
 *
 * ---------------------------------------------------------------------------
 * Why a slot is DERIVED from the garment's own `type` instead of being stored
 * ---------------------------------------------------------------------------
 * `OutfitItem.layer_type` looks like the natural place to store "which slot is this
 * garment in", and `OutfitItemResponse` even returns it. But there is **no write
 * path for it anywhere in the API**:
 *
 *  - `POST /outfits/suggestions` (`SuggestionCreateRequest`) takes `items: list[UUID]`
 *    only, and `ExternalOutfitService._persist_outfit` inserts every `OutfitItem`
 *    with `layer_type` unset.
 *  - `POST /outfits/studio` (`StudioCreateRequest`) likewise, and it additionally
 *    discards the caller's order via `_order_items_canonically`.
 *  - `PATCH /outfits/{id}` (`PatchOutfitRequest`) takes `name` + `items` only, and
 *    `StudioService.patch_outfit` **deletes and recreates** every `OutfitItem` row,
 *    so any `layer_type` written by hand would be wiped on the first edit.
 *
 * So slot membership is computed from the server-stored garment type through the
 * repository's own `ITEM_ROLE` table, which is a strict partition: every type maps
 * to exactly one role, and every role maps to at most one slot here. Consequences,
 * all of which the round-3 requirements depend on:
 *
 *  - a garment's slot is a pure function of stored data, so after a cold start the
 *    slots rebuilt from `GET /outfits/{id}` equal the slots that were saved — no
 *    extra field to keep in sync, nothing to migrate;
 *  - `PATCH` replacing the item set cannot lose slot semantics, because they were
 *    never stored separately;
 *  - the Web client reading the same outfit derives the same slots.
 *
 * The alternative — extending the request schemas with a storable slot field — was
 * rejected as unnecessary: it would touch the shared backend and still be erased by
 * `patch_outfit` unless that service were changed too.
 */

/** The five席位 this round offers. Fixed display order. */
export const SLOTS = ['top', 'bottom', 'outer', 'shoes', 'accessory'] as const;

export type SlotKey = (typeof SLOTS)[number];

/** 基础席位: required to make a usable outfit (三个基础类别). */
export const REQUIRED_SLOTS: readonly SlotKey[] = ['top', 'bottom', 'shoes'];

/** 可选席位: an outfit may legitimately omit these. */
export const OPTIONAL_SLOTS: readonly SlotKey[] = ['outer', 'accessory'];

/**
 * Chinese labels for the slots. `上衣` covers every `base_top` type and `下装`
 * covers trousers **and** skirts, which is why a slot is a group of types rather
 * than one type.
 */
export const SLOT_LABELS: Record<SlotKey, string> = {
  top: '上衣',
  bottom: '下装',
  outer: '外套',
  shoes: '鞋子',
  accessory: '配饰',
};

/**
 * `ITEM_ROLE` — copied key-for-key from `backend/app/utils/clothing.py` and
 * `frontend/lib/studio/canonical-order.ts` (the two are identical). It is the
 * server's own answer to "what part of the body is this garment", so the client's
 * slot mapping cannot drift from the ordering the backend applies.
 */
export const ITEM_ROLE: Record<string, string> = {
  shirt: 'base_top',
  't-shirt': 'base_top',
  blouse: 'base_top',
  polo: 'base_top',
  'tank-top': 'base_top',
  top: 'base_top',
  sweater: 'base_top',
  pants: 'bottom',
  jeans: 'bottom',
  shorts: 'bottom',
  skirt: 'bottom',
  dress: 'full_body',
  jumpsuit: 'full_body',
  cardigan: 'mid_layer',
  vest: 'mid_layer',
  jacket: 'outer_layer',
  blazer: 'outer_layer',
  coat: 'outer_layer',
  hoodie: 'outer_layer',
  shoes: 'footwear',
  sneakers: 'footwear',
  boots: 'footwear',
  sandals: 'footwear',
  socks: 'socks',
  tie: 'neckwear',
  hat: 'accessory',
  scarf: 'accessory',
  belt: 'accessory',
  bag: 'accessory',
  accessories: 'accessory',
};

/**
 * Body role → slot.
 *
 * `mid_layer` (cardigan, vest) joins 外套 for the same reason the backend orders it
 * between the base top and the outer layer: it is worn over the top layer, and this
 * round offers exactly one outer slot.
 *
 * `socks` and `neckwear` join 配饰: they are neither of the three basic garments nor
 * a coat, and 配饰 is the round's catch-all optional slot. They are listed
 * explicitly rather than lumped in silently, so the mapping stays reviewable.
 *
 * `full_body` (dress, jumpsuit) deliberately maps to **no** slot — see
 * `UNSUPPORTED_FULL_BODY_TYPES`.
 */
const ROLE_SLOT: Record<string, SlotKey | undefined> = {
  base_top: 'top',
  bottom: 'bottom',
  mid_layer: 'outer',
  outer_layer: 'outer',
  footwear: 'shoes',
  socks: 'accessory',
  neckwear: 'accessory',
  accessory: 'accessory',
  full_body: undefined,
};

/**
 * Types the round explicitly does not support: 连衣裙 / 连体衣 replace several
 * garments at once, so they do not fit "one garment per slot" and are reported as
 * unsupported instead of being forced into 上衣.
 */
export const UNSUPPORTED_FULL_BODY_TYPES: readonly string[] = ['dress', 'jumpsuit'];

/** Every `type` value the slot offers, derived from `ITEM_ROLE` (never hand-listed). */
export const SLOT_TYPES: Record<SlotKey, readonly string[]> = (() => {
  const result: Record<SlotKey, string[]> = {
    top: [],
    bottom: [],
    outer: [],
    shoes: [],
    accessory: [],
  };
  for (const [type, role] of Object.entries(ITEM_ROLE)) {
    const slot = ROLE_SLOT[role];
    if (slot) result[slot].push(type);
  }
  return result;
})();

/**
 * The slot a stored garment belongs to, or `null` when this round has no slot for it.
 *
 * `null` covers two different real cases, which callers must keep distinct:
 *
 *  1. `full_body` — 连衣裙 / 连体衣, explicitly out of scope this round
 *     (`UNSUPPORTED_FULL_BODY_TYPES`).
 *  2. no role at all — the server's own `unknown` placeholder for a garment whose
 *     AI tagging never ran or failed, `other`, and `suit` (in `CLOTHING_TYPES` on
 *     both clients but absent from `ITEM_ROLE`, so the backend's canonical ordering
 *     leaves it unranked too). These are 待分类 and must NEVER be silently filed
 *     under 上衣.
 */
export function slotForType(type: string | null | undefined): SlotKey | null {
  if (!type) return null;
  const role = ITEM_ROLE[type];
  if (!role) return null;
  return ROLE_SLOT[role] ?? null;
}

/** True for a类型 whose garments this round cannot place in any slot (连衣裙/连体衣). */
export function isUnsupportedFullBody(type: string | null | undefined): boolean {
  return Boolean(type && UNSUPPORTED_FULL_BODY_TYPES.includes(type));
}

/** True for a garment the wardrobes has not classified into any known type. */
export function isUnclassified(type: string | null | undefined): boolean {
  return !type || !ITEM_ROLE[type];
}

/** True when the garment is one of the three基础席位 types. */
export function isRequiredSlotType(type: string | null | undefined): boolean {
  const slot = slotForType(type);
  return slot !== null && REQUIRED_SLOTS.includes(slot);
}

/**
 * Occasions the backend accepts (`VALID_OCCASIONS` in `backend/app/api/outfits.py`,
 * 23 values). `POST /outfits/suggestions` requires one and validates it against that
 * set; the six labelled below are the ones both clients actually offer
 * (`frontend/lib/types.ts` OCCASIONS), copied from
 * `frontend/messages/zh-CN/constants.json` `occasions`.
 *
 * Round 3 does not ask the user for an occasion, so it sends
 * `DEFAULT_OUTFIT_OCCASION` and says so in the report rather than implying a choice
 * was made. The value is displayed back from the server's own response.
 */
export const OCCASION_LABELS: Record<string, string> = {
  casual: '休闲',
  date: '约会',
  formal: '正式',
  office: '办公',
  outdoor: '户外',
  sporty: '运动',
};

/** Sent because the endpoint requires one and the round-3 form does not ask. */
export const DEFAULT_OUTFIT_OCCASION = 'casual';

/**
 * Human label for an occasion, falling back to the raw server value.
 *
 * The fallback mirrors `clothingTypeLabel`: an occasion is content authored by
 * whoever created the outfit (the Web chip row, an AI suggestion, another client),
 * not a status enum, and inventing a Chinese word for an unknown one would hide
 * what the server actually stored.
 */
export function occasionLabel(occasion: string | null | undefined): string {
  if (!occasion) return '';
  return OCCASION_LABELS[occasion] ?? occasion;
}

/**
 * Chinese wording for `OutfitResponse.status`.
 *
 * `backend/app/models/outfit.py` `OutfitStatus`: pending, sent, viewed, accepted,
 * rejected, skipped, expired. Screens map through this table so no status enum
 * reaches the screen (the rule stated at the top of `src/i18n/zh.ts`).
 */
export const OUTFIT_STATUS_LABELS: Record<string, string> = {
  pending: '待确认',
  sent: '已发送',
  viewed: '已查看',
  accepted: '已采纳',
  rejected: '已拒绝',
  skipped: '已略过',
  expired: '已过期',
};

/** Human label for a stored outfit status, falling back to a neutral word. */
export function outfitStatusLabel(status: string | null | undefined): string {
  if (!status) return '';
  return OUTFIT_STATUS_LABELS[status] ?? '状态未知';
}

/** Longest outfit name the server accepts (`name: String(100)`). */
export const OUTFIT_NAME_MAX_LENGTH = 100;

/**
 * Most items one outfit may hold (`max_length=20` on every request schema that takes
 * `items`). Enforced client-side so the user gets a Chinese message instead of a 422.
 */
export const OUTFIT_MAX_ITEMS = 20;
