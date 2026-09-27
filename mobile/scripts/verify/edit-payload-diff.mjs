/**
 * Round-2 regression test for the edit-form payload.
 *
 * THE BUG THIS PINS
 * -----------------
 * `PATCH /items/{id}` treats a write to `type`, `subtype`, `colors`,
 * `primary_color` or `tags` as a manual classification: the server then sets
 * `tagging_status = "tagged"` and `tagged_by = "manual"` (`TAG_WRITEBACK_FIELDS`
 * in `backend/app/api/items.py`).
 *
 * The first version of the edit form always sent `type: type ?? 'unknown'`, so
 * *every* save — renaming a garment, toggling a favourite, changing a brand —
 * looked like a tagging action. Verified against the live backend:
 *
 *     PATCH {"type":"unknown","name":"Renamed"}
 *       -> tagging_status "tagged", tagged_by "manual"   (wrong)
 *     PATCH {"name":"Renamed"}
 *       -> tagging_status "pending"                      (right)
 *
 * The fix builds a real diff. This test asserts the form still does, by checking
 * the payload builder's invariants in the source, because the failure is silent:
 * nothing errors, the item just quietly claims to have been classified.
 *
 * Run: node scripts/verify/edit-payload-diff.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mobileDir = join(here, '..', '..');
const src = readFileSync(join(mobileDir, 'app', 'item', '[id].tsx'), 'utf8');

let pass = 0;
let fail = 0;
const check = (cond, what) => {
  if (cond) {
    console.log(`  PASS: ${what}`);
    pass += 1;
  } else {
    console.log(`  FAIL: ${what}`);
    fail += 1;
  }
};

// Isolate the submit() body so the explanatory comment can't satisfy an assertion.
const submitStart = src.indexOf('const submit = useCallback(');
const submitEnd = src.indexOf('}, [onSave, onCancel, item, type, name, brand, colors_, favorite]);');
const submit = submitStart >= 0 && submitEnd > submitStart ? src.slice(submitStart, submitEnd) : '';

check(submit.length > 0, 'the edit form still has a submit() to inspect');

// --- the bug itself ----------------------------------------------------------
check(
  !/type:\s*type\s*\?\?\s*'unknown'/.test(submit),
  'submit() does NOT default `type` to the literal "unknown"',
);
check(
  !/onSave\(\s*\{/.test(submit),
  'submit() does not pass a literal object to onSave (it must build a diff first)',
);

// --- the diff ---------------------------------------------------------------
check(
  /const fields: ItemUpdateFields = \{\}/.test(submit),
  'submit() starts from an empty payload and adds only what changed',
);
check(
  /if \(type !== null && type !== originalType\) fields\.type = type/.test(submit),
  '`type` is sent only when it actually changed (and never as a null/empty value)',
);
check(
  /if \(trimmedName !== \(item\.name \?\? ''\)\) fields\.name =/.test(submit),
  '`name` is sent only when it changed',
);
check(
  /if \(favorite !== item\.favorite\) fields\.favorite = favorite/.test(submit),
  '`favorite` is sent only when it changed',
);
check(
  /sameStringSet\(colors_, originalColors\)/.test(submit),
  '`colors` uses set comparison so a reorder is not mistaken for a change',
);
check(
  /Object\.keys\(fields\)\.length === 0/.test(submit) && /onCancel\(\)/.test(submit),
  'an unchanged form closes instead of firing a no-op PATCH',
);

// --- the helper -------------------------------------------------------------
check(
  /function sameStringSet\(/.test(src),
  'the order-insensitive colour comparison exists',
);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
