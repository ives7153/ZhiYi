/**
 * Round-3 regression test for "the write failed, so nothing was stored".
 *
 * THE BUG THIS PINS (review finding B)
 * ------------------------------------
 * `client.ts` marked only an `AbortError` as ambiguous (`timedOut: true`); every other `fetch`
 * rejection became `NetworkError(timedOut: false)`, and the save screens read that as
 * "一定没写入" and offered a plain retry. The review's simulation showed the gap: make the
 * server commit and then let `fetch` throw `TypeError('Network request failed')`, and the app
 * tells the user the save failed while the outfit exists — and `POST /outfits/suggestions` has
 * no idempotency key, so retrying creates a second one.
 *
 * A failure to read the response body was not even classified: it escaped as a bare
 * `TypeError` from a `response.text()` that sat outside every `try`.
 *
 * The fix distinguishes the one thing the client can know from the one it cannot:
 *   - `outcomeUnknown: false` ONLY when the request provably never went out (no API base URL);
 *   - `outcomeUnknown: true` for everything else, including the body-read failure — the
 *     headers arrived, so the server certainly received the request.
 *
 * This test drives the **real** `src/api/client.ts` (compiled by the project's own tsc) with a
 * stubbed global `fetch`, so the classification under test is the shipping one.
 *
 * Run: node scripts/verify/write-outcome-uncertainty.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const mobileDir = join(here, '..', '..');

// The API base URL is read at module load (`src/config/env.ts`), so it must be set first.
process.env.EXPO_PUBLIC_API_URL = 'http://backend.invalid';

const outDir = mkdtempSync(join(tmpdir(), 'zhiyi-verify-'));
// CommonJS for the same reason as in the other round-3 scripts: TypeScript emits the source's
// extensionless relative imports verbatim.
execFileSync(
  'npx',
  [
    'tsc',
    'src/api/client.ts',
    // Pinned so the emitted layout is deterministic (`api/client.js`, `config/env.js`).
    '--rootDir',
    'src',
    '--ignoreConfig',
    '--outDir',
    outDir,
    // `src/config/env.ts` reads `process.env`, so the Node globals have to be in scope.
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
const clientPath = join(outDir, 'api', 'client.js');
const { request, requestMultipart, setAuthFailureHandler } = require(clientPath);
const { ApiError, AuthError, NetworkError } = require(join(outDir, 'api', 'errors.js'));

let pass = 0;
let fail = 0;
const check = (actual, expected, what) => {
  const ok = actual === expected;
  if (ok) {
    console.log(`  PASS: ${what}`);
    pass += 1;
  } else {
    console.log(`  FAIL: ${what} (expected ${expected}, got ${actual})`);
    fail += 1;
  }
};

/**
 * Runs one write against a stubbed transport and returns what the caller would have caught.
 *
 * `kind` picks the real client entry point under test: `request` (JSON) or `requestMultipart`
 * (the upload path). Both are wrapped identically so the two can be compared on the same facts
 * — the classification and the auth-callback count must not differ between them.
 */
async function attemptWrite(transport, options = {}, kind = 'json') {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (...args) => {
    fetchCalls += 1;
    return transport(...args);
  };
  try {
    const value =
      kind === 'multipart'
        ? await requestMultipart('/items', new FormData(), options)
        : await request('/outfits/suggestions', {
            method: 'POST',
            body: { items: ['a'] },
            ...options,
          });
    return { thrown: false, value, fetchCalls };
  } catch (error) {
    return {
      thrown: true,
      error,
      name: error?.name,
      status: error?.status,
      detail: error?.detail,
      timedOut: error?.timedOut,
      outcomeUnknown: error?.outcomeUnknown,
      fetchCalls,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** A response the client can read, with whatever status the test needs. */
const jsonResponse = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body),
});

/**
 * Counts how many times the client asked for a logout while running `body`.
 *
 * The handler is the real integration point `AuthContext` registers, so counting its calls is
 * a direct test of "does this failure end the session" rather than of a status code.
 */
