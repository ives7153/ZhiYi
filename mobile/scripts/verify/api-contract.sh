#!/usr/bin/env bash
# Round-2 API behaviour checks against the real backend.
set -uo pipefail
export PY="${PY:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../backend" && pwd)/.venv/bin/python}"
BASE=http://127.0.0.1:8000/api/v1
PASS=0; FAIL=0
ok(){ echo "  PASS: $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
chk(){ [ "$1" = "$2" ] && ok "$3 ($1)" || no "$3 (expected $2, got $1)"; }

# Fresh user per run keeps counts deterministic.
UID_=$(date +%s)$$
T=$(curl -s -X POST $BASE/auth/sync -H 'Content-Type: application/json' \
  -d "{\"external_id\":\"r2-$UID_\",\"email\":\"r2-$UID_@example.com\",\"display_name\":\"R2\"}" \
  | $PY -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
AUTH="Authorization: Bearer $T"

$PY - <<'PYEOF'
from PIL import Image
import random
random.seed(7)
for i,(w,h,label) in enumerate([(2000,1500,'A'),(1800,1600,'B'),(1600,1600,'C'),(2400,1200,'D')]):
    im = Image.new('RGB',(w,h),(30+i*40, 90, 160))
    px = im.load()
    for x in range(0,w,13):
        for y in range(0,h,11):
            px[x,y] = ((x*7+i*31)%256, (y*5+i*17)%256, (x*y)%256)
    im.save(f'/tmp/r2-photo-{label}.jpg', quality=95)
print("photos generated")
PYEOF

echo "== 1. upload single item (AI off) =="
CODE=$(curl -s -o /tmp/r2-c.json -w '%{http_code}' -X POST $BASE/items -H "$AUTH" \
  -F "image=@/tmp/r2-photo-A.jpg;type=image/jpeg" -F "name=测试衬衫" -F "type=shirt" -F "colors=white")
chk "$CODE" "201" "POST /items returns 201"
STATUS=$($PY -c 'import json;print(json.load(open("/tmp/r2-c.json"))["status"])')
TAG=$($PY -c 'import json;print(json.load(open("/tmp/r2-c.json"))["tagging_status"])')
chk "$STATUS" "ready" "AI off -> status ready (usable for outfits)"
chk "$TAG" "pending" "tagging_status pending (manual tagging still available)"
ITEM_ID=$($PY -c 'import json;print(json.load(open("/tmp/r2-c.json"))["id"])')

echo "== 2. duplicate detection (409, no second row) =="
CODE=$(curl -s -o /tmp/r2-dup.json -w '%{http_code}' -X POST $BASE/items -H "$AUTH" \
  -F "image=@/tmp/r2-photo-A.jpg;type=image/jpeg")
chk "$CODE" "409" "same photo again -> 409"
N=$(curl -s "$BASE/items" -H "$AUTH" | $PY -c 'import sys,json;print(json.load(sys.stdin)["total"])')
chk "$N" "1" "no duplicate row created"

echo "== 3. bulk upload_keys idempotency (retry must not duplicate) =="
CODE=$(curl -s -o /tmp/r2-b1.json -w '%{http_code}' -X POST $BASE/items/bulk -H "$AUTH" \
  -F "images=@/tmp/r2-photo-B.jpg;type=image/jpeg" -F "skip_ai=true" -F "upload_keys=r2-key-1")
chk "$CODE" "201" "bulk upload returns 201"
ID1=$($PY -c 'import json;d=json.load(open("/tmp/r2-b1.json"));print(d["results"][0]["item"]["id"])')
CODE=$(curl -s -o /tmp/r2-b2.json -w '%{http_code}' -X POST $BASE/items/bulk -H "$AUTH" \
  -F "images=@/tmp/r2-photo-B.jpg;type=image/jpeg" -F "skip_ai=true" -F "upload_keys=r2-key-1")
chk "$CODE" "201" "retry returns 201"
ID2=$($PY -c 'import json;d=json.load(open("/tmp/r2-b2.json"));print(d["results"][0]["item"]["id"])')
DUPMARK=$($PY -c 'import json;d=json.load(open("/tmp/r2-b2.json"));print(d["results"][0]["duplicate"])')
chk "$ID2" "$ID1" "retry returns the SAME item id (idempotent)"
chk "$DUPMARK" "True" "retry flagged duplicate=true"
N=$(curl -s "$BASE/items" -H "$AUTH" | $PY -c 'import sys,json;print(json.load(sys.stdin)["total"])')
chk "$N" "2" "still exactly 2 items after retry"

echo "== 4. upload_keys length mismatch rejected =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/items/bulk -H "$AUTH" \
  -F "images=@/tmp/r2-photo-C.jpg;type=image/jpeg" -F "upload_keys=k1" -F "upload_keys=k2")
chk "$CODE" "400" "mismatched upload_keys -> 400"

echo "== 5. non-image rejected =="
echo "not an image" > /tmp/r2-notimage.jpg
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/items -H "$AUTH" \
  -F "image=@/tmp/r2-notimage.jpg;type=image/jpeg")
chk "$CODE" "400" "garbage file -> 400"

echo "== 6. invalid payload -> 422 (must NOT be treated as auth failure) =="
CODE=$(curl -s -o /tmp/r2-422.json -w '%{http_code}' -X PATCH "$BASE/items/$ITEM_ID" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"name":"'"$(printf 'x%.0s' {1..120})"'"}')
chk "$CODE" "422" "121-char name -> 422 validation error"
$PY -c 'import json;d=json.load(open("/tmp/r2-422.json"));print("     body:", json.dumps(d, ensure_ascii=False)[:120])'
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/auth/session" -H "$AUTH")
chk "$CODE" "200" "same token still valid after the 422 (no logout warranted)"

echo "== 7. PATCH writes tag fields and flips tagging_status =="
curl -s -o /tmp/r2-p.json -X PATCH "$BASE/items/$ITEM_ID" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"type":"blouse","name":"改名后","colors":["navy"]}'
NEWNAME=$($PY -c 'import json;print(json.load(open("/tmp/r2-p.json"))["name"])')
NEWTYPE=$($PY -c 'import json;print(json.load(open("/tmp/r2-p.json"))["type"])')
TAGBY=$($PY -c 'import json;print(json.load(open("/tmp/r2-p.json"))["tagged_by"])')
TAGST=$($PY -c 'import json;print(json.load(open("/tmp/r2-p.json"))["tagging_status"])')
chk "$NEWNAME" "改名后" "name updated"
chk "$NEWTYPE" "blouse" "type updated"
chk "$TAGBY" "manual" "tagged_by=manual after writing a tag field"
chk "$TAGST" "tagged" "tagging_status=tagged after writing a tag field"

