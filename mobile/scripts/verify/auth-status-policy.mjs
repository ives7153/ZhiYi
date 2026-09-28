/**
 * Regression test for the auth-status policy, in two parts.
 *
 * PART 1 (round 2): 422 must not log the user out on a normal endpoint.
 * ----------------------------------------------------------------
 * Round 1 treated 401, 403 AND 422 as "the credential is unusable" on every
 * endpoint, so any 422 forced a logout. Round 2 adds writes: POST/PATCH /items
 * answer 422 for an ordinary request-body validation failure
 * (`RequestValidationError` in `backend/app/main.py`). Under the old policy a
 * garment name one character too long would log the user out and clear the cache.
 *
 * PART 2 (round 3, review finding D): 403 must not log the user out either.
 * ----------------------------------------------------------------------
 * The backend answers 401 for every credential rejection (`decode_token` and
 * `get_current_user` in `backend/app/utils/auth.py`). Its 403s mean "you are
 * authenticated, but this action is not allowed" and carry
 * `detail = {error_code, message}`: `OUTFIT_ITEM_OWNERSHIP` for a garment that is
 * not yours or not `ready` (`backend/app/api/outfits.py:632-639,1479-1486`),
 * `NOT_IN_FAMILY`, `Admin access required`, `Access denied`. Round 3 turned every
 * one of those into an `AuthError`, so `PATCH /outfits/{id}` answering 403 for a
 * garment archived after it was picked logged the user out, cleared the query
 * cache and threw away the unsent edit — and the save screen's own 403 message
 * (which exists) could never run.
 *
 * The only 403 that is a credential failure is the one `get_current_user` raises
 * for an inactive account (`"User account is inactive"`, a *plain string* detail),
 * and it is recognized by that exact detail.
 *
 * The rule now has three parts, and this test pins all of them:
 *   1. 401                  -> auth failure on ANY endpoint.
 *   2. 403 `{error_code…}`  -> a business error, NOT an auth failure, on a normal
 *                              endpoint; still fatal when it is the credential
 *                              check itself that failed (`credentialChecked`).
 *   3. 422                  -> auth failure ONLY on an endpoint that declares
 *                              `credentialChecked: true` (currently /auth/session).
 *
 * The assertions run against the real `src/api/errors.ts`, compiled by the
 * project's own TypeScript — not against a transcription of it — so the test
 * cannot drift from the implementation. The wiring half reads the real sources.
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

const { isAuthFailureStatus, isCredentialRejection, isAccountLevelForbidden } = await import(
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

/** The body a business 403 carries, copied from `backend/app/api/outfits.py`. */
const OUTFIT_ITEM_OWNERSHIP = {
  detail: { error_code: 'OUTFIT_ITEM_OWNERSHIP', message: 'One or more items do not belong to you' },
};
/** The body the inactive-account 403 carries, copied from `backend/app/utils/auth.py`. */
const ACCOUNT_INACTIVE = { detail: 'User account is inactive' };

console.log('isAuthFailureStatus — 401 only');
check(isAuthFailureStatus(401), true, '401 is an auth failure');
check(isAuthFailureStatus(403), false, '403 alone is NOT an auth failure (round-3 finding D)');
check(isAuthFailureStatus(422), false, '422 alone is NOT an auth failure');
check(isAuthFailureStatus(400), false, '400 is not an auth failure');
check(isAuthFailureStatus(404), false, '404 is not an auth failure');
check(isAuthFailureStatus(500), false, '500 is not an auth failure');

console.log('\nisCredentialRejection — a business 403 keeps the session');
check(
  isCredentialRejection(403, false, OUTFIT_ITEM_OWNERSHIP),
  false,
  '403 OUTFIT_ITEM_OWNERSHIP on a normal endpoint is a business error, not a logout',
);
check(
  isCredentialRejection(403, false, { detail: { error_code: 'NOT_IN_FAMILY', message: 'nope' } }),
  false,
  '403 NOT_IN_FAMILY on a normal endpoint is a business error',
);
check(
  isCredentialRejection(403, false, 'Access denied'),
  false,
  'a plain 403 detail the server never uses for accounts is still a business error',
);
check(
  isCredentialRejection(403, false, ACCOUNT_INACTIVE),
  true,
  '403 "User account is inactive" IS an auth failure (the credential cannot be used)',
);
check(
  isCredentialRejection(403, false, undefined),
  false,
  'a 403 with no readable body is not treated as a credential failure',
);