async function countLogouts(body) {
  let calls = 0;
  setAuthFailureHandler(() => {
    calls += 1;
  });
  try {
    const result = await body();
    return { calls, result };
  } finally {
    setAuthFailureHandler(null);
  }
}

console.log('A write that survives the server but not the network is UNCERTAIN');
const droppedConnection = await attemptWrite(async () => {
  // The shape React Native/Expo produce for "the connection was lost" — and for "never
  // connected": the two are indistinguishable from JavaScript, which is the whole point.
  throw new TypeError('Network request failed');
});
check(droppedConnection.thrown, true, 'the write rejects');
check(droppedConnection.name, 'NetworkError', 'it is classified as a transport failure');
check(droppedConnection.timedOut, false, 'it is NOT a timeout (the old code stopped here)');
check(
  droppedConnection.outcomeUnknown,
  true,
  'but the outcome IS unknown, so the screen must say so instead of "未保存"',
);
check(droppedConnection.fetchCalls, 1, 'the request really was dispatched');

console.log('\nA response whose body never arrives is UNCERTAIN too');
const truncatedBody = await attemptWrite(async () => ({
  status: 201,
  ok: true,
  // The headers arrived, so the server received the request; the body then failed.
  text: async () => {
    throw new TypeError('terminated');
  },
}));
check(truncatedBody.thrown, true, 'the successful-looking write still rejects');
check(truncatedBody.name, 'NetworkError', 'a body-read failure is a transport failure');
check(
  truncatedBody.outcomeUnknown,
  true,
  'the server answered, so the write may already be stored',
);

console.log('\nA timeout is UNCERTAIN (unchanged behaviour, now explicit)');
const timedOut = await attemptWrite(
  (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const abort = new Error('Aborted');
        abort.name = 'AbortError';
        reject(abort);
      });
    }),
  { timeoutMs: 20 },
);
check(timedOut.name, 'NetworkError', 'a timeout is a transport failure');
check(timedOut.timedOut, true, 'and it is marked as one');
check(timedOut.outcomeUnknown, true, 'a timed-out write may have been stored');

console.log('\nA caller cancellation is still a cancellation, not a fault');
const controller = new AbortController();
const cancelled = await attemptWrite(
  (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const abort = new Error('Aborted');
        abort.name = 'AbortError';
        reject(abort);
      });
      controller.abort();
    }),
  { signal: controller.signal, timeoutMs: 5_000 },
);
check(cancelled.name, 'AbortError', 'the caller gets its own abort back, unwrapped');

console.log('\nOnly a provably undispatched request may claim "nothing was stored"');
// A missing API base URL is the one failure that happens before `fetch` is called. Run it in a
// child process, because `src/config/env.ts` reads the variable once at module load.
const probe = [
  'const { request } = require(process.env.CLIENT_PATH);',
  'let fetchCalls = 0;',
  'globalThis.fetch = () => { fetchCalls += 1; return Promise.resolve({ status: 200, ok: true, text: async () => "{}" }); };',
  '(async () => {',
  '  try {',
  "    await request('/outfits/suggestions', { method: 'POST', body: { items: ['a'] } });",
  "    console.log(JSON.stringify({ thrown: false, fetchCalls }));",
  '  } catch (error) {',
  '    console.log(JSON.stringify({',
  '      thrown: true,',
  '      name: error.name,',
  '      outcomeUnknown: error.outcomeUnknown,',
  '      status: error.status ?? null,',
  '      fetchCalls,',
  '    }));',
  '  }',
  '})();',
].join('\n');

const childOutput = execFileSync(process.execPath, ['-e', probe], {
  env: { ...process.env, EXPO_PUBLIC_API_URL: '', CLIENT_PATH: clientPath },
  encoding: 'utf8',
});
const undispatched = JSON.parse(childOutput.trim().split('\n').pop());
check(undispatched.thrown, true, 'a request without a base URL fails');
check(undispatched.name, 'NetworkError', 'as a transport failure');
check(undispatched.outcomeUnknown, false, 'and only there is "nothing was stored" a fact');
check(undispatched.fetchCalls, 0, 'no request was dispatched at all');

