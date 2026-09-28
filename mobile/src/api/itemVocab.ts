/**
 * Round-2 write payloads and the enum vocabularies the UI needs.
 *
 * `ItemCreateFields` / `ItemUpdateFields` are re-exported from `./types` rather than
 * declared here a second time: round 4 had to add 待购 fields to them, and two copies
 * of a request contract is how one screen silently starts sending a different shape
 * than another (the copy that is not updated still type-checks).
 *
 * Everything in this file was transcribed from the real backend:
 *  - `backend/app/api/items.py`           (create/update/delete/archive handlers)
 *  - `backend/app/schemas/item.py`        (ItemCreate / ItemUpdate / ItemImageResponse)
 *  - `backend/app/models/item.py`         (ItemStatus / TaggingStatus / TaggedBy)
 *  - `frontend/lib/types.ts`              (CLOTHING_TYPES — the vocabulary the Web sends)
 *  - `frontend/messages/zh-CN/constants.json` (the Chinese labels for those values)
 *
 * It lives in its own module rather than inside `types.ts` so the round-1 read
 * types stay untouched, which keeps the diff reviewable.
 */

export type { ItemCreateFields, ItemUpdateFields } from './types';

/** A local photo, already normalized for upload. */
export interface UploadablePhoto {
  /** Local uri (`file://…`). */
  uri: string;
  /** Filename sent in the multipart part. The server reads its extension. */
  name: string;
  /** MIME type sent in the multipart part. */
  type: string;
}

/**
 * Values the server accepts for `type`. Mirrors `frontend/lib/types.ts`
 * `CLOTHING_TYPES`, which is itself aligned with
 * `backend/app/services/ai_service.py` `VALID_TYPES`.
 *
 * `unknown` is deliberately NOT in this list: it is what the server assigns
 * when no type was supplied, and offering it as a user choice would let someone
 * file a garment under "unknown" by hand.
 */
export const CLOTHING_TYPES = [
  'top',
  't-shirt',
  'shirt',
  'blouse',
  'polo',
  'tank-top',
  'sweater',
  'cardigan',
  'hoodie',
  'vest',
  'blazer',
  'jacket',
  'coat',
  'suit',
  'jumpsuit',
  'dress',
  'skirt',
  'pants',
  'jeans',
  'shorts',
  'sneakers',
  'shoes',
  'boots',
  'sandals',
  'socks',
  'hat',
  'scarf',
  'belt',
  'tie',
  'bag',
  'accessories',
] as const;

export type ClothingType = (typeof CLOTHING_TYPES)[number];

/**
 * Chinese labels for `CLOTHING_TYPES`, transcribed from the Web's
 * `messages/zh-CN/constants.json` `types` map so both clients read identically.
 *
 * `unknown` is listed here even though it is NOT a user-selectable type (see the
 * note on `CLOTHING_TYPES`): the server assigns it whenever no type was
 * supplied, so a freshly added, not-yet-classified garment really does carry it.
 * Without an entry the helpers below fell through to the raw value and the
 * wardrobe rendered `unknown` and `shirt` in English — the enum reached the
 * screen, which the round-2 rule in `src/i18n/zh.ts` forbids. Keep this key;
 * removing it puts the raw enum back on screen.
 */
export const CLOTHING_TYPE_LABELS: Record<string, string> = {
  accessories: '配饰',
  bag: '包',
  belt: '腰带',
  blazer: '西装外套',
  blouse: '女士衬衫',
  boots: '靴子',
  cardigan: '开衫',
  coat: '大衣',
  dress: '连衣裙',
  hat: '帽子',
  hoodie: '卫衣',
  jacket: '夹克',
  jeans: '牛仔裤',
  jumpsuit: '连体裤',
  other: '其他',
  pants: '长裤',
  polo: 'Polo 衫',
  sandals: '凉鞋',
  scarf: '围巾',
  shirt: '衬衫',
  shoes: '鞋子',
  shorts: '短裤',
  skirt: '半裙',
  sneakers: '运动鞋',
  socks: '袜子',
  suit: '西装',
  sweater: '毛衣',
  't-shirt': 'T恤',
  'tank-top': '背心',
  tie: '领带',
  top: '上装',
  /** Server-assigned placeholder: the garment has not been classified yet. */
  unknown: '待分类',
  vest: '马甲',
};

/**
 * Chinese labels for common colours, from the same Web constants file.
 * Only the entries the picker offers are listed; the server stores any string,
 * and a free-text field is always available alongside.
 */
export const COLOR_LABELS: Record<string, string> = {
  black: '黑色',
  white: '白色',
  gray: '灰色',
  beige: '米色',
  brown: '棕色',
  navy: '藏青色',
  blue: '蓝色',
  green: '绿色',
  olive: '橄榄绿',
  khaki: '卡其色',
  red: '红色',
  pink: '粉色',
  purple: '紫色',
  yellow: '黄色',
  orange: '橙色',
};

/** Colours offered as one-tap chips, in the order they are rendered. */
export const COLOR_CHOICES = Object.keys(COLOR_LABELS);

/** Human label for a stored `type`, falling back to the raw value. */
export function clothingTypeLabel(type: string | null | undefined): string {
  if (!type) return '';
  return CLOTHING_TYPE_LABELS[type] ?? type;
}

/** Human label for a stored colour value, falling back to the raw value. */
export function colorLabel(color: string): string {
  return COLOR_LABELS[color] ?? color;
}
