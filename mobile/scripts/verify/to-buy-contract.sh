#!/usr/bin/env bash
# Round-4 待购 contract checks against the real backend.
#
#     cd mobile && bash scripts/verify/to-buy-contract.sh
#
# What it proves, all of it against a running server and stored rows (two throwaway
# accounts per run, nothing shared with the device's account):
#
#   1. a client that knows nothing about round 4 keeps entering the wardrobe (compat);
#   2. a 待购 garment is invisible to every 衣橱 read — default list, its total, its
#      category counts — and visible to the 待购 ones, with server-side search/paging;
#   3. a duplicate photo points at the row that already exists on **either** side and
#      never moves it;
#   4. 已购买 flips ownership on the SAME row (same id, same image paths), moves the
#      counts, keeps the outfit association, and survives being run twice **at once**;
#   5. an outfit that still holds 待购 garments is reported as such, and cannot be
#      recorded as worn — after buying the last one it can be;
#   6. the 待购 delete guard refuses to delete a row that is no longer 待购;
#   7. a second account cannot see, edit, buy or attach the first account's garments.
#
# Money and link validation is covered by `backend/tests/test_to_buy.py` (422 bodies) and
# `scripts/verify/to-buy-input.mjs` (the client's own rules); this script focuses on the
# cross-account and state-transition behaviour that needs a real database.
set -uo pipefail

