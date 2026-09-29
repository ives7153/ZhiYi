import type { Item, OutfitItem } from '../api/types';
import {
  OUTFIT_MAX_ITEMS,
  REQUIRED_SLOTS,
  SLOTS,
  isUnsupportedFullBody,
  slotForType,
  type SlotKey,
} from '../api/outfitVocab';
import { TO_BUY } from '../api/toBuy';

/**
 * The slot draft — the one piece of state the 搭配 screens share, kept out of React so
 * its invariants can be checked without a device.
 *
 * A draft is "one garment per slot, plus anything the round cannot place":
 *
 *  - `selection` holds **at most one** garment per slot key. That is what makes
 *    "左右滑动只替换当前槽位" true by construction: replacing a slot rewrites one key.
 *  - `passthrough` holds garments that arrived from the server inside a saved outfit but
 *    are not one of this round's slots: 连衣裙 / 连体衣, 待分类 items (`unknown`, `suit`),
 *    and a second garment of a slot that is already taken. They are shown and carried back
 *    on save, never dropped: silently removing a garment during an unrelated rename would
 *    be a fabricated edit. `passthroughReason` names which of those three a row is, so the
 *    screen never has to guess ("待分类" was previously shown for a same-slot duplicate,
 *    which is a different fact).
 *  - a draft can hold **more garments than the server accepts** (20 per outfit,
 *    `OUTFIT_MAX_ITEMS`). That is a state the user has to resolve, not one the client may
 *    quietly cut down to size: `draftItemOverflow` reports it, `draftBlocker` refuses the
 *    save with the numbers, and the editor lets the user remove a garment deliberately.
 *    (Round-3 review finding A: `draftItemIds` used to `slice(0, 20)`, and the `PATCH` that
 *    followed rebuilt the outfit from that shortened list — so the 21st garment's
 *    association was deleted with no message at all.)
 *
 * A garment's slot follows from its own `type`, so a draft rebuilt from the server's copy
 * of an outfit is equal to the draft that was saved — see `draftSignature`, which exists
 * exactly to assert that.
 */

export interface OutfitDraft {
  selection: Partial<Record<SlotKey, Item>>;
  passthrough: OutfitItem[];
}

/**
 * The fields of a garment this feature needs.
 *
 * Declared explicitly rather than as `Pick<Item, …>` so it can be satisfied by both
 * `Item` (wardrobe candidate) and `OutfitItem` (garment inside a saved outfit): the two
 * differ only in fields this feature never reads, and an outfit item may report `null`
 * image URLs where a wardrobe item always has one.
 */
export interface DraftGarment {
  id: string;
  type: string;
  name: string | null;
  thumbnail_url: string | null;
  image_url: string | null;
  /**
   * `owned` / `to_buy`, carried through the draft so a slot row can mark an un-bought
   * garment and so the screen knows whether what it is building is a 试搭. The value
   * comes from the server's own item; the client never labels a garment itself.
   */
  ownership: string;
}

/** A draft with every slot empty — the starting point for a new outfit. */
export function emptyDraft(): OutfitDraft {
  return { selection: {}, passthrough: [] };
}

/** Narrows an `Item` or an `OutfitItem` to what the slot UI renders. */
export function toDraftGarment(source: Item | OutfitItem): DraftGarment {
  return {
    id: source.id,
    type: source.type,
    name: source.name,
    thumbnail_url: source.thumbnail_url,
    image_url: source.image_url ?? null,
    ownership: source.ownership,
  };
}

/**
 * Builds a draft from the garments the server returned for an outfit.
 *
 * Items are taken in `position` order (the order the server stored, which is the order
 * `OutfitResponse.items` documents). The first garment of a slot claims it; a second
 * garment that maps to the same slot is not discarded — it moves to `passthrough` and is
 * rendered in the 其他单品 group. That case is real even though this app cannot create it:
 * `deduplicate_by_body_slot` only guards the AI path, so a hand-authored or externally
 * written outfit can hold two `base_top` garments.
 */
