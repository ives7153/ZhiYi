/**
 * Round-3 regression test for "这件单品已不在衣橱里" being said without evidence.
 *
 * THE BUG THIS PINS (review finding C)
 * ------------------------------------
 * The detail screen's read-only slot row inferred "this garment is no longer in the wardrobe"
 * from a single fact: the garment was not among the slot's loaded candidates. It never looked
 * at `candidates.truncated` — and that list is capped (`getSlotCandidates` walks
 * `MAX_PAGES_PER_TYPE` = 5 pages of 100 per type). A live, non-archived garment sitting at
 * position 501 of its type was therefore reported to the user as archived.
 *
 * A second, quieter way the same sentence was wrong: candidates are fetched with `type=<the
 * outfit's copy of the type>`, so a garment re-classified in the wardrobe since it was saved
 * falls out of its old slot's list while being perfectly alive.
 *
 * The fix treats the candidate list as evidence in one direction only (a hit proves the
 * garment is live) and settles a miss by asking about that one id
 * (`GET /items/{id}` returns the row whatever its `status`/`is_archived`). The table below is
 * the whole decision table of `src/outfits/garmentAvailability.ts`, including the case that
 * used to produce the false claim.
 *
 * Run: node scripts/verify/garment-availability.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const mobileDir = join(here, '..', '..');

const outDir = mkdtempSync(join(tmpdir(), 'zhiyi-verify-'));
// CommonJS for the same reason as in `outfit-item-limit.mjs`: TypeScript emits the source's
// extensionless relative imports verbatim, and Node's ESM resolver rejects those.
execFileSync(
  'npx',
  [
    'tsc',
    'src/outfits/garmentAvailability.ts',
    // Pinned so the emitted path is deterministic (`outfits/garmentAvailability.js`): without
    // it tsc infers the root from the single input file and emits `garmentAvailability.js`.
    '--rootDir',
    'src',
    '--ignoreConfig',
    '--outDir',
    outDir,
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--skipLibCheck',
  ],
  { cwd: mobileDir, stdio: 'pipe' },
);

const require = createRequire(import.meta.url);
const { garmentAvailability, needsGarmentLookup } = require(
  join(outDir, 'outfits', 'garmentAvailability.js'),
);

let pass = 0;
let fail = 0;
const check = (actual, expected, what) => {
  if (actual === expected) {
    console.log(`  PASS: ${what}`);
    pass += 1;
  } else {
    console.log(`  FAIL: ${what} (expected ${expected}, got ${actual})`);
    fail += 1;
  }
};

/** No garment in the slot: nothing may ever be claimed. */
const empty = { hasGarment: false, candidatesLoaded: true, candidatesTruncated: false, foundInCandidates: false, lookup: { state: 'idle' } };
check(garmentAvailability(empty), 'none', 'an empty slot produces no note at all');
check(
  garmentAvailability({ ...empty, lookup: { state: 'notFound' } }),
  'none',
  'even a 404 says nothing when there is no garment in the slot',
);

console.log('\nPositive evidence: the candidate list contains the garment');
const inList = { hasGarment: true, candidatesLoaded: true, candidatesTruncated: false, foundInCandidates: true, lookup: { state: 'idle' } };
check(garmentAvailability(inList), 'none', 'a garment the non-archived candidate query returned is fine');
check(
  garmentAvailability({ ...inList, lookup: { state: 'error' } }),
  'none',
  'a failed extra lookup cannot override the candidate hit',
);
check(
  garmentAvailability({ ...inList, lookup: { state: 'notFound' } }),
  'none',
  'nor can a stale 404: the hit is the more recent evidence',
);
check(
  needsGarmentLookup({ hasGarment: true, candidatesLoaded: true, foundInCandidates: true }),
  false,
  'no by-id request is made when the list already answered',
);