echo "== 8. list reflects the edit (list/detail/filter consistency) =="
curl -s -o /tmp/r2-l.json -G "$BASE/items" --data-urlencode "search=改名后" -H "$AUTH"
chk "$($PY -c 'import json;print(json.load(open("/tmp/r2-l.json"))["total"])')" "1" "search by new name finds it"
curl -s -o /tmp/r2-l2.json "$BASE/items?type=blouse" -H "$AUTH"
chk "$($PY -c 'import json;print(json.load(open("/tmp/r2-l2.json"))["total"])')" "1" "type filter finds it"
curl -s -o /tmp/r2-l3.json "$BASE/items?type=shirt" -H "$AUTH"
chk "$($PY -c 'import json;print(json.load(open("/tmp/r2-l3.json"))["total"])')" "0" "old type no longer matches"
curl -s -o /tmp/r2-d.json "$BASE/items/$ITEM_ID" -H "$AUTH"
chk "$($PY -c 'import json;print(json.load(open("/tmp/r2-d.json"))["name"])')" "改名后" "detail shows the edit"

echo "== 9. archive hides from list, keeps the row, restore brings it back =="
curl -s -o /tmp/r2-a.json -X POST "$BASE/items/$ITEM_ID/archive" -H "$AUTH" -H 'Content-Type: application/json' -d '{}'
chk "$($PY -c 'import json;print(json.load(open("/tmp/r2-a.json"))["is_archived"])')" "True" "archive sets is_archived"
chk "$($PY -c 'import json;print(json.load(open("/tmp/r2-a.json"))["status"])')" "archived" "archive sets status"
chk "$(curl -s "$BASE/items" -H "$AUTH" | $PY -c 'import sys,json;print(json.load(sys.stdin)["total"])')" "1" "archived item left the default list"
chk "$(curl -s "$BASE/items?is_archived=true" -H "$AUTH" | $PY -c 'import sys,json;print(json.load(sys.stdin)["total"])')" "1" "archived item still exists"
curl -s -o /tmp/r2-r.json -X POST "$BASE/items/$ITEM_ID/restore" -H "$AUTH"
chk "$($PY -c 'import json;print(json.load(open("/tmp/r2-r.json"))["status"])')" "ready" "restore returns it to ready"
chk "$(curl -s "$BASE/items" -H "$AUTH" | $PY -c 'import sys,json;print(json.load(sys.stdin)["total"])')" "2" "restored item is back in the list"