console.log('\nA refusal the server sent is NOT uncertain (the status decides)');
for (const [status, body, expectedName] of [
  [403, { detail: { error_code: 'OUTFIT_ITEM_OWNERSHIP', message: 'One or more items do not belong to you' } }, 'ApiError'],
  [409, { detail: 'Outfit has worn feedback' }, 'ApiError'],
  [422, { detail: 'Validation error' }, 'ApiError'],
  [500, { detail: 'boom' }, 'ApiError'],
]) {
  const refusal = await attemptWrite(async () => jsonResponse(status, body));
  check(refusal.name, expectedName, `HTTP ${status} is an ${expectedName}, not a transport failure`);
  check(refusal.status, status, `HTTP ${status} keeps its status`);
  check(
    refusal.outcomeUnknown,
    undefined,
    `HTTP ${status} is not marked uncertain (the server answered and refused)`,
  );
}

console.log('\nThe global logout handler runs only for a credential rejection');
let logoutCalls = 0;
setAuthFailureHandler(() => {
  logoutCalls += 1;
});

logoutCalls = 0;
const business403 = await attemptWrite(async () =>
  jsonResponse(403, {
    detail: { error_code: 'OUTFIT_ITEM_OWNERSHIP', message: 'One or more items do not belong to you' },
  }),
);
check(business403.name, 'ApiError', 'a business 403 stays an ApiError');
check(
  business403.detail,
  'One or more items do not belong to you',
  'its message is preserved for the screen to show',
);
check(logoutCalls, 0, 'and it does NOT trigger a logout (round-3 finding D)');

logoutCalls = 0;
const inactive = await attemptWrite(async () => jsonResponse(403, { detail: 'User account is inactive' }));
check(inactive.name, 'AuthError', 'the inactive-account 403 is a credential failure');
check(logoutCalls, 1, 'and it does trigger exactly one logout');

logoutCalls = 0;
const unauthorized = await attemptWrite(async () => jsonResponse(401, { detail: 'Not authenticated' }));
check(unauthorized.name, 'AuthError', '401 is a credential failure');
check(logoutCalls, 1, 'and it triggers exactly one logout');

logoutCalls = 0;
const validation = await attemptWrite(async () => jsonResponse(422, { detail: 'Validation error' }));
check(validation.name, 'ApiError', '422 on a normal endpoint is an ordinary error');
check(logoutCalls, 0, 'that does not log the user out (round-2 behaviour kept)');

setAuthFailureHandler(null);

console.log('\nThe upload path (requestMultipart) classifies and reacts identically');
// `POST /items` and `POST /items/bulk` are the only endpoints here, and an upload cannot opt
// out of the global reaction: a 401 means the token is dead, so the user has to be sent back to
// the login screen instead of being told "保存失败" by a screen that never handles AuthError.
{
  const { calls, result } = await countLogouts(() =>
    attemptWrite(async () => jsonResponse(401, { detail: 'Not authenticated' }), {}, 'multipart'),
  );
  check(result.name, 'AuthError', 'a 401 upload is an AuthError');
  check(calls, 1, 'and it triggers the global auth handler exactly once');
  check(result.outcomeUnknown, undefined, 'an answered refusal carries no uncertainty flag');
}
{
  const { calls, result } = await countLogouts(() =>
    attemptWrite(async () => jsonResponse(403, { detail: 'User account is inactive' }), {}, 'multipart'),
  );
  check(result.name, 'AuthError', 'the inactive-account 403 is a credential failure on upload too');
  check(calls, 1, 'and it triggers exactly one logout');
}
{
  // The boundary that must not move: a business 403 is an answer to a valid session.
  const { calls, result } = await countLogouts(() =>
    attemptWrite(
      async () =>
        jsonResponse(403, {
          detail: { error_code: 'OUTFIT_ITEM_OWNERSHIP', message: 'One or more items do not belong to you' },
        }),
      {},
      'multipart',
    ),
  );
  check(result.name, 'ApiError', 'a business 403 on an upload stays an ApiError');
  check(calls, 0, 'and it does NOT log the user out');
}
{
  const { calls, result } = await countLogouts(() =>
    attemptWrite(async () => jsonResponse(422, { detail: 'Validation error' }), {}, 'multipart'),
  );
  check(result.name, 'ApiError', 'a 422 upload is an ordinary validation error');
  check(calls, 0, 'and it does not log the user out');
}
{
  const refused = await attemptWrite(async () => jsonResponse(400, { detail: 'Invalid image file' }), {}, 'multipart');
  check(refused.name, 'ApiError', 'a 400 upload keeps the server wording');
  check(refused.detail, 'Invalid image file', 'and the detail is preserved for the screen');
}