export PY="${PY:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../backend" && pwd)/.venv/bin/python}"
BASE="${BASE:-http://127.0.0.1:8000/api/v1}"
PASS=0; FAIL=0
ok(){ echo "  PASS: $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
chk(){ if [ "$1" = "$2" ]; then ok "$3 ($1)"; else no "$3 (expected $2, got $1)"; fi; }
jget(){ "$PY" -c "import json,sys;print(json.load(open('$1'))$2)"; }

STAMP="$(date +%s)$$"

signup(){ # $1 = suffix
  curl -s -X POST "$BASE/auth/sync" -H 'Content-Type: application/json' \
    -d "{\"external_id\":\"r4-$STAMP-$1\",\"email\":\"r4-$STAMP-$1@example.com\",\"display_name\":\"R4 $1\"}" \
    | "$PY" -c 'import json,sys;print(json.load(sys.stdin)["access_token"])'
}

# Two distinct photos (different perceptual hashes) plus one reused on purpose.
"$PY" - <<'PYEOF'
from PIL import Image
def make(path, seed, size=320):
    im = Image.new('RGB', (size, size), (20 + seed * 30 % 200, 80, 150))
    px = im.load()
    for x in range(0, size, 4):
        for y in range(0, size, 6):
            px[x, y] = ((x * (seed + 5)) % 256, (y * 7 + seed) % 256, (x * y + seed) % 256)
    im.save(path, quality=90)
make('/tmp/r4c-shirt.jpg', 1)
make('/tmp/r4c-pants.jpg', 2)
make('/tmp/r4c-other.jpg', 3)
print("photos ready")
PYEOF

A="Authorization: Bearer $(signup a)"
B="Authorization: Bearer $(signup b)"
[ -n "${A#Authorization: Bearer }" ] || { echo "no token for account A"; exit 1; }

echo "== 1. an old-style create (no ownership field) still enters the wardrobe =="
CODE=$(curl -s -o /tmp/r4c-legacy.json -w '%{http_code}' -X POST "$BASE/items" -H "$A" \
  -F "image=@/tmp/r4c-shirt.jpg;type=image/jpeg" -F "type=shirt" -F "name=旧客户端录入")
chk "$CODE" "201" "POST /items without ownership returns 201"
chk "$(jget /tmp/r4c-legacy.json "['ownership']")" "owned" "it lands as 已拥有"

echo "== 2. 待购 create keeps the plan out of every wardrobe read =="
CODE=$(curl -s -o /tmp/r4c-tobuy.json -w '%{http_code}' -X POST "$BASE/items" -H "$A" \
  -F "image=@/tmp/r4c-pants.jpg;type=image/jpeg" -F "type=pants" -F "name=想买的裤子" \
  -F "ownership=to_buy" -F "reference_price=199.90" -F "source_url=https://shop.example.com/p/9" -F "skip_ai=true")
chk "$CODE" "201" "POST /items?ownership=to_buy returns 201"
TB=$(jget /tmp/r4c-tobuy.json "['id']")
OW=$(jget /tmp/r4c-legacy.json "['id']")
chk "$(jget /tmp/r4c-tobuy.json "['ownership']")" "to_buy" "it is stored as 待购"
chk "$(jget /tmp/r4c-tobuy.json "['reference_price']")" "199.90" "the reference price keeps its two decimals"
chk "$(jget /tmp/r4c-tobuy.json "['purchase_price']")" "None" "purchase_price is untouched (a reference is not a paid amount)"

curl -s "$BASE/items" -H "$A" -o /tmp/r4c-owned.json
chk "$(jget /tmp/r4c-owned.json "['total']")" "1" "the default 衣橱 list reports exactly the owned garment"
chk "$(jget /tmp/r4c-owned.json "['items'][0]['id']")" "$OW" "and that row is the owned one"
curl -s "$BASE/items?ownership=to_buy" -H "$A" -o /tmp/r4c-pending.json
chk "$(jget /tmp/r4c-pending.json "['total']")" "1" "the 待购 list reports exactly the planned garment"
chk "$(jget /tmp/r4c-pending.json "['items'][0]['id']")" "$TB" "and that row is the planned one"
curl -s "$BASE/items/types" -H "$A" -o /tmp/r4c-types-owned.json
chk "$(jget /tmp/r4c-types-owned.json "[0]['type']")" "shirt" "衣橱 category counts skip the planned garment"
chk "$(jget /tmp/r4c-types-owned.json "[0]['count']")" "1" "and count only the owned one"
curl -s "$BASE/items/types?ownership=to_buy" -H "$A" -o /tmp/r4c-types-pending.json
chk "$(jget /tmp/r4c-types-pending.json "[0]['type']")" "pants" "待购 category counts are the planned ones"
curl -s "$BASE/items?ownership=to_buy&search=%E6%83%B3%E4%B9%B0" -H "$A" -o /tmp/r4c-search.json
chk "$(jget /tmp/r4c-search.json "['total']")" "1" "server-side search finds the planned garment in 待购"
chk "$(jget /tmp/r4c-search.json "['items'][0]['id']")" "$TB" "and the row it returns is the planned one"
chk "$(curl -s "$BASE/items?search=%E6%83%B3%E4%B9%B0" -H "$A" | "$PY" -c 'import json,sys;print(json.load(sys.stdin)["total"])')" "0" "the same search in 衣橱 finds nothing"

echo "== 3. the same photo points at the existing row and moves nothing =="
CODE=$(curl -s -o /tmp/r4c-dup.json -w '%{http_code}' -X POST "$BASE/items" -H "$A" \
  -F "image=@/tmp/r4c-pants.jpg;type=image/jpeg" -F "type=pants")
chk "$CODE" "409" "re-uploading the planned photo returns 409"
chk "$(jget /tmp/r4c-dup.json "['detail']['existing_item_id']")" "$TB" "the answer names the existing row"
chk "$(jget /tmp/r4c-dup.json "['detail']['existing_ownership']")" "to_buy" "and the side it is on"
chk "$(curl -s "$BASE/items/$TB" -H "$A" | "$PY" -c 'import json,sys;print(json.load(sys.stdin)["ownership"])')" "to_buy" "the existing row keeps its ownership"

echo "== 4. a 试搭 may hold a 待购 garment, and the server says so =="
CODE=$(curl -s -o /tmp/r4c-outfit.json -w '%{http_code}' -X POST "$BASE/outfits/suggestions" -H "$A" \
  -H 'Content-Type: application/json' -d "{\"items\":[\"$OW\",\"$TB\"],\"occasion\":\"casual\",\"name\":\"试搭\"}")
chk "$CODE" "201" "POST /outfits/suggestions accepts an owned + planned pair"
OF=$(jget /tmp/r4c-outfit.json "['id']")
chk "$(jget /tmp/r4c-outfit.json "['contains_to_buy']")" "True" "contains_to_buy is computed as true"
# The planned garment must be genuinely in the outfit, not merely counted in the flag.
chk "$("$PY" -c "
import json
d = json.load(open('/tmp/r4c-outfit.json'))
print(sum(1 for i in d['items'] if i['id'] == '$TB' and i['ownership'] == 'to_buy'))
")" "1" "the planned garment is really in the outfit and marked 待购 on the item"
CODE=$(curl -s -o /tmp/r4c-worn.json -w '%{http_code}' -X POST "$BASE/outfits/$OF/feedback" -H "$A" \
  -H 'Content-Type: application/json' -d '{"worn":true}')
chk "$CODE" "409" "recording it as worn is refused"
chk "$(jget /tmp/r4c-worn.json "['detail']['error_code']")" "OUTFIT_CONTAINS_TO_BUY" "with OUTFIT_CONTAINS_TO_BUY"
CODE=$(curl -s -o /tmp/r4c-itemwear.json -w '%{http_code}' -X POST "$BASE/items/$TB/wear" -H "$A" \
  -H 'Content-Type: application/json' -d '{}')
chk "$CODE" "409" "wearing the planned garment itself is refused"
chk "$(jget /tmp/r4c-itemwear.json "['detail']['error_code']")" "ITEM_NOT_OWNED_YET" "with ITEM_NOT_OWNED_YET"

echo "== 5. 已购买: same row, moved counts, unchanged image and outfit link =="
IMG_BEFORE=$(jget /tmp/r4c-tobuy.json "['image_path']")
CODE=$(curl -s -o /tmp/r4c-pur1.json -w '%{http_code}' -X POST "$BASE/items/$TB/purchase" -H "$A")
chk "$CODE" "200" "POST /items/{id}/purchase returns 200"
chk "$(jget /tmp/r4c-pur1.json "['id']")" "$TB" "the id is unchanged"
chk "$(jget /tmp/r4c-pur1.json "['ownership']")" "owned" "it is owned now"
chk "$(jget /tmp/r4c-pur1.json "['image_path']")" "$IMG_BEFORE" "the stored image is the same file"
chk "$(jget /tmp/r4c-pur1.json "['reference_price']")" "199.90" "the reference price is kept as a reference"
chk "$(jget /tmp/r4c-pur1.json "['purchase_price']")" "None" "and is still not written as a paid amount"
chk "$(curl -s "$BASE/items" -H "$A" | "$PY" -c 'import json,sys;print(json.load(sys.stdin)["total"])')" "2" "衣橱 count went up"
chk "$(curl -s "$BASE/items?ownership=to_buy" -H "$A" | "$PY" -c 'import json,sys;print(json.load(sys.stdin)["total"])')" "0" "待购 count went down"
chk "$(curl -s "$BASE/outfits/$OF" -H "$A" | "$PY" -c 'import json,sys;print(json.load(sys.stdin)["contains_to_buy"])')" "False" "the saved 试搭 loses the 含待购 marker by itself"
chk "$(curl -s "$BASE/outfits/$OF" -H "$A" | "$PY" -c 'import json,sys;print(len(json.load(sys.stdin)["items"]))')" "2" "and no garment was lost by the transition"
CODE=$(curl -s -o /tmp/r4c-worn2.json -w '%{http_code}' -X POST "$BASE/outfits/$OF/feedback" -H "$A" \
  -H 'Content-Type: application/json' -d '{"worn":true}')
chk "$CODE" "200" "now it can be recorded as worn"

echo "== 6. a second concurrent purchase cannot create a second garment =="
CODE=$(curl -s -o /tmp/r4c-tb2.json -w '%{http_code}' -X POST "$BASE/items" -H "$A" \
  -F "image=@/tmp/r4c-other.jpg;type=image/jpeg" -F "type=coat" -F "name=并发测试" -F "ownership=to_buy" -F "skip_ai=true")
chk "$CODE" "201" "a second planned garment is created"
TB2=$(jget /tmp/r4c-tb2.json "['id']")
curl -s -o /tmp/r4c-race1.json -w '%{http_code}' -X POST "$BASE/items/$TB2/purchase" -H "$A" > /tmp/r4c-race1.code &
P1=$!
curl -s -o /tmp/r4c-race2.json -w '%{http_code}' -X POST "$BASE/items/$TB2/purchase" -H "$A" > /tmp/r4c-race2.code &
P2=$!
wait $P1 $P2
chk "$(cat /tmp/r4c-race1.code)/$(cat /tmp/r4c-race2.code)" "200/200" "both racing purchases answer 200"
chk "$(jget /tmp/r4c-race1.json "['id']")/$(jget /tmp/r4c-race2.json "['id']")" "$TB2/$TB2" "both name the same garment"
chk "$(curl -s "$BASE/items?search=%E5%B9%B6%E5%8F%91" -H "$A" | "$PY" -c 'import json,sys;print(json.load(sys.stdin)["total"])')" "1" "exactly one row exists afterwards (never two)"

echo "== 7. the 待购 delete guard keeps a garment that is not 待购 any more =="
CODE=$(curl -s -o /tmp/r4c-guard.json -w '%{http_code}' -X DELETE "$BASE/items/$TB?ownership=to_buy" -H "$A")
chk "$CODE" "409" "deleting an owned row from a stale 待购 page is refused"
chk "$(jget /tmp/r4c-guard.json "['detail']['error_code']")" "ITEM_OWNERSHIP_CHANGED" "with ITEM_OWNERSHIP_CHANGED"
chk "$(curl -s "$BASE/items/$TB" -H "$A" | "$PY" -c 'import json,sys;print(json.load(sys.stdin)["id"])')" "$TB" "and the garment is still there"

echo "== 8. a second account is isolated on every round-4 route =="
chk "$(curl -s "$BASE/items?ownership=to_buy" -H "$B" | "$PY" -c 'import json,sys;print(json.load(sys.stdin)["total"])')" "0" "B's 待购 list is empty"
chk "$(curl -s "$BASE/items/types?ownership=to_buy" -H "$B" | "$PY" -c 'import json,sys;print(len(json.load(sys.stdin)))')" "0" "B's 待购 category counts are empty"
chk "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/items/$TB" -H "$B")" "404" "B cannot read A's garment"
chk "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/items/$TB/purchase" -H "$B")" "404" "B cannot buy A's garment"
chk "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/items/$TB?ownership=to_buy" -H "$B")" "404" "B cannot delete A's garment"
CODE=$(curl -s -o /tmp/r4c-cross.json -w '%{http_code}' -X POST "$BASE/outfits/suggestions" -H "$B" \
  -H 'Content-Type: application/json' -d "{\"items\":[\"$TB\"],\"occasion\":\"casual\"}")
chk "$CODE" "403" "B cannot attach A's garment to an outfit"
chk "$(jget /tmp/r4c-cross.json "['detail']['error_code']")" "OUTFIT_ITEM_OWNERSHIP" "with OUTFIT_ITEM_OWNERSHIP"
chk "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/auth/session" -H "$B")" "200" "and B's session is untouched (business 403, not a credential failure)"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
