import React, { useCallback } from 'react';

import type { Item } from '../api/types';
import { REQUIRED_SLOTS, SLOT_LABELS, type SlotKey } from '../api/outfitVocab';
import { useSlotCandidates } from '../api/outfitHooks';
import { stepCandidate } from '../outfits/draft';
import { SlotCard } from './SlotCard';

/**
 * One slot, wired to the server.
 *
 * Its own component because the candidate query is a hook: the builder and the editor each
 * render five slots, and calling a hook once per element of a module-level constant array
 * is legal but easy to break later. Here the array is always the same five slots in the
 * same order and each row owns exactly one query.
 *
 * `useSlotCandidates(slot, '')` is the unsearched list — what the swipe walks, and what the
 * "衣橱里还没有…" judgement is made from. The picker panel runs its own, search-aware query:
 * sharing one key would make typing in the panel reorder the slot behind it.
 *
 * The two ways to change a slot stay distinct all the way up to the screen:
 *
 *  - `onStep` (swipe / the 上一件/下一件 buttons) delivers the garment the list landed on;
 *  - `onOpenPicker` (pressing the tile) asks the screen to open the bottom panel.
 *
 * Collapsing them into one callback with a sentinel value made the two paths
 * indistinguishable, which is exactly the bug this shape avoids.
 */
export function ConnectedSlotRow({
  slot,
  garment,
  onSelect,
  onOpenPicker,
  note,
}: {
  slot: SlotKey;
  garment: Item | null;
  /** Receives the garment a swipe landed on. */
  onSelect: (item: Item) => void;
  onOpenPicker: () => void;
  /** Extra line under the row (e.g. this garment is no longer in the wardrobe). */
  note?: string;
}) {
  const { data, isLoading, isError, error, refetch } = useSlotCandidates(slot, '');
  const candidates = data?.items ?? [];

  const onStep = useCallback(
    (direction: 1 | -1) => {
      const next = stepCandidate(candidates, garment?.id ?? null, direction);
      // `null` means the slot has no candidates at all: leave the draft untouched rather
      // than clearing a slot the user cannot refill.
      if (!next) return;
      const match = candidates.find((candidate) => candidate.id === next.id);
      if (match) onSelect(match);
    },
    [candidates, garment?.id, onSelect],
  );

  const onRetry = useCallback(() => {
    void refetch();
  }, [refetch]);

  return (
    <SlotCard
      label={SLOT_LABELS[slot]}
      required={REQUIRED_SLOTS.includes(slot)}
      garment={garment}
      candidates={candidates}
      isLoading={isLoading}
      error={isError ? (error ?? new Error('candidates failed')) : null}
      truncated={Boolean(data?.truncated)}
      note={note}
      onPick={onOpenPicker}
      onStep={onStep}
      onRetry={onRetry}
    />
  );
}