console.log('\nAn upload that never arrived is UNCERTAIN, like any other write');
{
  const dropped = await attemptWrite(async () => {
    throw new TypeError('Network request failed');
  }, {}, 'multipart');
  check(dropped.name, 'NetworkError', 'a dropped upload is a transport failure');
  check(dropped.outcomeUnknown, true, 'and its outcome is unknown (the bytes were sent)');
  check(dropped.fetchCalls, 1, 'the upload really was dispatched');
}
{
  const truncated = await attemptWrite(
    async () => ({
      status: 201,
      ok: true,
      text: async () => {
        throw new TypeError('terminated');
      },
    }),
    {},
    'multipart',
  );
  check(truncated.name, 'NetworkError', 'an upload whose reply body never arrived fails the same way');
  check(truncated.outcomeUnknown, true, 'and the item may already be stored');
}
{
  const ok = await attemptWrite(
    async () => jsonResponse(201, { id: 'new-item', status: 'ready' }),
    {},
    'multipart',
  );
  check(ok.thrown, false, 'a successful upload resolves');
  check(ok.value.id, 'new-item', 'with the created item');
}

console.log('\nReads are unaffected');
const read = await attemptWrite(async () =>
  jsonResponse(200, { outfits: [], page: 1, page_size: 20, total: 0, has_more: false }),
  { method: 'GET', body: undefined },
);
check(read.thrown, false, 'a successful GET resolves');
check(read.value.has_more, false, 'with its parsed body');

console.log('\nSource guard: the old promise cannot come back');
const clientSource = readFileSync(join(mobileDir, 'src', 'api', 'client.ts'), 'utf8');
check(
  /NetworkError\('请求超时[^']*',\s*true\)/.test(clientSource),
  false,
  'no NetworkError is constructed with the old positional `true`',
);
check(
  clientSource.includes('outcomeUnknown: false'),
  true,
  'exactly the pre-dispatch failure opts out of uncertainty',
);
check(
  (clientSource.match(/outcomeUnknown: false/g) ?? []).length,
  2,
  'and only the two `!apiBaseUrl` guards do (JSON path and multipart path)',
);
check(
  /readResponseBody\(response\)/.test(clientSource) && /readResponseBodyOrNull\(response\)/.test(clientSource),
  true,
  'every response body is read through a classified helper',
);
for (const [file, label] of [
  [join('app', '(tabs)', 'outfits.tsx'), 'the builder'],
  [join('app', 'outfit', '[id].tsx'), 'the editor'],
]) {
  const screen = readFileSync(join(mobileDir, file), 'utf8');
  check(screen.includes('outcomeUnknown'), true, `${label} branches on outcomeUnknown`);
  check(
    /NetworkError && \w+\.timedOut/.test(screen),
    false,
    `${label} no longer treats only a timeout as uncertain`,
  );
}

/**
 * The two screens must not share one sentence here. Retrying the builder's
 * `POST /outfits/suggestions` can create a second outfit (no idempotency key, which is what its
 * warning is for); retrying the editor's `PATCH /outfits/{id}` replaces the same outfit and
 * cannot, so that warning would be false there.
 */