echo "== 10. delete removes it permanently =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/items/$ITEM_ID" -H "$AUTH")
chk "$CODE" "204" "DELETE returns 204"
chk "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/items/$ITEM_ID" -H "$AUTH")" "404" "detail is now 404"
chk "$(curl -s "$BASE/items" -H "$AUTH" | $PY -c 'import sys,json;print(json.load(sys.stdin)["total"])')" "1" "list dropped the row"

echo "== 11. signed image URL works and expiry is honoured =="
IMG=$(curl -s "$BASE/items" -H "$AUTH" | $PY -c 'import sys,json;print(json.load(sys.stdin)["items"][0]["thumbnail_url"])')
chk "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8000$IMG")" "200" "thumbnail URL loads"
BAD=$(echo "$IMG" | sed 's/sig=[a-f0-9]*/sig=0000000000000000/')
chk "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8000$BAD")" "401" "tampered signature rejected"

echo "== 12. analyze is deferred when AI is off (no bypass) =="
BID=$($PY -c 'import json;d=json.load(open("/tmp/r2-b1.json"));print(d["results"][0]["item"]["id"])')
curl -s -o /tmp/r2-an.json -X POST "$BASE/items/$BID/analyze" -H "$AUTH"
chk "$($PY -c 'import json;print(json.load(open("/tmp/r2-an.json"))["status"])')" "deferred" "analyze reports deferred, AI off"
chk "$(curl -s "$BASE/items/$BID" -H "$AUTH" | $PY -c 'import sys,json;print(json.load(sys.stdin)["status"])')" "ready" "item stays ready (manually manageable)"

# ---------------------------------------------------------------------------
# Round 3: the outfit endpoints the 搭配 feature uses, and their isolation rules.
#
# These run against the real backend, so the contract the mobile client codes to is
# checked rather than assumed. The second account exists to prove the ownership rules:
# `GET`/`PATCH`/`DELETE /outfits/{id}` filter on `user_id`, and `POST /outfits/suggestions`
# runs `validate_item_ownership`, so a foreign id must be a 404 and a foreign garment a 403.
# ---------------------------------------------------------------------------
# Two fresh garments for these checks. The round-2 rows cannot be reused: section 10
# deletes one and section 9 archives/restores the other, and `PATCH /outfits/{id}` runs
# `validate_item_ownership`, which demands `status == ready` — borrowing them turned a 200
# into a 403 and made the test look like a product bug.
#
# The generated bytes are seeded from this run's id: the backend rejects a repeat upload of
# the same picture with 409 (pHash duplicate), so a fixed pattern made the second run of this
# script fail with "no id in the response".
$PY - "$UID_" <<'PYEOF'
from PIL import Image
import random
import sys

random.seed(int(sys.argv[1]))
for name, base in (('a', (200, 40, 40)), ('b', (40, 40, 200))):
    image = Image.new('RGB', (900, 900), base)
    px = image.load()
    for _ in range(6000):
        x, y = random.randrange(900), random.randrange(900)
        px[x, y] = (random.randrange(256), random.randrange(256), random.randrange(256))
    image.save(f'/tmp/r3-photo-{name}.jpg', quality=92)
