/**
 * Round-3 regression test for the silent truncation of an outfit's item list.
 *
 * THE BUG THIS PINS (review finding A)
 * ------------------------------------
 * `draftItemIds` used to end with `return ids.slice(0, OUTFIT_MAX_ITEMS)`. The detail screen
 * sends exactly that array to `PATCH /outfits/{id}`, and `StudioService.patch_outfit` deletes
 * and recreates every `outfit_items` row from it. So for an outfit already holding 20 garments
 * (the server's `max_length=20`), adding one more made the client send 20 ids, the server
 * rebuilt from those 20 — and the 20th garment silently lost its association with the outfit
 * while the screen reported "保存成功". No message, no error, nothing to notice later except a
 * missing garment.
 *
 * The assertion that matters below is the concrete case the review used: 20 `shirt`s (the
 * first claims 上衣, the rest go to 其他单品) plus one `pants` in the empty 下装 slot. All 21
 * ids must still be there, the overflow must be reported, and the save must be refused.
 *
 * Run: node scripts/verify/outfit-item-limit.mjs
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
// Compiled as CommonJS on purpose: `draft.ts` imports `../api/outfitVocab` without a file
// extension, which TypeScript emits verbatim, and Node's ESM resolver refuses an extensionless
// specifier. CommonJS resolution appends `.js` itself, so the compiled module loads as-is and
// the test runs the real source rather than a copy of it.
execFileSync(
  'npx',
  [
    'tsc',
    'src/outfits/draft.ts',
    // Pinned so the emitted layout is deterministic (`outfits/draft.js`, `api/outfitVocab.js`).
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
const draft = require(join(outDir, 'outfits', 'draft.js'));
const vocab = require(join(outDir, 'api', 'outfitVocab.js'));

const {
  draftBlocker,
  draftFromOutfitItems,
  draftItemIds,
  draftItemOverflow,
  passthroughReason,
  withoutPassthrough,
} = draft;

let pass = 0;
let fail = 0;
const check = (actual, expected, what) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  PASS: ${what}`);
    pass += 1;
  } else {
    console.log(`  FAIL: ${what} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    fail += 1;
  }
};

/** An `OutfitItem` as `GET /outfits/{id}` returns it — only the fields the draft reads. */
const outfitItem = (id, type, position) => ({
  id,
  type,
  position,
  name: id,
  image_path: null,
  thumbnail_path: null,
  image_url: null,
  thumbnail_url: null,
  subtype: null,
  colors: [],
  primary_color: null,
});

const MAX = vocab.OUTFIT_MAX_ITEMS;
check(MAX, 20, 'the server limit being guarded is 20 items (max_length=20)');

console.log('\nThe reviewed case: 20 garments + 1 more');
// Exactly the stored outfit from the review: 20 shirts, so `i0` claims 上衣 and `i1`..`i19`
// have no slot and sit in 其他单品. The user then picks a 下装 for the empty slot — the case
// that used to send 20 ids and delete `i19` from the outfit while reporting success.
const stored = Array.from({ length: MAX }, (_, index) => outfitItem(`i${index}`, 'shirt', index));
const draftWithOneMore = draftFromOutfitItems([...stored, outfitItem('pants1', 'pants', MAX)]);

check(draftWithOneMore.selection.top.id, 'i0', 'the first shirt claims 上衣');
check(draftWithOneMore.passthrough.length, MAX - 1, 'the other 19 shirts are 其他单品');
check(
  draftWithOneMore.selection.bottom.id,
  'pants1',
  'the newly chosen 下装 claims the empty slot, which is what takes the draft to 21',
);

const ids = draftItemIds(draftWithOneMore);
check(ids.length, MAX + 1, 'draftItemIds returns all 21 ids — nothing is dropped silently');
check(ids.includes('i19'), true, 'the 20th shirt (the one the old code deleted) is still sent');
check(ids.includes('pants1'), true, 'the newly chosen 下装 is sent too');
check(
  draftItemOverflow(draftWithOneMore),
  { total: 21, excess: 1, max: MAX },
  'the overflow reports 21/20 with one excess garment',
);
check(
  draftBlocker(draftWithOneMore, false),
  'tooManyItems',
  'the save is refused instead of being sent from a shortened list',
);

