#!/usr/bin/env python3
"""Recompute an outfit's slots from the garment types the server stored.

    curl ... /outfits/<id> | outfit-slots.py <path/to/outfitVocab.ts>

Prints one `slot:garment name` line per filled slot, in the client's own slot order, e.g.

    top:r3-上装-140233
    bottom:r3-半裙-140233
    shoes:r3-运动鞋-140233

WHY THIS IS NOT PART OF THE HARNESS
-----------------------------------
The mobile app decides which席位 a garment belongs to from that garment's `type`, through the
`ITEM_ROLE` table the backend owns. A device assertion ("the 上衣 row shows this name") is only
meaningful next to an independent answer to "which slot *should* that garment be in", and the
only honest way to produce that answer is to run the same mapping over the server's own copy of
the outfit — not to ask the app what it thinks.

The mapping is read out of `src/api/outfitVocab.ts` rather than duplicated here, so this cannot
silently disagree with the app about the table itself; what it checks is that the app applied
the table to the stored data. The three tables (mobile/backend/Web) are compared directly by
`scripts/verify/outfit-slot-map.mjs`.
"""

import json
import re
import sys


def block(source: str, marker: str) -> str:
    start = source.index(marker)
    open_at = source.index("{", start)
    depth = 0
    for index in range(open_at, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[open_at : index + 1]
    raise SystemExit(f"could not parse {marker}")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: outfit-slots.py <path/to/outfitVocab.ts>", file=sys.stderr)
        return 2

    source = open(argv[1], encoding="utf-8").read()
    roles = dict(
        re.findall(r"^\s*'?([\w-]+)'?:\s*'([\w-]+)'", block(source, "export const ITEM_ROLE"), re.M)
    )
    role_slot = dict(
        re.findall(r"^\s*([\w-]+):\s*'([\w-]+)'", block(source, "const ROLE_SLOT"), re.M)
    )
    # The slot order comes from the `SLOTS` array itself. Reading it through `block()` would
    # find the first `{` *after* the marker — which is `SLOT_LABELS` — and yield the Chinese
    # labels instead of the slot keys, so nothing would ever match a slot and this script
    # would print an empty list and look like it had agreed with the screen.
    slots_line = re.search(r"export const SLOTS = \[([^\]]*)\]", source)
    order = re.findall(r"'(\w+)'", slots_line.group(1)) if slots_line else []

    outfit = json.load(sys.stdin)
    by_slot: dict[str, dict] = {}
    for item in outfit.get("items") or []:
        slot = role_slot.get(roles.get(item.get("type") or "", ""))
        by_slot.setdefault(slot, item) if slot else None

    for slot in order:
        item = by_slot.get(slot)
        if item:
            print(f"{slot}:{item.get('name') or ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