PYEOF
OA=$(curl -s -X POST $BASE/items -H "$AUTH" -F "image=@/tmp/r3-photo-a.jpg;type=image/jpeg" \
  -F "name=r3-上装-$UID_" -F "type=shirt" -F "skip_ai=true" | $PY -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')
OB=$(curl -s -X POST $BASE/items -H "$AUTH" -F "image=@/tmp/r3-photo-b.jpg;type=image/jpeg" \
  -F "name=r3-下装-$UID_" -F "type=pants" -F "skip_ai=true" | $PY -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')
if [ -z "$OA" ] || [ -z "$OB" ]; then
  echo "  FAIL: could not seed the two garments for the outfit checks (OA='$OA' OB='$OB')"
  FAIL=$((FAIL+1))
fi
OUT2=$($PY -c 'import json;d=json.load(open("/tmp/r2-b1.json"));print(d["results"][0]["item"]["id"])')

echo "== 13. POST /outfits/suggestions stores an authored outfit =="
CODE=$(curl -s -o /tmp/r3-o.json -w '%{http_code}' -X POST $BASE/outfits/suggestions -H "$AUTH" \
  -H 'Content-Type: application/json' -d "{\"items\":[\"$OA\",\"$OB\"],\"occasion\":\"casual\",\"name\":\"第三轮契约\"}")
chk "$CODE" "201" "POST /outfits/suggestions returns 201"
OID=$($PY -c 'import json;print(json.load(open("/tmp/r3-o.json"))["id"])')
chk "$($PY -c 'import json;d=json.load(open("/tmp/r3-o.json"));print(d["source"])')" "external" "authored outfits are source=external"
chk "$($PY -c 'import json;d=json.load(open("/tmp/r3-o.json"));print(d["status"])')" "pending" "a new outfit starts pending"
chk "$($PY -c 'import json;d=json.load(open("/tmp/r3-o.json"));print(len(d["items"]))')" "2" "the item list is stored"
chk "$($PY -c 'import json;d=json.load(open("/tmp/r3-o.json"));print(d["items"][0]["layer_type"])')" "None" "layer_type is null: no write path exists for it"

echo "== 14. the request schema rejects fields it does not declare (extra=forbid) =="
CODE=$(curl -s -o /tmp/r3-bad.json -w '%{http_code}' -X POST $BASE/outfits/suggestions -H "$AUTH" \
  -H 'Content-Type: application/json' -d "{\"items\":[\"$OA\"],\"occasion\":\"casual\",\"layer_type\":\"top\"}")
chk "$CODE" "422" "an undeclared layer_type is rejected with 422"
CODE=$(curl -s -o /tmp/r3-bad2.json -w '%{http_code}' -X POST $BASE/outfits/suggestions -H "$AUTH" \
  -H 'Content-Type: application/json' -d "{\"items\":[\"$OA\"],\"occasion\":\"brunching\"}")
chk "$CODE" "422" "an occasion outside VALID_OCCASIONS is rejected"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/outfits/suggestions -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"items":[],"occasion":"casual"}')
chk "$CODE" "422" "an empty item list is rejected"

echo "== 15. GET /outfits paginates and reports totals =="
chk "$(curl -s "$BASE/outfits?page=1&page_size=1" -H "$AUTH" | $PY -c 'import sys,json;print(json.load(sys.stdin)["total"])')" "1" "list reports the total"
chk "$(curl -s "$BASE/outfits?page=1&page_size=1" -H "$AUTH" | $PY -c 'import sys,json;print(json.load(sys.stdin)["has_more"])')" "False" "has_more is false on the last page"

echo "== 16. GET/PATCH/DELETE an outfit =="
chk "$(curl -s "$BASE/outfits/$OID" -H "$AUTH" | $PY -c 'import sys,json;print(json.load(sys.stdin)["name"])')" "第三轮契约" "detail returns the stored name"
CODE=$(curl -s -o /tmp/r3-p.json -w '%{http_code}' -X PATCH "$BASE/outfits/$OID" -H "$AUTH" \
  -H 'Content-Type: application/json' -d "{\"name\":\"改名了\",\"items\":[\"$OA\",\"$OB\"]}")
chk "$CODE" "200" "PATCH returns 200"
chk "$($PY -c 'import json;d=json.load(open("/tmp/r3-p.json"));print(len(d["items"]))')" "2" "PATCH replaced the whole item set"
chk "$($PY -c 'import json;d=json.load(open("/tmp/r3-p.json"));print(d["name"])')" "改名了" "PATCH stored the new name"
chk "$(curl -s "$BASE/outfits/$OID" -H "$AUTH" | $PY -c 'import sys,json;print(json.load(sys.stdin)["name"])')" "改名了" "the change is visible on a fresh GET"
chk "$(curl -s "$BASE/outfits/$OID" -H "$AUTH" | $PY -c 'import sys,json;print(len(json.load(sys.stdin)["items"]))')" "2" "the item change persisted"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/outfits/$OID" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{}')
chk "$CODE" "400" "PATCH with no fields is rejected (PATCH_EMPTY)"

echo "== 17. deleting an outfit leaves the wardrobe alone =="
BEFORE=$(curl -s "$BASE/items?page_size=100" -H "$AUTH" | $PY -c 'import sys,json;print(json.load(sys.stdin)["total"])')
chk "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/outfits/$OID" -H "$AUTH")" "204" "DELETE returns 204"
chk "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/outfits/$OID" -H "$AUTH")" "404" "the outfit is gone"
AFTER=$(curl -s "$BASE/items?page_size=100" -H "$AUTH" | $PY -c 'import sys,json;print(json.load(sys.stdin)["total"])')
chk "$AFTER" "$BEFORE" "the garments are untouched by the outfit delete"
chk "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/items/$OUT2" -H "$AUTH")" "200" "the garment still exists"

