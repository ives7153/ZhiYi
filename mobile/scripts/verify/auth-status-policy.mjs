/**
 * Round-2 regression test for the 422 / auth-failure conflation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Round 1 treated 401, 403 AND 422 as "the credential is unusable" on every
 * endpoint, so any 422 forced a logout. That was defensible in a read-only app
 * whose only 422 came from `/auth/session`, but round 2 adds writes: POST/PATCH
 * /items answer 422 for an ordinary request-body validation failure
 * (`RequestValidationError` in `backend/app/main.py`). Under the old policy a
 * garment name one character too long would log the user out and clear the cache.
 *
 * The rule now has two parts, and this test pins both:
 *   1. 401/403  -> auth failure on ANY endpoint.
 *   2. 422      -> auth failure ONLY on an endpoint that declares
 *                  `credentialChecked: true` (currently just /auth/session).
 *
 * The assertions run against the real `src/api/errors.ts`, compiled by the
 * project's own TypeScript — not against a transcription of it — so the test
 * cannot drift from the implementation.
 *
 * Run: node scripts/verify/auth-status-policy.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const mobileDir = join(here, '..', '..');

// Compile the module under test with the repo's tsc into a scratch dir.
const outDir = mkdtempSync(join(tmpdir(), 'zhiyi-verify-'));
execFileSync(
  'npx',
  [
    'tsc',
    'src/api/errors.ts',
    '--ignoreConfig',
    '--outDir',
    outDir,
    '--module',
    'esnext',
    '--target',
    'es2022',
    '--skipLibCheck',
  ],
  { cwd: mobileDir, stdio: 'pipe' },
);

const { isAuthFailureStatus, isCredentialRejection } = await import(
  pathToFileURL(join(outDir, 'errors.js')).href
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

console.log('isAuthFailureStatus — must NOT include 422');
check(isAuthFailureStatus(401), true, '401 is an auth failure');
check(isAuthFailureStatus(403), true, '403 is an auth failure');
check(isAuthFailureStatus(422), false, '422 alone is NOT an auth failure');
check(isAuthFailureStatus(400), false, '400 is not an auth failure');
check(isAuthFailureStatus(404), false, '404 is not an auth failure');
check(isAuthFailureStatus(500), false, '500 is not an auth failure');

console.log('\nisCredentialRejection — 422 counts only when the credential was checked');
check(
  isCredentialRejection(422, true),
  true,
  '422 on a credential-checking endpoint IS an auth failure (/auth/session)',
);
check(
  isCredentialRejection(422, false),
  false,
  '422 on a normal endpoint is NOT an auth failure (previously logged the user out)',
);
check(isCredentialRejection(401, true), true, '401 an auth failure (checked endpoint)');
check(isCredentialRejection(401, false), true, '401 an auth failure (normal endpoint)');
check(isCredentialRejection(403, true), true, '403 an auth failure (checked endpoint)');
check(isCredentialRejection(403, false), true, '403 an auth failure (normal endpoint)');
check(isCredentialRejection(400, true), false, '400 never an auth failure');
check(isCredentialRejection(409, false), false, '409 duplicate is never an auth failure');

console.log('\nWiring — only /auth/session may opt in');
const read = (rel) => readFileSync(join(mobileDir, 'src', 'api', rel), 'utf8');

const authSource = read('auth.ts');
check(
  (authSource.match(/credentialChecked:\s*true/g) ?? []).length,
  1,
  'exactly one endpoint declares credentialChecked: true',
);
check(
  /getSession[\s\S]*?credentialChecked:\s*true/.test(authSource),
  true,
  'the flag is on getSession (/auth/session)',
);

// Item writes must not opt in, or a bad payload becomes a forced logout.
for (const file of ['itemWrites.ts', 'itemMutations.ts', 'items.ts']) {
  check(
    /credentialChecked/.test(read(file)),
    false,
    `${file} does not declare credentialChecked (item payloads stay non-fatal)`,
  );
}

// The multipart path must classify errors the same way the JSON path does.
const clientSource = read('client.ts');
check(
  /throwForFailure\(response,\s*false\)/.test(clientSource),
  true,
  'requestMultipart classifies failures with credentialChecked=false',
);
check(
  /headers['"]?\]?\s*\[?['"]Content-Type['"]\]?\s*=\s*['"]multipart/.test(clientSource),
  false,
  'requestMultipart must NOT set Content-Type by hand (boundary is set by fetch)',
);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