console.log('\nisCredentialRejection — 401 and 422');
check(isCredentialRejection(401, true), true, '401 an auth failure (checked endpoint)');
check(isCredentialRejection(401, false), true, '401 an auth failure (normal endpoint)');
check(isCredentialRejection(401, false, OUTFIT_ITEM_OWNERSHIP), true, '401 wins over any body');
check(
  isCredentialRejection(422, true),
  true,
  '422 on a credential-checking endpoint IS an auth failure (/auth/session)',
);
check(
  isCredentialRejection(422, false),
  false,
  '422 on a normal endpoint is NOT an auth failure (round-2 fix: no logout on a bad payload)',
);
check(isCredentialRejection(400, true), false, '400 never an auth failure');
check(isCredentialRejection(409, false), false, '409 duplicate is never an auth failure');

console.log('\nThe credential-checking endpoints keep all three statuses');
check(
  isCredentialRejection(403, true, ACCOUNT_INACTIVE),
  true,
  '403 on /auth/session is fatal (account inactive)',
);
check(
  isAccountLevelForbidden(403, ACCOUNT_INACTIVE),
  true,
  'the inactive-account 403 is recognized by its own detail',
);
check(
  isAccountLevelForbidden(401, ACCOUNT_INACTIVE),
  false,
  'the account-level check is about 403 only',
);

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

// The classification must see the body, or a business 403 cannot be told apart.
const clientSource = read('client.ts');
check(
  /isCredentialRejection\(response\.status,\s*credentialChecked,\s*parsed\)/.test(clientSource),
  true,
  'client.ts passes the parsed body into isCredentialRejection',
);
check(
  (clientSource.match(/isCredentialRejection\(/g) ?? []).length,
  2,
  'both the JSON and the multipart path classify through the same predicate',
);

// The multipart path must classify errors through the same predicate, and must not be the one
// place where a dead credential is tolerated: an upload is dispatched to an endpoint that only
// answers 401 / inactive-account 403 for credential problems, so it always triggers the global
// reaction. (`request` keeps this configurable for the login screen's own `/auth/session` probe.)
check(
  /throwForFailure\(response,\s*\{\s*credentialChecked:\s*false,\s*triggerAuthFailure:\s*true\s*\}\)/.test(
    clientSource,
  ),
  true,
  'requestMultipart classifies with credentialChecked=false and always triggers the auth handler',
);
check(
  /options\.triggerAuthFailure\)\s*onAuthFailure\?\.\(\)/.test(clientSource),
  true,
  'throwForFailure actually calls the auth-failure handler',
);
check(
  /headers['"]?\]?\s*\[?['"]Content-Type['"]\]?\s*=\s*['"]multipart/.test(clientSource),
  false,
  'requestMultipart must NOT set Content-Type by hand (boundary is set by fetch)',
);

console.log('\nWiring — a business 403 must stay actionable on the 搭配 screens');
for (const [file, label] of [
  [join('app', '(tabs)', 'outfits.tsx'), 'the builder'],
  [join('app', 'outfit', '[id].tsx'), 'the editor'],
]) {
  const source = readFileSync(join(mobileDir, file), 'utf8');
  check(
    /instanceof ApiError && \w+\.status === 403/.test(source),
    true,
    `${label} still handles a 403 as an ApiError (that branch is reachable again)`,
  );
}

// Only an AuthError may clear credentials.
const authContext = readFileSync(join(mobileDir, 'src', 'auth', 'AuthContext.tsx'), 'utf8');
check(
  /if \(error instanceof AuthError\) \{\s*await clearAllCredentials\(\);/.test(authContext),
  true,
  'AuthContext clears stored credentials only after an AuthError',
);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
