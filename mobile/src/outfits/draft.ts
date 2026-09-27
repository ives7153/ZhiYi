import type { Item, OutfitItem } from '../api/types';
import { OUTFIT_MAX_ITEMS, REQUIRED_SLOTS, SLOTS, slotForType, type SlotKey } from '../api/outfitVocab';

/**
 * The slot draft — the one piece of state the 搭配 screens share, kept out of React so
 * its invariants can be checked without a device.
 *
 * A draft is "one garment per slot, plus anything the round cannot place":
 *
 *  - `selection` holds **at most one** garment per slot key. That is what makes
 *    "左右滑动只替换当前槽位" true by construction: replacing a slot rewrites one key.
 *  - `passthrough` holds garments that arrived from the server inside a saved outfit but
 *    belong to no slot of this round (连衣裙 / 连体衣, and 待分类 items such as `unknown`
 *    or `suit`). They are shown and carried back on save, never dropped: silently
 *    removing a garment during an unrelated rename would be a fabricated edit.
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
 * An `OutfitItem` presented in the `Item` shape the slot row renders.
 *
 * `OutfitItemResponse` deliberately returns a subset (`items.py:...` / the schema in
 * `backend/app/api/outfits.py`): no brand, wear counts or status. Everything absent is
 * filled with an empty value rather than a plausible-looking one, so no field the screen
 * shows can claim something the server never sent. `status` is set to `ready` because a
 * garment inside an outfit is by definition usable; that value is not rendered anywhere.
 */
function outfitItemAsItem(outfitItem: OutfitItem): Item {
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
    created_at: '',
    updated_at: '',
    image_url: outfitItem.image_url ?? '',
    thumbnail_url: outfitItem.thumbnail_url,
    medium_url: null,
    effective_wash_interval: 0,
  };
}

/**
 * The `items` array to send to the server.
 *
 * Slot order first (上衣 → 下装 → 外套 → 鞋子 → 配饰), then the passthrough garments in the
 * order the server gave them. `POST /outfits/suggestions` stores `position` in exactly
 * this array order (`ExternalOutfitService._persist_outfit`), so the round trip is stable.
 *
 * Duplicates are removed because `outfit_items` is keyed on `(outfit_id, item_id)`: the
 * same garment cannot appear twice in one outfit.
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

  return ids.slice(0, OUTFIT_MAX_ITEMS);
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

/** Why the draft cannot be saved yet, or `null` when it can. */
export function draftBlocker(
  draft: OutfitDraft,
  nameIsTooLong: boolean,
): 'empty' | 'tooLong' | null {
  if (draftItemIds(draft).length === 0) return 'empty';
  if (nameIsTooLong) return 'tooLong';
  return null;
}