console.log('\nTHE BUG: truncated list, garment not in it, garment alive');
// The exact reviewed case: >500 garments of one type, the outfit's garment beyond the cap,
// still not archived. `GET /items/{id}` says `ready`.
check(
  garmentAvailability({
    hasGarment: true,
    candidatesLoaded: true,
    candidatesTruncated: true,
    foundInCandidates: false,
    lookup: { state: 'found', status: 'ready', isArchived: false },
  }),
  'none',
  'a truncated candidate list does NOT turn a live garment into "已不在衣橱"',
);
check(
  needsGarmentLookup({ hasGarment: true, candidatesLoaded: true, foundInCandidates: false }),
  true,
  'a miss does trigger the by-id check that settles it',
);

console.log('\nA miss before the answer arrives says nothing');
const pending = {
  hasGarment: true,
  candidatesLoaded: true,
  candidatesTruncated: true,
  foundInCandidates: false,
};
check(
  garmentAvailability({ ...pending, lookup: { state: 'loading' } }),
  'none',
  'while the by-id check is in flight the row shows no warning',
);
check(
  garmentAvailability({ ...pending, lookup: { state: 'idle' } }),
  'none',
  'and it does not guess when the check has not started',
);
check(
  needsGarmentLookup({ hasGarment: true, candidatesLoaded: false, foundInCandidates: false }),
  false,
  'nothing is looked up before the candidate query answers (no warning either)',
);

console.log('\nDefinite answers are reported as such');
check(
  garmentAvailability({ ...pending, lookup: { state: 'notFound' } }),
  'missing',
  'a 404 for the garment id is the only thing that justifies "已不在衣橱"',
);
check(
  garmentAvailability({ ...pending, lookup: { state: 'found', status: 'archived', isArchived: true } }),
  'archived',
  'status archived is reported as 已归档',
);
check(
  garmentAvailability({ ...pending, lookup: { state: 'found', status: 'ready', isArchived: true } }),
  'archived',
  'the is_archived flag alone is enough (the server keeps both)',
);
check(
  garmentAvailability({ ...pending, lookup: { state: 'found', status: 'processing', isArchived: false } }),
  'processing',
  'a garment still being processed is reported as such (validate_item_ownership needs ready)',
);
check(
  garmentAvailability({ ...pending, lookup: { state: 'found', status: 'error', isArchived: false } }),
  'failed',
  'a failed AI pass is reported as such',
);
check(
  garmentAvailability({ ...pending, lookup: { state: 'found', status: 'something-new', isArchived: false } }),
  'unknown',
  'an unrecognized status is not given an invented meaning',
);
check(
  garmentAvailability({
    hasGarment: true,
    candidatesLoaded: true,
    candidatesTruncated: true,
    foundInCandidates: false,
    lookup: { state: 'error' },
  }),
  'unknown',
  'a failed by-id check says "未能确认", never "已不在衣橱"',
);

console.log('\nA complete list that misses the garment is checked too (re-classified type)');
check(
  garmentAvailability({
    hasGarment: true,
    candidatesLoaded: true,
    candidatesTruncated: false,
    foundInCandidates: false,
    lookup: { state: 'found', status: 'ready', isArchived: false },
  }),
  'none',
  'a garment re-classified out of this slot is not called archived',
);

console.log('\nWiring — the screen must ask, not infer');
const screen = readFileSync(join(mobileDir, 'app', 'outfit', '[id].tsx'), 'utf8');
check(
  screen.includes('garmentAvailability('),
  true,
  'the detail screen decides through garmentAvailability()',
);
check(
  screen.includes('needsGarmentLookup('),
  true,
  'and gates the by-id query with needsGarmentLookup()',
);
check(
  screen.includes('useItem(lookupId)'),
  true,
  'the by-id check is GET /items/{id} via the existing useItem hook',
);
check(
  /const notInWardrobe\s*=/.test(screen),
  false,
  'the old `notInWardrobe` guess (id missing from the candidate list) is gone',
);
check(
  screen.includes("case 'missing'"),
  true,
  'the strong sentence is reachable only from the definite verdict',
);
check(
  screen.includes('garmentStatusUnknown'),
  true,
  'and the unknown verdict has its own wording',
);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