export function draftFromOutfitItems(items: readonly OutfitItem[]): OutfitDraft {
  const draft = emptyDraft();
  const ordered = [...items].sort((a, b) => a.position - b.position);

  for (const outfitItem of ordered) {
    const slot = slotForType(outfitItem.type);
    if (slot && !draft.selection[slot]) {
      draft.selection[slot] = outfitItemAsItem(outfitItem);
    } else {
      draft.passthrough.push(outfitItem);
    }
  }

  return draft;
}

/**
 * Why a passthrough garment is in 其他单品 instead of a slot.
 *
 * Three different facts, which must not be shown as one:
 *
 *  - `sameSlotDuplicate` — the garment's `type` does map to a slot, but a garment of that
 *    slot was stored earlier (lower `position`), so this one has nowhere to go. It is a
 *    conflict in the stored outfit, and the user can resolve it by removing this garment
 *    or by replacing the one in the slot.
 *  - `unsupportedFullBody` — 连衣裙 / 连体衣: this round has no slot for them at all.
 *  - `unclassified` — 待分类 (`unknown`, `suit`, or no type): the server's AI never
 *    classified the garment, so no slot can be derived. Resolved in the wardrobe, not here.
 *
 * Derived from the garment's own `type`, exactly like the slots are, so it needs no extra
 * state and cannot drift from the draft it describes. (The 其他单品 rows previously said
 * "待分类" for a garment whose type the app knows perfectly well — it is what the review
 * called out as an untrue description of a same-slot conflict.)
 */
export type PassthroughReason =
  | 'sameSlotDuplicate'
  | 'unsupportedFullBody'
  | 'unclassified';

export function passthroughReason(garment: { type: string }): PassthroughReason {
  if (slotForType(garment.type)) return 'sameSlotDuplicate';
  if (isUnsupportedFullBody(garment.type)) return 'unsupportedFullBody';
  return 'unclassified';
}

/**
 * The same draft with one passthrough garment removed.
 *
 * The explicit way out of the overflow that `draftBlocker` refuses to save, and the only
 * way a garment ever leaves an outfit from this screen. Removing it here removes the
 * outfit's *association* with the garment and nothing else: `PATCH /outfits/{id}` rewrites
 * `outfit_items`, while `ClothingItem` — the wardrobe row — is never loaded or deleted,
 * which is what the row's own confirmation text says.
 *
 * If the removed garment is also the one sitting in a slot, the slot is left untouched:
 * `draftItemIds` de-duplicates by id, so the save still sends it exactly once.
 */
export function withoutPassthrough(draft: OutfitDraft, garmentId: string): OutfitDraft {
  return {
    ...draft,
    passthrough: draft.passthrough.filter((item) => item.id !== garmentId),
  };
}

/**
 * An `OutfitItem` presented in the `Item` shape the slot row renders.
 *
 * `OutfitItemResponse` deliberately returns a subset (`items.py:...` / the schema in
 * `backend/app/api/outfits.py`): no brand, wear counts or status. Everything absent is
 * filled with an empty value rather than a plausible-looking one, so no field the screen
 * shows can claim something the server never sent. `status` is set to `ready` because a
 * garment inside an outfit is by definition usable; that value is not rendered anywhere.
 */
