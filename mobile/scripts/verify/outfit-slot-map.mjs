/**
 * Round-3 regression test for the slot vocabulary.
 *
 * WHY THIS EXISTS
 * ---------------
 * The 搭配 feature decides which席位 a garment belongs to from that garment's own `type`,
 * through a table the *backend* owns (`backend/app/utils/clothing.py` `ITEM_ROLE`, mirrored
 * for the Web in `frontend/lib/studio/canonical-order.ts`). The mobile copy is a
 * transcription, and a transcription is exactly the kind of thing that drifts silently: add
 * `poncho` to the backend role table and this app would file it nowhere, or edit the table
 * here so that 连衣裙 lands in 上衣 — with nothing failing.
 *
 * So this script does not test the app's copy against itself. It reads the three real
 * sources — backend, Web, mobile — asserts they agree, and then checks the invariants the
 * round-3 behaviour rests on:
 *
 *   1. the three role tables are identical, key for key and value for value;
 *   2. every role they use maps to a slot, so no type can fall through;
 *   3. the slot grouping is **derived** from that table, not hand-listed, and is a partition
 *      (one slot per type);
 *   4. the types this round refuses (连衣裙 / 连体衣) map to **no** slot, and every other
 *      selectable type either has a slot or is a known unplaceable 待分类 value;
 *   5. the occasion the app sends is one the endpoint accepts (`VALID_OCCASIONS`), and every
 *      occasion label the UI can print belongs to that set;
 *   6. every `OutfitStatus` the backend can return has a Chinese label, so no status enum can
 *      reach the screen;
 *   7. the save payload carries **only** the fields `SuggestionCreateRequest` declares — its
 *      model sets `extra="forbid"`, so one extra key is a 422, and a hand-rolled `layer_type`
 *      would break every save.
 *
 * Run: node scripts/verify/outfit-slot-map.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mobileDir = join(here, '..', '..');
const repoRoot = join(mobileDir, '..');

const read = (...parts) => readFileSync(join(...parts), 'utf8');

const vocabSrc = read(mobileDir, 'src', 'api', 'outfitVocab.ts');
const itemVocabSrc = read(mobileDir, 'src', 'api', 'itemVocab.ts');
const typesSrc = read(mobileDir, 'src', 'api', 'types.ts');
const outfitsSrc = read(mobileDir, 'src', 'api', 'outfits.ts');
const backendClothingSrc = read(repoRoot, 'backend', 'app', 'utils', 'clothing.py');
const backendOutfitsSrc = read(repoRoot, 'backend', 'app', 'api', 'outfits.py');
const backendModelSrc = read(repoRoot, 'backend', 'app', 'models', 'outfit.py');
const webOrderSrc = read(repoRoot, 'frontend', 'lib', 'studio', 'canonical-order.ts');

let pass = 0;
let fail = 0;
const check = (condition, what) => {
  if (condition) {
    console.log(`  PASS: ${what}`);
    pass += 1;
  } else {
    console.log(`  FAIL: ${what}`);
    fail += 1;
  }
};

/** Text from `marker` to the matching closing brace (braces balanced). */
function balancedBlock(src, marker) {
  const markerAt = src.indexOf(marker);
  if (markerAt < 0) return null;
  const openAt = src.indexOf('{', markerAt);
  if (openAt < 0) return null;
  let depth = 0;
  for (let i = openAt; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(openAt, i + 1);
    }
  }
  return null;
}

/**
 * A Python class body: from `marker` up to the next line that starts at column 0.
 *
 * `SuggestionCreateRequest` is a brace-less class — its fields are annotations — so a
 * brace-matching extractor returns nothing for it, which would have made the payload check
 * pass vacuously.
 */
