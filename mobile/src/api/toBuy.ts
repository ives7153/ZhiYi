/**
 * 待购 (to-buy) rules as pure functions.
 *
 * Everything here is about the two things round 4 must not get wrong on the client:
 *
 *  - **Money is text, not a float.** The user types "199.99"; that exact string goes
 *    to the server, which stores it as `Numeric(10, 2)`. Parsing it into a JS number
 *    (or back) would make 0.1 + 0.2 style artefacts visible in a price, so the value
 *    is validated as a pattern and passed through unchanged. An empty field is `null`
 *    — "没填" is not 0, and the server keeps the two distinct (`reference_price`
 *    stays NULL).
 *  - **A link is a link only if the phone can open it.** The screen hands `source_url`
 *    to the system browser on an explicit tap, so only absolute http/https addresses
 *    are accepted — no `javascript:`, `intent:`, `file:` or scheme-relative values,
 *    which would otherwise be a one-tap way to run something that is not a shop page.
 *
 * The module has no React and no network dependency on purpose: it is compiled and
 * exercised by `scripts/verify/to-buy-input.mjs` off-device.
 */

/** The server's two ownership values (`ItemOwnership` in `backend/app/models/item.py`). */
export const OWNED = 'owned';
export const TO_BUY = 'to_buy';

export type Ownership = typeof OWNED | typeof TO_BUY;

/** True for a garment that is only planned, not owned. */
export function isToBuy(item: { ownership?: string | null } | null | undefined): boolean {
  return item?.ownership === TO_BUY;
}

/** True for a garment the user already owns — including rows from before round 4. */
export function isOwned(item: { ownership?: string | null } | null | undefined): boolean {
  return !isToBuy(item);
}

/**
 * Longest reference price the column can hold: `Numeric(10, 2)` is 8 integer digits
 * plus the 2 decimals.
 */
export const REFERENCE_PRICE_MAX = 99999999.99;

/** Digits-and-at-most-two-decimals, the only shape the column can store exactly. */
const PRICE_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;

export type PriceParse =
  | { ok: true; value: string | null; kind: 'empty' }
  | { ok: true; value: string; kind: 'amount' }
  | { ok: false; message: string };

/**
 * Validates a typed reference price without ever converting it to a float.
 *
 * Rejected on purpose: negatives (`-1`), more than two decimals (`1.234` — the column
 * would round it, and silently storing a different number than the one typed is a lie
 * about money), thousands separators, exponents, and anything non-numeric. Leading and
 * trailing whitespace is trimmed; `199.5` is kept as typed, and the server stores it
 * as 199.50.
 */
export function parseReferencePrice(input: string): PriceParse {
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, value: null, kind: 'empty' };
  if (!PRICE_PATTERN.test(trimmed)) {
    return {
      ok: false,
      message: '参考价只能填数字，最多两位小数，不能是负数。',
    };
  }
  // The 8-digit cap in `PRICE_PATTERN` is the range check: `Numeric(10, 2)` holds at
  // most 99999999.99, and rejecting it here means the server never has to answer 422
  // for something the form could see coming. No float arithmetic happens anywhere —
  // the amount is re-padded as text so the value sent is a string the user could read.
  const [whole, fraction = ''] = trimmed.split('.');
  return { ok: true, value: `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`, kind: 'amount' };
}

/** Adds the two decimals the column stores, for a value the server already returned. */
export function normalizeStoredPrice(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number' ? value.toFixed(2) : String(value).trim();
  if (!text) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return text;
  return `${match[1]}.${(match[2] ?? '').padEnd(2, '0')}`;
}

/**
 * Display form: `¥199.50`. The currency is fixed to RMB this round — the spec asks for
 * a 人民币参考价 only, and no exchange rate is invented anywhere.
 *
 * `null`/absent renders as an empty string, so callers decide what "not filled in"
 * looks like (the card simply omits the line) instead of printing `¥0`.
 */
export function formatReferencePrice(value: string | number | null | undefined): string {
  const normalized = normalizeStoredPrice(value);
  if (!normalized) return '';
  return `¥${normalized}`;
}

/** True when the string is an absolute http/https URL a browser can be handed. */
export function isHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/\s/.test(trimmed)) return false;
  const match = /^(https?):\/\/([^/?#]+)(?:[/?#].*)?$/i.exec(trimmed);
  if (!match) return false;
  const host = match[2];
  // A scheme with no host (`http://`) or a bare dot is not openable.
  return host.length > 0 && host !== '.' && !host.startsWith('.');
}

export type UrlParse = { ok: true; value: string | null } | { ok: false; message: string };

/** Validates a typed product link; an empty field means "not provided". */
export function parseSourceUrl(input: string): UrlParse {
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, value: null };
  if (!isHttpUrl(trimmed)) {
    return { ok: false, message: '商品链接只能填 http:// 或 https:// 开头的网址。' };
  }
  return { ok: true, value: trimmed };
}

/**
 * Host of a stored link, for display next to it (e.g. `shop.example.com`).
 * Returns the raw string when it cannot be parsed, so the row shows what is stored
 * rather than a confident-looking wrong host.
 */
export function sourceUrlHost(value: string | null | undefined): string {
  if (!value) return '';
  const match = /^https?:\/\/([^/?#]+)/i.exec(value.trim());
  return match ? match[1] : value;
}
