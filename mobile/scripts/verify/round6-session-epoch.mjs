/**
 * Round-6 verification for session epoch isolation and stale-response rejection (Spec §4.7 & §6.E):
 *
 *   1. User A initiates a slow GET or POST/multipart request.
 *   2. User A logs out (`setAccessToken(null)`) and User B logs in (`setAccessToken('token-b')`).
 *   3. In-flight requests from User A receive an immediate abort signal.
 *   4. Even if the underlying transport ignores the abort signal and resolves later with User A's
 *      payload, `client.ts` checks `requestEpoch !== sessionEpoch` and discards the stale response
 *      as an `AbortError`, never returning User A's data into User B's session.
 *   5. `tokenOverride` (used by `logoutServer(tokenToRevoke)`) revokes User A's token without
 *      touching User B's active `accessToken`.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const mobileDir = join(here, '..', '..');

process.env.EXPO_PUBLIC_API_URL = 'http://backend.invalid';

const outDir = mkdtempSync(join(tmpdir(), 'zhiyi-r6-verify-'));
execFileSync(
  'npx',
  [
    'tsc',
    'src/api/client.ts',
    '--rootDir',
    'src',
    '--ignoreConfig',
    '--outDir',
    outDir,
    '--types',
    'node',
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
  request,
  requestMultipart,
  setAccessToken,
  getAccessToken,
  getSessionEpoch,
} = require(join(outDir, 'api', 'client.js'));

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

const originalFetch = globalThis.fetch;

console.log('1. Session epoch increments on login, logout, and account switch');
const epoch0 = getSessionEpoch();
setAccessToken('token-user-a');
const epochA = getSessionEpoch();
check(epochA > epoch0, true, 'setting User A token advances sessionEpoch');
setAccessToken('token-user-a');
check(getSessionEpoch(), epochA, 'repeating the same token does not advance sessionEpoch');
setAccessToken(null);
const epochLogout = getSessionEpoch();
check(epochLogout > epochA, true, 'logging out advances sessionEpoch');
setAccessToken('token-user-b');
const epochB = getSessionEpoch();
check(epochB > epochLogout, true, 'logging in as User B advances sessionEpoch again');

console.log('\n2. Slow request from User A is aborted and its late response is discarded after switching to User B');
{
  setAccessToken('token-user-a');
  let resolveSlowA;
  let signalAbortedOnSwitch = false;

  globalThis.fetch = (url, init) => {
    const authHeader = init.headers?.Authorization;
    if (authHeader === 'Bearer token-user-a') {
      init.signal.addEventListener('abort', () => {
        signalAbortedOnSwitch = true;
      });
      // Simulate a transport that ignores abort and resolves later anyway with User A's private data
      return new Promise((resolve) => {
        resolveSlowA = () =>
          resolve({
            status: 200,
            ok: true,
            text: async () => JSON.stringify({ items: [{ id: 'secret-item-of-user-a' }] }),
          });
      });
    }
    if (authHeader === 'Bearer token-user-b') {
      return Promise.resolve({
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ items: [{ id: 'clean-item-of-user-b' }] }),
      });
    }
    throw new Error(`Unexpected auth header: ${authHeader}`);
  };

  // User A starts slow request
  const promiseA = request('/items');

  // User A logs out and User B logs in before User A's request finishes
  setAccessToken(null);
  setAccessToken('token-user-b');

  check(signalAbortedOnSwitch, true, 'User A in-flight fetch signal was immediately aborted on logout');

  // User B fetches items
  const resB = await request('/items');
  check(resB.items[0].id, 'clean-item-of-user-b', 'User B receives User B data cleanly');

  // Now User A's slow network response finally arrives
  resolveSlowA();
  let errorA = null;
  try {
    await promiseA;
  } catch (err) {
    errorA = err;
  }
  check(errorA !== null, true, 'User A late response rejected instead of resolving');
  check(errorA?.name, 'AbortError', 'User A late response is classified as AbortError (discarded)');
}

console.log('\n3. Slow multipart upload from User A is discarded if it arrives after switching to User B');
{
  setAccessToken('token-user-a');
  let resolveUploadA;

  globalThis.fetch = () =>
    new Promise((resolve) => {
      resolveUploadA = () =>
        resolve({
          status: 201,
          ok: true,
          text: async () => JSON.stringify({ id: 'uploaded-by-a' }),
        });
    });

  const uploadPromiseA = requestMultipart('/items', new FormData());
  setAccessToken('token-user-b');
  resolveUploadA();

  let uploadError = null;
  try {
    await uploadPromiseA;
  } catch (err) {
    uploadError = err;
  }
  check(uploadError !== null, true, 'User A late upload response rejected after account switch');
  check(uploadError?.name, 'AbortError', 'User A late upload response classified as AbortError');
}

console.log('\n4. tokenOverride revokes old token on logout without disturbing active token');
{
  setAccessToken('token-user-b');
  let capturedAuth = null;
  globalThis.fetch = (url, init) => {
    capturedAuth = init.headers?.Authorization;
    return Promise.resolve({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ detail: 'revoked' }),
    });
  };

  await request('/auth/logout', {
    method: 'POST',
    tokenOverride: 'token-user-a',
    triggerAuthFailure: false,
  });

  check(capturedAuth, 'Bearer token-user-a', 'logout request used tokenOverride for User A');
  check(getAccessToken(), 'token-user-b', 'User B active token remained intact');
}

globalThis.fetch = originalFetch;

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