const editorSource = readFileSync(join(mobileDir, 'app', 'outfit', '[id].tsx'), 'utf8');
const builderSource = readFileSync(join(mobileDir, 'app', '(tabs)', 'outfits.tsx'), 'utf8');
check(
  editorSource.includes('saveUncertainEditMessage'),
  true,
  'the editor has its own uncertain-save wording',
);
check(
  editorSource.includes('zh.outfits.saveUncertainMessage'),
  false,
  'the editor never shows the duplicate-outfit warning (PATCH replaces the same outfit)',
);
check(
  builderSource.includes('zh.outfits.saveUncertainMessage'),
  true,
  'the builder keeps it, because POST has no idempotency key',
);

/**
 * The item screens are the other half of the same defect class: their writes are dispatched
 * before they can fail too, so each one has to name the uncertainty instead of asserting
 * failure. `app/item/[id].tsx` carries four such writes (edit, archive, restore, delete) and
 * `app/item/new.tsx` carries the upload; checking them by name keeps the branches from being
 * quietly collapsed back into one sentence later.
 */
const itemDetailSource = readFileSync(join(mobileDir, 'app', 'item', '[id].tsx'), 'utf8');
const itemNewSource = readFileSync(join(mobileDir, 'app', 'item', 'new.tsx'), 'utf8');
for (const key of ['saveUncertain', 'archiveUncertain', 'restoreUncertain', 'deleteUncertain']) {
  check(
    itemDetailSource.includes(`zh.itemActions.${key}`),
    true,
    `the item screen reports \`${key}\` when the outcome is unknown`,
  );
}
check(
  (itemDetailSource.match(/err instanceof NetworkError && err\.outcomeUnknown/g) ?? []).length,
  4,
  'all four item writes branch on outcomeUnknown (no write claims failure blindly)',
);
check(
  itemNewSource.includes('zh.addItem.errors.uploadUncertain'),
  true,
  'the upload screen reports an unconfirmed upload instead of "上传失败"',
);
/*
 * Round 4 made this a nested branch: the 待购 mode (`?mode=toBuy`) has its own
 * 「可能已经加入待购」 wording for the *same* uncertain case, while the provably
 * undispatched branch stays a single `uploadFailed`. The assertion therefore checks the
 * decision, not one exact spelling of it — and a second assertion pins the new side.
 */
check(
  /error\.outcomeUnknown[\s\S]{0,240}?uploadUncertain[\s\S]{0,160}?uploadFailed/.test(
    itemNewSource,
  ),
  true,
  'and it still distinguishes the provably-undispatched case',
);
check(
  /isToBuyMode[\s\S]{0,80}?zh\.toBuy\.form\.uploadUncertain/.test(itemNewSource),
  true,
  'the 待购 mode says "可能已经加入待购" rather than reusing the wardrobe wording',
);
check(
  /isToBuyMode \? Boolean\(type\) : false/.test(itemNewSource),
  true,
  'a categorised 待购 garment skips AI tagging so it is ready to trial at once',
);

/**
 * Clearing the name has to reach the server as an empty string. Sending `null` is read as
 * "leave the name alone", which is what made "clear the name → save" a silent no-op; the type
 * is narrowed to `string` so that mistake cannot be reintroduced either.
 */
check(
  /patchOutfit\.mutateAsync\(\{ name: name\.trim\(\), items \}\)/.test(editorSource),
  true,
  'the editor sends the trimmed name as a string (empty string clears it)',
);
check(
  /name\s*\?\?\s*null|name:\s*name\.trim\(\)\s*\|\|\s*null/.test(editorSource),
  false,
  'and never falls back to null, which the server reads as "unchanged"',
);
const typesSource = readFileSync(join(mobileDir, 'src', 'api', 'types.ts'), 'utf8');
check(
  /export interface OutfitPatchFields \{\s*name\?: string;/.test(typesSource),
  true,
  'OutfitPatchFields.name is `string`, so `null` cannot be sent by mistake',
);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