console.log('\nFitting drafts are unaffected');
const exactlyTwenty = draftFromOutfitItems(stored);
check(exactlyTwenty.passthrough.length, MAX - 1, 'the 20-garment outfit rebuilds as before');
check(draftItemIds(exactlyTwenty).length, MAX, '20 ids for a 20-garment outfit');
check(draftItemOverflow(exactlyTwenty), null, 'no overflow at exactly the limit');
check(draftBlocker(exactlyTwenty, false), null, 'a 20-garment outfit may be saved');

const small = draftFromOutfitItems([outfitItem('a', 'shirt', 0), outfitItem('b', 'pants', 1)]);
check(draftItemIds(small), ['a', 'b'], 'a small outfit sends its garments in slot order');
check(draftItemOverflow(small), null, 'a small outfit has no overflow');

console.log('\nRemoval is the way out, and it is exact');
// What the editor's 从搭配中移除 does: drop one 其他单品 row. Removing `i19` (a passthrough
// shirt, not the one in the slot) takes the draft back to 20 and the save is allowed again.
const afterRemoval = withoutPassthrough(draftWithOneMore, 'i19');
check(draftItemIds(afterRemoval).length, MAX, 'removing one 其他单品 garment brings it back to the limit');
check(afterRemoval.selection.bottom.id, 'pants1', 'the slot garment is untouched by the removal');
check(draftItemOverflow(afterRemoval), null, 'and clears the overflow');
check(draftBlocker(afterRemoval, false), null, 'so the save is allowed again');
check(
  withoutPassthrough(draftWithOneMore, 'i19').passthrough.length,
  MAX - 2,
  'removing 其他单品 garment i19 drops exactly that row',
);

console.log('\nDe-duplication still holds (outfit_items is keyed on (outfit_id, item_id))');
const duplicated = {
  selection: { top: { id: 'dup' }, bottom: { id: 'dup' } },
  passthrough: [outfitItem('dup', 'shirt', 0)],
};
check(draftItemIds(duplicated), ['dup'], 'the same garment is sent once however often it appears');
check(draftItemOverflow(duplicated), null, 'a duplicate cannot fake an overflow');

console.log('\n其他单品 rows say which case they are');
check(passthroughReason({ type: 'shirt' }), 'sameSlotDuplicate', 'a second 上衣 is a same-slot conflict');
check(passthroughReason({ type: 'dress' }), 'unsupportedFullBody', '连衣裙 is unsupported this round');
check(passthroughReason({ type: 'jumpsuit' }), 'unsupportedFullBody', '连体衣 as well');
check(passthroughReason({ type: 'unknown' }), 'unclassified', '待分类 stays 待分类');
check(passthroughReason({ type: 'suit' }), 'unclassified', 'suit has no slot this round either');

console.log('\nSource guard: no silent truncation may come back');
const source = readFileSync(join(mobileDir, 'src', 'outfits', 'draft.ts'), 'utf8');
check(
  /slice\(0,\s*OUTFIT_MAX_ITEMS\)/.test(source),
  false,
  'draft.ts contains no slice(0, OUTFIT_MAX_ITEMS)',
);
check(
  /const total = draftItemIds\(draft\)\.length;/.test(source),
  true,
  'the overflow is measured from the ids that would actually be sent',
);

// Both save paths must consult the limit before calling the API.
for (const file of [
  join('app', '(tabs)', 'outfits.tsx'),
  join('app', 'outfit', '[id].tsx'),
]) {
  const screen = readFileSync(join(mobileDir, file), 'utf8');
  check(
    screen.includes('draftItemOverflow('),
    true,
    `${file} checks the limit before saving`,
  );
  check(
    screen.includes('saveTooManyItems'),
    true,
    `${file} tells the user the numbers instead of trimming the list`,
  );
}

const editor = readFileSync(join(mobileDir, 'app', 'outfit', '[id].tsx'), 'utf8');
check(
  editor.includes('withoutPassthrough(') && editor.includes('removeFromOutfit'),
  true,
  'the editor offers an explicit per-garment removal as the way out',
);
/**
 * A passthrough garment can become the slot garment: picking, for its slot, the very garment
 * shown in 其他单品 leaves `selection[slot].id === item.id`. The row must not then claim
 * "同席位已有另一件" (false) or offer a removal that only drops the redundant copy (a button
 * that appears to do nothing). The list is filtered by the current selection, and the request
 * was already correct because `draftItemIds` de-duplicates.
 */
check(
  /\(shown\?\.passthrough \?\? \[\]\)\.filter\(/.test(editor) && editor.includes('!selectedIds.has(item.id)'),
  true,
  '其他单品 excludes the garment currently sitting in a slot',
);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