export function outfitItemAsItem(outfitItem: OutfitItem): Item {
  return {
    id: outfitItem.id,
    user_id: '',
    type: outfitItem.type,
    subtype: outfitItem.subtype,
    name: outfitItem.name,
    brand: null,
    notes: null,
    purchase_date: null,
    purchase_price: null,
    favorite: false,
    image_path: outfitItem.image_path ?? '',
    thumbnail_path: outfitItem.thumbnail_path,
    medium_path: null,
    original_image_path: null,
    tags: {},
    colors: outfitItem.colors ?? [],
    primary_color: outfitItem.primary_color,
    pattern: null,
    material: null,
    style: [],
    formality: null,
    season: [],
    status: 'ready',
    ai_processed: false,
    ai_confidence: null,
    ai_description: null,
    ai_error: null,
    ai_started_at: null,
    processing_kind: null,
    tagging_status: 'pending',
    tagged_by: null,
    tagged_at: null,
    wear_count: 0,
    last_worn_at: null,
    last_suggested_at: null,
    suggestion_count: 0,
    acceptance_count: 0,
    wears_since_wash: 0,
    last_washed_at: null,
    wash_interval: null,
    needs_wash: false,
    additional_images: [],
    is_archived: false,
    archived_at: null,
    archive_reason: null,
    // `OutfitItemResponse` reports ownership per garment, so a garment rebuilt from a
    // saved outfit keeps its 待购 marker instead of being silently re-labelled as owned.
    ownership: outfitItem.ownership,
    // Not part of `OutfitItemResponse`; the slot UI does not show them, and inventing
    // a price here would be worse than leaving it empty.
    reference_price: null,
    source_url: null,
    created_at: '',
    updated_at: '',
    image_url: outfitItem.image_url ?? '',
    thumbnail_url: outfitItem.thumbnail_url,
    medium_url: null,
    effective_wash_interval: 0,
  };
}

/**
 * The `items` array to send to the server — **every** garment the draft holds.
 *
 * Slot order first (上衣 → 下装 → 外套 → 鞋子 → 配饰), then the passthrough garments in the
 * order the server gave them. `POST /outfits/suggestions` stores `position` in exactly
 * this array order (`ExternalOutfitService._persist_outfit`), so the round trip is stable.
 *
 * Duplicates are removed because `outfit_items` is keyed on `(outfit_id, item_id)`: the
 * same garment cannot appear twice in one outfit.
 *
 * Deliberately **not** cut down to `OUTFIT_MAX_ITEMS`. The server rejects more than 20
 * items with a 422, and `PATCH /outfits/{id}` replaces the whole item set
 * (`StudioService.patch_outfit` deletes and recreates every row), so truncating here would
 * not merely fail to send the extra garments — it would delete their association with the
 * outfit while reporting success. `draftItemOverflow` measures the excess and
 * `draftBlocker` refuses the save; whoever calls this function must do the same.
 */
export function draftItemIds(draft: OutfitDraft): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const slot of SLOTS) {
    const garment = draft.selection[slot];
    if (garment && !seen.has(garment.id)) {
      seen.add(garment.id);
      ids.push(garment.id);
    }
  }
  for (const outfitItem of draft.passthrough) {
    if (!seen.has(outfitItem.id)) {
      seen.add(outfitItem.id);
      ids.push(outfitItem.id);
    }
  }

  return ids;
}

/** How far a draft is over the server's per-outfit limit. */
export interface DraftOverflow {
  /** Garments the draft would send, after de-duplication. */
  total: number;
  /** How many have to go before the save can be accepted (`total - OUTFIT_MAX_ITEMS`). */
  excess: number;
  /** The server's own limit, repeated here so a message can quote one source. */
  max: number;
}

/**
 * The overflow, or `null` when the draft fits.
 *
 * Only reachable while editing an existing outfit: the builder has five slots, so a new
 * outfit can never exceed five garments. A saved outfit may already hold 20 — the server's
 * limit — and adding one more garment to it is the case this exists for.
 */
export function draftItemOverflow(draft: OutfitDraft): DraftOverflow | null {
  const total = draftItemIds(draft).length;
  if (total <= OUTFIT_MAX_ITEMS) return null;
  return { total, excess: total - OUTFIT_MAX_ITEMS, max: OUTFIT_MAX_ITEMS };
}

/**
 * True when the draft is a 试搭 — at least one garment in it is still 待购.
 *
 * Derived from the garments' own `ownership` (which the server reported), not from a
 * mode flag, so it stays right when a garment is replaced by an owned one mid-edit and
 * when a saved 试搭 is reopened after the purchase. The server computes the same fact
 * for a stored outfit (`OutfitResponse.contains_to_buy`); this is the in-progress
 * equivalent the builder needs before anything is saved.
 */
export function draftHasToBuy(draft: OutfitDraft): boolean {
  const inSlots = SLOTS.some((slot) => draft.selection[slot]?.ownership === TO_BUY);
  const inOthers = draft.passthrough.some((item) => item.ownership === TO_BUY);
  return inSlots || inOthers;
}

