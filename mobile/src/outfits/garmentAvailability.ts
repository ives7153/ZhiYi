/**
 * Whether a garment stored inside a saved outfit is still in the wardrobe — and, when the
 * client cannot know that, saying so instead of guessing.
 *
 * WHY THIS EXISTS
 * ---------------
 * Round 3's detail screen inferred "这件单品已不在衣橱里（可能已归档）" from one fact: the
 * garment did not appear in its slot's candidate list. That list is **not** a complete
 * account of the wardrobe — `getSlotCandidates` walks the server one type at a time and
 * stops after `MAX_PAGES_PER_TYPE` (5) pages of 100 rows, reporting `truncated` when it
 * does. A still-live garment that happens to sit beyond that cut-off was therefore
 * presented to the user as archived (round-3 review finding C).
 *
 * A `type` change is a second way the same sentence can be wrong: the candidates for 上衣
 * are fetched with `type=shirt` etc. for the five types the *outfit's* copy of the garment
 * maps to, so a garment re-classified in the wardrobe since is missing from that list while
 * being perfectly alive.
 *
 * So the candidate list is treated as evidence in **one direction only**: when it contains
 * the garment, the garment is in the wardrobe (the query asks for non-archived rows
 * explicitly). When it does not, the question is answered by asking about that garment
 * directly — `GET /items/{id}` returns the row whatever its `status` and
 * `is_archived` (`ItemService.get_by_id` filters on id and owner only), so the answer is
 * definite instead of inferred: 404 means this account has no such garment, 200 carries the
 * status to report.
 *
 * Three outcomes are deliberately distinct, because they are not the same fact:
 *   - `missing`   — the by-id lookup answered 404: the garment is gone (deleted, or never
 *                   this account's). A definite statement is allowed here.
 *   - `archived`  — the by-id lookup answered 200 with `status: archived`.
 *   - `unknown`   — the lookup itself failed, or has not answered yet. Written as "未能确认",
 *                   never as "已不在衣橱".
 *
 * Everything here is a pure function of the inputs, so the decision table can be checked
 * without a device (see `scripts/verify/garment-availability.mjs`).
 */

/** What `GET /items/{id}` has answered so far, if it was needed at all. */
export type GarmentLookup =
  /** Not needed (the candidate list answered) or not started yet. */
  | { state: 'idle' }
  | { state: 'loading' }
  /** 200: the garment exists for this account, with the status the server stored. */
  | { state: 'found'; status: string; isArchived: boolean }
  /** 404 `Item not found`: deleted, or never this account's garment. */
  | { state: 'notFound' }
  /** The lookup could not be completed (network, 5xx, timeout). */
  | { state: 'error' };

/** What the screen should say about one garment, if anything. */
export type GarmentAvailability =
  /** Still in the wardrobe and usable, or nothing is known yet: say nothing. */
  | 'none'
  | 'archived'
  | 'processing'
  | 'failed'
  /** Definite: the server answered 404 for this id. */
  | 'missing'
  /** The client could not establish it. Never rendered as "已不在衣橱". */
  | 'unknown';

export interface GarmentAvailabilityInput {
  /** The slot currently holds a garment (nothing to check otherwise). */
  hasGarment: boolean;
  /** The slot's candidate query answered successfully (`isSuccess`). */
  candidatesLoaded: boolean;
  /** ...and reported that it stopped before the type was exhausted. */
  candidatesTruncated: boolean;
  /** The garment is one of the rows that query returned. */
  foundInCandidates: boolean;
  /** Result of the by-id check, when the candidate list could not decide. */
  lookup: GarmentLookup;
}

/**
 * True when the candidate list cannot decide the question, so `GET /items/{id}` has to.
 *
 * Both a truncated list and a complete list that does not contain the garment lead here:
 * the second case is the re-classified-garment case described above, and asking about one
 * id is cheap. Before the candidate query has answered there is nothing to look up — the
 * screen shows no warning at all until then.
 */
export function needsGarmentLookup(input: {
  hasGarment: boolean;
  candidatesLoaded: boolean;
  foundInCandidates: boolean;
}): boolean {
  return input.hasGarment && input.candidatesLoaded && !input.foundInCandidates;
}

/**
 * The note to render for one garment.
 *
 * `candidatesTruncated` is not read here on purpose: the answer never depends on how much
 * of the candidate list arrived, only on whether the garment was in it and on what the
 * by-id question answered. It is part of the input type so callers pass the whole picture
 * and a reviewer can see it was considered.
 */
export function garmentAvailability(input: GarmentAvailabilityInput): GarmentAvailability {
  if (!input.hasGarment) return 'none';

  // Positive evidence: the query lists non-archived garments, so a hit settles it.
  if (input.candidatesLoaded && input.foundInCandidates) return 'none';

  switch (input.lookup.state) {
    case 'found':
      return availabilityFromStatus(input.lookup.status, input.lookup.isArchived);
    case 'notFound':
      return 'missing';
    case 'error':
      return 'unknown';
    case 'idle':
    case 'loading':
      // Nothing to say yet: a warning is not an answer.
      return 'none';
    default:
      return 'unknown';
  }
}

/**
 * The item statuses that matter for a slot, from `ItemStatus` (`backend/app/models/item.py`)
 * and from what `validate_item_ownership` accepts.
 *
 * `archived` is the archival flag as well as a status: the server keeps both, so either one
 * means the garment left the wardrobe. Only `ready` garments may be put into an outfit
 * (a `processing` or `error` one is refused with 403 `OUTFIT_ITEM_OWNERSHIP`), which is why
 * those two are reported rather than passed over.
 */
function availabilityFromStatus(status: string, isArchived: boolean): GarmentAvailability {
  if (isArchived || status === 'archived') return 'archived';
  if (status === 'ready') return 'none';
  if (status === 'processing') return 'processing';
  if (status === 'error') return 'failed';
  // A status this build does not know: do not invent a meaning for it.
  return 'unknown';
}
