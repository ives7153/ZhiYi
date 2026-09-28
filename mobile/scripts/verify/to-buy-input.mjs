/**
 * Round-4 checks for the 待购 input rules and for the draft's to-buy detection.
 *
 * WHAT THIS PINS
 * --------------
 * Two places where round 4 could quietly get a fact wrong, both testable off-device
 * because they are pure functions rather than screens:
 *
 *  1. **Money and links (`src/api/toBuy.ts`).** A reference price is decimal money: the
 *     typed text is validated and passed through, and it is never parsed into a JS
 *     `number` (`199.99` is not exactly representable, and a price that silently changes
 *     by a cent is a lie about money). An empty field must mean "not filled in" — `null`
 *     on the wire, which the server stores as NULL, which is not 0. A product link is
 *     only accepted as an absolute http/https URL, because the screen hands it to the
 *     system browser on a tap: `javascript:` or `intent:` would otherwise be a one-tap
 *     way to run something that is not a shop page.
 *  2. **Ownership through the draft (`src/outfits/draft.ts`).** A garment rebuilt from a
 *     saved outfit keeps the ownership the server reported, and `draftHasToBuy` decides
 *     whether what is being built is a 试搭. If `outfitItemAsItem` dropped the field (the
 *     easy way to "fix" a type error), every reopened 试搭 would look like an ordinary
 *     outfit of owned garments — the marker would silently disappear and the "cannot be
 *     worn" rule would be stated for the wrong outfits.
 *
 * The modules under test are compiled from the real source with the project's own `tsc`,
 * not re-implemented here.
 *
 * Run: node scripts/verify/to-buy-input.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const mobileDir = join(here, '..', '..');

const outDir = mkdtempSync(join(tmpdir(), 'zhiyi-verify-tobuy-'));
// CommonJS, like the other round-3/4 verify scripts: TypeScript emits the source's
// extensionless relative imports verbatim and Node's ESM resolver rejects those.
execFileSync(
  'npx',
  [
    'tsc',
    'src/api/toBuy.ts',
    'src/outfits/draft.ts',
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
const {
  TO_BUY,
  OWNED,
  isToBuy,
  isOwned,
  parseReferencePrice,
  normalizeStoredPrice,
  formatReferencePrice,
  isHttpUrl,
  parseSourceUrl,
  sourceUrlHost,
} = require(join(outDir, 'api', 'toBuy.js'));
const {
  emptyDraft,
  draftFromOutfitItems,
  draftHasToBuy,
  draftToBuyGarmentIds,
  draftItemIds,
  toDraftGarment,
} = require(join(outDir, 'outfits', 'draft.js'));

let pass = 0;
let fail = 0;
const check = (actual, expected, what) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS: ${what}`);
    pass += 1;
  } else {
    console.log(`  FAIL: ${what}\n        expected ${e}\n        got      ${a}`);
    fail += 1;
  }
};

console.log('== reference price: accepted, and never reshaped as a float ==');
check(parseReferencePrice('199.99'), { ok: true, value: '199.99', kind: 'amount' }, '199.99 passes through unchanged');
check(parseReferencePrice('  299  '), { ok: true, value: '299.00', kind: 'amount' }, 'a whole number gains the column scale, whitespace trimmed');
check(parseReferencePrice('199.9'), { ok: true, value: '199.90', kind: 'amount' }, '199.9 is stored as 199.90');
check(parseReferencePrice('0'), { ok: true, value: '0.00', kind: 'amount' }, '0 is a valid price (free is a price)');
check(parseReferencePrice(''), { ok: true, value: null, kind: 'empty' }, 'an empty field means "not filled in" -> null');
check(parseReferencePrice('   '), { ok: true, value: null, kind: 'empty' }, 'whitespace only is also empty');
check(parseReferencePrice('99999999.99').ok, true, 'the largest value the column holds is accepted');

console.log('== reference price: rejected shapes (and no silent rounding) ==');
for (const bad of ['-1', '1.234', '1.2345', 'abc', '1e3', '1,999', '+5', '199.', '.5', '999999999', '1 99']) {
  check(parseReferencePrice(bad).ok, false, `"${bad}" is refused`);
}
check(/两位小数/.test(parseReferencePrice('1.234').message), true, 'the 2-decimal rule has its own message');

console.log('== display helpers ==');
check(formatReferencePrice('199.9'), '¥199.90', 'a stored decimal renders with both decimals');
check(formatReferencePrice(199.9), '¥199.90', 'a numeric JSON value renders the same way');
check(formatReferencePrice(null), '', 'an unfilled price renders as empty, never as ¥0');
check(normalizeStoredPrice('88'), '88.00', 'normalize pads to the stored scale');

console.log('== product link: http/https only, empty is allowed ==');
check(parseSourceUrl(''), { ok: true, value: null }, 'an empty link means "not provided"');
check(parseSourceUrl('https://shop.example.com/p/1?a=1'), { ok: true, value: 'https://shop.example.com/p/1?a=1' }, 'a full https link is kept verbatim');
check(parseSourceUrl('http://127.0.0.1:8000/x').ok, true, 'an http link is accepted');
for (const bad of ['javascript:alert(1)', 'ftp://example.com/x', 'shop.example.com/p/1', 'http://', 'https:///p', 'intent://x', 'http://a b/']) {
  check(parseSourceUrl(bad).ok, false, `"${bad}" is refused`);
}
// The scheme check is case-insensitive on purpose: `new URL('HTTPS://x')` and Python's
// `urlparse` both normalise it, so refusing the upper-case spelling would reject a link
// the phone can open perfectly well.
check(isHttpUrl('HTTPS://SHOP.EXAMPLE.COM'), true, 'an upper-case scheme is still http/https');

console.log('== link display ==');
check(sourceUrlHost('https://shop.example.com/p/1'), 'shop.example.com', 'the host is shown, not the whole URL');
check(sourceUrlHost(null), '', 'no link -> nothing to show');

console.log('== garment ownership helpers ==');
check(isToBuy({ ownership: TO_BUY }), true, 'a to_buy garment reads as 待购');
check(isToBuy({ ownership: OWNED }), false, 'an owned garment does not');
check(isToBuy({}), false, 'a missing field (an old cached row) is treated as owned, not as 待购');
check(isOwned(null), true, 'null is not 待购');

console.log('== the draft carries the server\'s ownership ==');
const toBuyOutfitItem = {
  id: 'a',
  type: 'shirt',
  subtype: null,
  name: '想买的衬衫',
  primary_color: 'white',
  colors: ['white'],
  image_path: 'u/a.jpg',
  thumbnail_path: 'u/a-thumb.jpg',
  layer_type: null,
  position: 0,
  image_url: '/api/v1/images/u/a.jpg',
  thumbnail_url: '/api/v1/images/u/a-thumb.jpg',
  ownership: TO_BUY,
};
const ownedOutfitItem = { ...toBuyOutfitItem, id: 'b', type: 'pants', name: '已有的裤子', position: 1, ownership: OWNED };

const trialDraft = draftFromOutfitItems([toBuyOutfitItem, ownedOutfitItem]);
check(draftHasToBuy(trialDraft), true, 'an outfit with one 待购 garment is a 试搭');
check(draftToBuyGarmentIds(trialDraft), ['a'], 'the 待购 garment is listed by id');
check(draftItemIds(trialDraft).length, 2, 'the owned garment is still part of the draft (nothing is dropped)');

const ownedDraft = draftFromOutfitItems([ownedOutfitItem]);
check(draftHasToBuy(ownedDraft), false, 'an outfit of owned garments is not a 试搭');
check(draftToBuyGarmentIds(ownedDraft), [], 'and has no 待购 garment');
check(draftHasToBuy(emptyDraft()), false, 'an empty draft is not a 试搭');

const rebuilt = draftFromOutfitItems([toBuyOutfitItem]).selection.top;
check(rebuilt.ownership, TO_BUY, 'a garment rebuilt from a saved outfit keeps 待购 (marker cannot disappear on reopen)');
check(toDraftGarment(toBuyOutfitItem).ownership, TO_BUY, 'toDraftGarment keeps ownership for the slot row marker');

console.log('== source assertions: the screens use the rules above ==');
const read = (relative) => readFileSync(join(mobileDir, relative), 'utf8');
const toBuyTab = read('app/(tabs)/to-buy.tsx');
check(/ownership: TO_BUY/.test(toBuyTab), true, 'the 待购 list asks the server for ownership=to_buy');
check(/useItemTypes\(TO_BUY\)/.test(toBuyTab), true, 'its category counts are the 待购 counts');
check(/to-buy\/\$\{item\.id\}/.test(toBuyTab), true, 'a tile opens the 待购 detail route');

const wardrobe = read('app/(tabs)/index.tsx');
check(/ownership: OWNED/.test(wardrobe), true, 'the wardrobe list states ownership=owned');
check(/useItemTypes\(OWNED\)/.test(wardrobe), true, 'the wardrobe category chips count owned garments only');

const detail = read('app/to-buy/[id].tsx');
check(/useDeleteItem\(itemId, TO_BUY\)/.test(detail), true, 'the 待购 detail deletes with the to_buy guard');
check(/purchaseItem\.mutateAsync\(\)/.test(detail), true, 'it marks a purchase through POST /items/{id}/purchase');
check(!/purchase_price/.test(detail), true, 'it never writes the reference price into the paid price');

const picker = read('src/components/ItemPickerSheet.tsx');
check(/allowToBuy/.test(picker) && /pickerScopeToBuy/.test(picker), true, 'the panel offers the 已拥有 / 待购 switch');
check(/isToBuy\(item\)/.test(picker), true, 'every un-bought tile is marked 待购');

const newItem = read('app/item/new.tsx');
check(/mode === 'toBuy'/.test(newItem), true, 'the add screen has a 待购 mode');
check(/ownership: TO_BUY/.test(newItem), true, 'and sends ownership=to_buy for it');
check(/skip_ai: isToBuyMode \? Boolean\(type\) : false/.test(newItem), true, 'a categorised 待购 garment is ready to be trialled immediately');

const builder = read('app/(tabs)/outfits.tsx');
check(/slotForType\(trialItem\.type\)/.test(builder), true, 'a 试搭 places the 待购 garment by its own type, never a guessed slot');
check(/draftHasToBuy/.test(builder), true, 'the 试搭 label comes from the garments, not from a mode flag');

const savedList = read('app/outfit/index.tsx');
check(/contains_to_buy/.test(savedList), true, 'the saved list renders the server-computed 试搭·含待购 flag');

const outfitDetail = read('app/outfit/[id].tsx');
check(/contains_to_buy/.test(outfitDetail), true, 'the outfit detail reads the same server flag');
check(/allowToBuy=\{Boolean\(outfit\?\.contains_to_buy\)\}/.test(outfitDetail), true, 'only a 试搭 offers 待购 candidates while editing');

const invalidations = read('src/api/invalidations.ts');
check(/slot-candidates/.test(invalidations) && /outfit/.test(invalidations), true, 'a purchase invalidates candidates and outfit markers, not just the current page');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
