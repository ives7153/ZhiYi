/**
 * Round-2 regression test for the multipart body contract.
 *
 * WHY THIS EXISTS
 * ---------------
 * The first implementation appended the classic React Native idiom
 * `form.append('image', { uri, name, type })`. Under Expo SDK 57 that throws
 * `Unsupported FormDataPart implementation` **inside `fetch`**, so no request is
 * ever sent: the UI hangs and the server logs nothing. It is invisible from both
 * ends and produced a real, shipped defect that only a device run caught.
 *
 * The supported shape is a `Blob` — specifically expo-file-system's `File`, which
 * implements `Blob` and whose `bytes()` Expo's serializer calls. This test pins
 * that contract by reading Expo's own serializer out of the installed package, so
 * if a future SDK changes which part shapes are accepted, this fails loudly here
 * instead of silently on a device.
 *
 * Run: node scripts/verify/formdata-part-contract.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mobileDir = join(here, '..', '..');

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

// --- 1. Expo's serializer must exist and must NOT accept a uri part ----------
const convertPath = join(
  mobileDir,
  'node_modules',
  'expo',
  'src',
  'winter',
  'fetch',
  'convertFormData.ts',
);
const convert = readFileSync(convertPath, 'utf8');

// The reject branch has to be the FALLBACK, not merely present: `string`, `Blob` and
// `{ bytes() }` are accepted first and the throw is what remains.
//
// This replaces an earlier assertion that read "the implementation never touches `.uri`"
// after stripping comments. `convertFormData.ts` only ever mentioned `uri` in a comment, so
// that check was a tautology: it passed no matter what the code did, and gave the impression
// this contract was covered when it was not (audit finding B-7). Asserting ORDER is
// falsifiable — move the throw above the accepted shapes and this fails.
const throwIndex = convert.indexOf('Unsupported FormDataPart implementation');
const stringIndex = convert.indexOf("typeof entry === 'string'");
const blobIndex = convert.indexOf('entry instanceof Blob');
const bytesIndex = convert.indexOf("'bytes' in entry");
check(
  throwIndex > 0,
  'Expo fetch rejects unrecognised FormData parts (the failure mode we hit)',
);
check(
  stringIndex > 0 && stringIndex < throwIndex,
  'a `string` part is accepted before the reject branch',
);
check(
  blobIndex > 0 && blobIndex < throwIndex && bytesIndex > 0 && bytesIndex < throwIndex,
  'Blob and `{ bytes() }` parts are accepted before the reject branch (so the throw is a fallback)',
);
check(
  /entry instanceof Blob/.test(convert),
  'Expo fetch handles `Blob` parts',
);
check(
  /'bytes' in entry/.test(convert),
  'Expo fetch handles parts exposing `bytes()`',
);

// --- 2. The app must not use the uri idiom anywhere -------------------------
const itemWrites = readFileSync(join(mobileDir, 'src', 'api', 'itemWrites.ts'), 'utf8');
check(
  !/uri:\s*photo\.uri/.test(itemWrites),
  'itemWrites.ts does not build a `{ uri }` form part',
);
check(
  /new FsFile\(photo\.uri\)/.test(itemWrites),
  'itemWrites.ts wraps the local file in expo-file-system File (a Blob)',
);
check(
  /form\.append\(field,\s*file as unknown as Blob,\s*photo\.name\)/.test(itemWrites),
  'the Blob part is appended with the filename argument (server validates its extension)',
);

// --- 3. expo-file-system's File must actually satisfy the Blob shape --------
const fileTs = readFileSync(
  join(mobileDir, 'node_modules', 'expo-file-system', 'src', 'File.ts'),
  'utf8',
);
check(
  /class File extends .*implements Blob/.test(fileTs),
  'expo-file-system File declares `implements Blob`',
);
check(/async arrayBuffer\(\)/.test(fileTs), 'File provides arrayBuffer()');
check(/\bbytes\(\)/.test(fileTs), 'File provides bytes() (what Expo calls)');
// `type` and `size` come from the native base class the JS File extends, so they
// are declared in the native typings rather than in File.ts.
const nativeTypes = readFileSync(
  join(
    mobileDir,
    'node_modules',
    'expo-file-system',
    'build',
    'internal',
    'NativeFileSystem.types.d.ts',
  ),
  'utf8',
);
check(/\btype:\s*string/.test(nativeTypes), 'File exposes a mime type (native declaration)');
check(/\bsize:\s*number/.test(nativeTypes), 'File exposes a size');

// --- 4. The client must not set Content-Type by hand ------------------------
const client = readFileSync(join(mobileDir, 'src', 'api', 'client.ts'), 'utf8');
check(
  !/['"]Content-Type['"]\s*[:=]\s*['"]multipart/.test(client),
  'client.ts never sets multipart/form-data by hand (fetch must add the boundary)',
);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