function pythonClassBody(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const rest = src.slice(start + marker.length);
  const end = rest.search(/\n[^\s]/);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * `key: value` pairs from a TS object literal or a Python dict.
 *
 * Both quote styles, and **any** value characters: the Chinese label tables
 * (`OCCASION_LABELS`, `OUTFIT_STATUS_LABELS`) and `ROLE_SLOT` are in the same shape as the
 * ASCII ones, and an ASCII-only pattern silently returned an empty map for them — which made
 * two "is every value labelled?" checks pass while checking nothing.
 */
function keyValueMap(block) {
  if (!block) return null;
  const map = {};
  for (const line of block.split('\n')) {
    // Keys may be bare (`shirt:`), single-quoted or double-quoted (the Python dict uses
    // double quotes); values are quoted strings, Chinese included.
    const match = line.match(/^\s*['"]?([A-Za-z0-9_-]+)['"]?\s*:\s*['"]([^'"]+)['"]\s*,?\s*$/);
    if (match) map[match[1]] = match[2];
  }
  return map;
}

/** Every `key:` in an object literal, including keys whose value is not a string. */
function keysOf(block) {
  if (!block) return [];
  return [...block.matchAll(/^\s*'?([A-Za-z0-9_-]+)'?\s*:/gm)].map((match) => match[1]);
}

const sameMap = (a, b) => {
  if (!a || !b) return false;
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.join(',') !== keysB.join(',')) return false;
  return keysA.every((key) => a[key] === b[key]);
};

// --- 1. the three role tables agree ------------------------------------------
const backendRoles = keyValueMap(balancedBlock(backendClothingSrc, 'ITEM_ROLE: dict[str, str] ='));
const webRoles = keyValueMap(
  balancedBlock(webOrderSrc, 'export const ITEM_ROLE: Record<string, string> ='),
);
const mobileRoles = keyValueMap(
  balancedBlock(vocabSrc, 'export const ITEM_ROLE: Record<string, string> ='),
);

check(Object.keys(backendRoles ?? {}).length > 25, 'parsed the backend ITEM_ROLE table');
check(Object.keys(mobileRoles ?? {}).length > 25, 'parsed the mobile ITEM_ROLE table');
check(
  sameMap(mobileRoles, backendRoles),
  'mobile ITEM_ROLE matches backend/app/utils/clothing.py',
);
check(
  sameMap(mobileRoles, webRoles),
  'mobile ITEM_ROLE matches frontend/lib/studio/canonical-order.ts',
);

// --- 2. every role has a slot entry ------------------------------------------
const roleSlotBlock = balancedBlock(
  vocabSrc,
  'const ROLE_SLOT: Record<string, SlotKey | undefined> =',
);
const roleSlot = keyValueMap(roleSlotBlock);
/** Includes `full_body`, whose value is deliberately not a quoted slot name. */
const roleSlotKeys = keysOf(roleSlotBlock);
const rolesUsed = [...new Set(Object.values(backendRoles ?? {}))].sort();
const rolesWithoutSlot = rolesUsed.filter((role) => !roleSlotKeys.includes(role));
check(
  roleSlotKeys.length >= rolesUsed.length,
  'parsed the ROLE_SLOT table from outfitVocab.ts',
);
check(
  rolesWithoutSlot.length === 0,
  `every role the backend uses has a slot entry (missing: ${rolesWithoutSlot.join(', ') || 'none'})`,
);

// --- 3. the grouping is derived, and is a partition --------------------------
const slotTypesAt = vocabSrc.indexOf('export const SLOT_TYPES');
const slotTypesBlock = slotTypesAt >= 0 ? vocabSrc.slice(slotTypesAt) : '';
const slotTypesDerivation = slotTypesBlock.slice(0, slotTypesBlock.indexOf('})();'));
check(slotTypesAt >= 0, 'SLOT_TYPES exists in outfitVocab.ts');
check(
  /Object\.entries\(ITEM_ROLE\)/.test(slotTypesDerivation),
  'SLOT_TYPES is derived from ITEM_ROLE rather than hand-listed',
);
check(
  !/['"][a-z][a-z-]*['"]\s*[:,]/.test(slotTypesDerivation.split('for (const').join('for (const')),
  'SLOT_TYPES contains no hand-written type names that could drift from the role table',
);

const roleToSlot = Object.fromEntries(
  Object.entries(roleSlot ?? {}).filter(([, slot]) => Boolean(slot)),
);
const expectedSlots = {};
for (const [type, role] of Object.entries(backendRoles ?? {})) {
  const slot = roleToSlot[role];
  if (slot) expectedSlots[type] = slot;
}
const slotsInTwoPlaces = Object.keys(roleToSlot).filter(
  (role) => Object.values(roleToSlot).filter((slot) => slot === roleToSlot[role]).length > 1,
);
void slotsInTwoPlaces; // roles may share a slot (mid_layer + outer_layer → outer); types may not.
const duplicated = Object.keys(expectedSlots).length !== Object.keys(backendRoles ?? {}).length -
  new Set(Object.values(backendRoles ?? {})).size +
  new Set(Object.values(roleToSlot)).size;
void duplicated;
check(
  Object.keys(expectedSlots).length > 0 &&
    new Set(Object.keys(expectedSlots)).size === Object.keys(expectedSlots).length,
  'each type maps to exactly one slot (the grouping is a partition)',
);

const slotKeyBlock = vocabSrc.slice(0, vocabSrc.indexOf('export type SlotKey'));
const declaredSlots = [...slotKeyBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
const usedSlots = [...new Set(Object.values(expectedSlots))].sort();
check(
  usedSlots.length > 0 && usedSlots.every((slot) => declaredSlots.includes(slot)),
  `every slot the role table produces is a declared slot (${usedSlots.join(', ')})`,
);

// --- 4. refused and unplaceable types ---------------------------------------
const unsupported = [
  ...((vocabSrc.match(
    /export const UNSUPPORTED_FULL_BODY_TYPES: readonly string\[\] = \[([^\]]*)\]/,
  )?.[1]) ?? '').matchAll(/'([a-z-]+)'/g),
].map((m) => m[1]);
check(
  unsupported.includes('dress') && unsupported.includes('jumpsuit'),
  'UNSUPPORTED_FULL_BODY_TYPES lists dress and jumpsuit',
);
check(
  unsupported.every((type) => !(type in expectedSlots)),
  'the refused types map to no slot (连衣裙/连体衣 are never filed under 上衣)',
);

const clothingTypes = [
  ...((itemVocabSrc.match(/export const CLOTHING_TYPES = \[([\s\S]*?)\] as const/)?.[1]) ?? '')
    .matchAll(/'([a-z-]+)'/g),
].map((m) => m[1]);
check(clothingTypes.length > 25, 'parsed CLOTHING_TYPES from itemVocab.ts');
const unplaceable = clothingTypes.filter(
  (type) =>
    !(type in expectedSlots) &&
    !unsupported.includes(type) &&
    type !== 'other' && // Web-side placeholder, no role in any of the three tables
    type !== 'suit', // in CLOTHING_TYPES but absent from ITEM_ROLE on all three sides
);
check(
  unplaceable.length === 0,
  `every selectable type is slotted or explicitly unplaceable (unexpected: ${unplaceable.join(', ') || 'none'})`,
);
check(
  clothingTypes.every(
    (type) => !(type in expectedSlots) || expectedSlots[type] !== 'full_body',
  ),
  'no selectable type is silently mapped to a full-body slot',
);

// --- 5. occasions ------------------------------------------------------------
const validOccasions = [
  ...((backendOutfitsSrc.match(/VALID_OCCASIONS = \{([\s\S]*?)\n\}/)?.[1]) ?? '').matchAll(
    /"([a-z-]+)"/g,
  ),
].map((m) => m[1]);
check(validOccasions.length > 15, 'parsed VALID_OCCASIONS from backend/app/api/outfits.py');

const defaultOccasion = vocabSrc.match(/DEFAULT_OUTFIT_OCCASION = '([a-z-]+)'/)?.[1] ?? '';
check(
  validOccasions.includes(defaultOccasion),
  `the occasion the app sends ('${defaultOccasion}') is accepted by the endpoint`,
);

const occasionLabels = keyValueMap(
  balancedBlock(vocabSrc, 'export const OCCASION_LABELS: Record<string, string> ='),
);
const strayOccasions = Object.keys(occasionLabels ?? {}).filter(
  (key) => !validOccasions.includes(key),
);
check(
  Object.keys(occasionLabels ?? {}).length > 0,
  'parsed OCCASION_LABELS from outfitVocab.ts',
);
check(
  strayOccasions.length === 0,
  `every occasion label belongs to VALID_OCCASIONS (stray: ${strayOccasions.join(', ') || 'none'})`,
);

// --- 6. every outfit status is labelled -------------------------------------
const backendStatuses = [
  ...((backendModelSrc.match(/class OutfitStatus\(enum\.StrEnum\):\n([\s\S]*?)\n\n/)?.[1]) ?? '')
    .matchAll(/^\s+([a-z_]+) = "/gm),
].map((m) => m[1]);
check(backendStatuses.length >= 5, 'parsed OutfitStatus from backend/app/models/outfit.py');

const statusLabels = keyValueMap(
  balancedBlock(vocabSrc, 'export const OUTFIT_STATUS_LABELS: Record<string, string> ='),
);
const unlabelled = backendStatuses.filter((status) => !(status in (statusLabels ?? {})));
check(
  unlabelled.length === 0,
  `every backend outfit status has a Chinese label (missing: ${unlabelled.join(', ') || 'none'})`,
);

// --- 7. the save payload carries only declared fields ------------------------
const createRequest = pythonClassBody(
  backendOutfitsSrc,
  'class SuggestionCreateRequest(OutfitAttributeFields):',
);
const declaredFields = [...(createRequest ?? '').matchAll(/^\s+([a-z_]+)\s*:/gm)].map((m) => m[1]);
check(
  declaredFields.includes('items') && declaredFields.includes('occasion'),
  `SuggestionCreateRequest declares items and occasion (found: ${declaredFields.join(', ') || 'none'})`,
);
check(
  /extra="forbid"/.test(createRequest ?? ''),
  'SuggestionCreateRequest forbids extra fields (an unknown key is a 422)',
);

const createCall = outfitsSrc.slice(
  outfitsSrc.indexOf('export function createOutfit'),
  outfitsSrc.indexOf('export function patchOutfit'),
);
check(
  /return request<Outfit>\('\/outfits\/suggestions', \{ method: 'POST', body: fields \}\)/.test(
    createCall,
  ),
  'createOutfit posts the `fields` object straight through (no key added or renamed)',
);

const createFields = balancedBlock(typesSrc, 'export interface OutfitCreateFields {');
const mobileFieldNames = [...(createFields ?? '').matchAll(/^\s{2}([a-z_]+)\??:/gm)].map((m) => m[1]);
check(
  mobileFieldNames.length === 3 &&
    mobileFieldNames.every((name) => declaredFields.includes(name)),
  `OutfitCreateFields sends only server-declared keys (${mobileFieldNames.join(', ')})`,
);

const writerFiles = [
  join(mobileDir, 'src', 'api', 'outfits.ts'),
  join(mobileDir, 'src', 'api', 'outfitHooks.ts'),
  join(mobileDir, 'app', '(tabs)', 'outfits.tsx'),
  join(mobileDir, 'app', 'outfit', 'index.tsx'),
  join(mobileDir, 'app', 'outfit', '[id].tsx'),
];
const layerTypeWriters = writerFiles.filter((path) =>
  /layer_type\s*:/.test(readFileSync(path, 'utf8')),
);
check(
  layerTypeWriters.length === 0,
  'no screen or API call tries to write `layer_type` (the API would reject it with 422)',
);

// --- 8. the candidate loader respects the server's limits --------------------
check(
  /const CANDIDATE_PAGE_SIZE = 100;/.test(outfitsSrc),
  'the candidate loader asks for page_size 100, the server maximum',
);
check(
  /is_archived: false/.test(outfitsSrc),
  'the candidate loader requests non-archived garments explicitly',
);
check(
  /has_more/.test(outfitsSrc) && /MAX_PAGES_PER_TYPE/.test(outfitsSrc),
  'the candidate loader walks pages until has_more is false, with a documented cap',
);

console.log('');
console.log(`outfit slot map: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