/** The 待购 garments a draft holds, for counts and for the 「含待购」 wording. */
export function draftToBuyGarmentIds(draft: OutfitDraft): string[] {
  const ids = new Set<string>();
  for (const slot of SLOTS) {
    const garment = draft.selection[slot];
    if (garment?.ownership === TO_BUY) ids.add(garment.id);
  }
  for (const item of draft.passthrough) {
    if (item.ownership === TO_BUY) ids.add(item.id);
  }
  return [...ids];
}

/** Slots that currently hold a garment, in display order. */
export function filledSlots(draft: OutfitDraft): SlotKey[] {
  return SLOTS.filter((slot) => Boolean(draft.selection[slot]));
}

/** The three基础席位 that are still empty. */
export function missingRequiredSlots(draft: OutfitDraft): SlotKey[] {
  return REQUIRED_SLOTS.filter((slot) => !draft.selection[slot]);
}

/** True when the draft holds nothing — nothing to save and nothing to lose on leaving. */
export function isDraftEmpty(draft: OutfitDraft): boolean {
  return filledSlots(draft).length === 0 && draft.passthrough.length === 0;
}

/**
 * Stable string form of a draft, for comparing "what I saved" with "what the server
 * returned" and for deciding whether the editor has unsaved changes.
 *
 * Deliberately built from slot → garment id rather than from array order: the server may
 * store a different `position` order for the same set of garments, and two outfits that
 * put the same garment in the same slot are the same outfit for this feature.
 */
export function draftSignature(draft: OutfitDraft): string {
  const slots = SLOTS.map((slot) => `${slot}:${draft.selection[slot]?.id ?? ''}`).join('|');
  const others = [...draft.passthrough]
    .map((item) => item.id)
    .sort()
    .join(',');
  return `${slots}||${others}`;
}

/**
 * The next (or previous) candidate for a slot when the user swipes.
 *
 * Defined for the cases the round calls out, including the two that are easy to get
 * wrong:
 *
 *  - an **empty slot** takes the first candidate on a forward swipe and the last on a
 *    backward one, so swiping works before anything has been chosen;
 *  - a **single candidate** returns that same garment, so the slot does not blank out
 *    when there is nothing else to show;
 *  - a candidate list that is **empty** returns `null`, which the caller renders as the
 *    "no garments in this slot yet" state rather than as a failure.
 *
 * When the current garment is no longer in the list (archived or deleted while the screen
 * was open, or filtered out by a search), the swipe starts from the end the user swiped
 * from rather than jumping to an arbitrary entry.
 */
export function stepCandidate(
  candidates: readonly DraftGarment[],
  currentId: string | null | undefined,
  direction: 1 | -1,
): DraftGarment | null {
  if (candidates.length === 0) return null;

  const index = currentId ? candidates.findIndex((item) => item.id === currentId) : -1;
  if (index === -1) {
    return direction === 1 ? candidates[0] : candidates[candidates.length - 1];
  }
  const next = (index + direction + candidates.length) % candidates.length;
  return candidates[next];
}

/**
 * Why the draft cannot be saved yet, or `null` when it can.
 *
 * `'tooManyItems'` is the last check on purpose: a draft that is both over the limit and
 * nameless should say the cheap thing first, and either way the save is refused. Callers
 * ask `draftItemOverflow` for the numbers (`total`, `excess`, `max`) rather than deriving
 * them again, so the message and the refusal can never disagree.
 *
 * This function is the reason no caller may send `draftItemIds` unconditionally: the
 * server's limit is not a filter to apply silently — see `draftItemIds` and round-3 review
 * finding A.
 */
export function draftBlocker(
  draft: OutfitDraft,
  nameIsTooLong: boolean,
): 'empty' | 'tooLong' | 'tooManyItems' | null {
  if (draftItemIds(draft).length === 0) return 'empty';
  if (nameIsTooLong) return 'tooLong';
  if (draftItemOverflow(draft)) return 'tooManyItems';
  return null;
}