echo "== 18. cross-account isolation and ownership =="
T2=$(curl -s -X POST $BASE/auth/sync -H 'Content-Type: application/json' \
  -d "{\"external_id\":\"r3-other-$UID_\",\"email\":\"r3-other-$UID_@example.com\",\"display_name\":\"Other\"}" \
  | $PY -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
AUTH2="Authorization: Bearer $T2"
curl -s -o /tmp/r3-mine.json -X POST $BASE/outfits/suggestions -H "$AUTH" \
  -H 'Content-Type: application/json' -d "{\"items\":[\"$OA\"],\"occasion\":\"casual\",\"name\":\"isolation\"}"
MINE=$($PY -c 'import json;print(json.load(open("/tmp/r3-mine.json"))["id"])')
chk "$(curl -s "$BASE/outfits?page_size=100" -H "$AUTH2" | $PY -c 'import sys,json;print(json.load(sys.stdin)["total"])')" "0" "the other account sees none of my outfits"
chk "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/outfits/$MINE" -H "$AUTH2")" "404" "another account cannot read my outfit by id"
chk "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/outfits/$MINE" -H "$AUTH2" \
  -H 'Content-Type: application/json' -d '{"name":"hijack"}')" "404" "another account cannot rename my outfit"
chk "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/outfits/$MINE" -H "$AUTH2")" "404" "another account cannot delete my outfit"
chk "$(curl -s "$BASE/outfits/$MINE" -H "$AUTH" | $PY -c 'import sys,json;print(json.load(sys.stdin)["name"])')" "isolation" "my outfit is unchanged"
CODE=$(curl -s -o /tmp/r3-foreign.json -w '%{http_code}' -X POST $BASE/outfits/suggestions -H "$AUTH2" \
  -H 'Content-Type: application/json' -d "{\"items\":[\"$OA\"],\"occasion\":\"casual\"}")
chk "$CODE" "403" "another account cannot put my garment in its own outfit"
chk "$($PY -c 'import json;print(json.load(open("/tmp/r3-foreign.json"))["detail"]["error_code"])')" "OUTFIT_ITEM_OWNERSHIP" "the refusal names the ownership rule"
chk "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/outfits/$MINE" -H "$AUTH")" "204" "the owner can delete it"

echo "== 19. an archived garment cannot be added to an outfit =="
ARCH=$($PY -c 'import json;d=json.load(open("/tmp/r2-b1.json"));print(d["results"][0]["item"]["id"])')
curl -s -o /dev/null -X POST "$BASE/items/$ARCH/archive" -H "$AUTH" -H 'Content-Type: application/json' -d '{}'
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/outfits/suggestions -H "$AUTH" \
  -H 'Content-Type: application/json' -d "{\"items\":[\"$ARCH\"],\"occasion\":\"casual\"}")
chk "$CODE" "403" "an archived garment is refused (validate_item_ownership needs status=ready)"
curl -s -o /dev/null -X POST "$BASE/items/$ARCH/restore" -H "$AUTH"


echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
