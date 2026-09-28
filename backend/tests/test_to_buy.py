"""Round-4 待购 contract: one entity, two sides, and the transitions between them.

Every test here drives the real endpoints against the test database; none of them
re-implements the service layer. The properties asserted are the ones the round-4
spec makes promises about:

* 待购 and 已拥有 live in one table, told apart by `ownership`, and a client that
  knows nothing about the column keeps writing to the wardrobe (compatibility);
* nothing new leaks into the wardrobe list, its counts, the bulk selection or the
  recommendation candidates;
* a duplicate photo points at the row that already exists on **either** side and
  never rewrites its ownership;
* 已购买 moves the *same* row (same id, same images, same outfit links), is
  idempotent under repeats, and refuses a deleted or archived record with a clear
  answer instead of silently doing something else;
* an un-bought garment can be trialled in an outfit, is marked as such by the
  server, and cannot be recorded as worn.
"""

from __future__ import annotations

from io import BytesIO
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.item import ClothingItem, ItemOwnership
from app.models.user import User
from app.services.recommendation_service import RecommendationService


def _image_bytes(seed: int = 0, size: int = 64) -> bytes:
    """A JPEG whose perceptual hash differs from any other seed's."""
    image = Image.new("RGB", (size, size), (30 + seed * 20 % 200, 90, 160))
    pixels = image.load()
    for x in range(0, size, 3):
        for y in range(0, size, 3):
            pixels[x, y] = ((x * (seed + 3)) % 256, (y * 5 + seed) % 256, (x * y + seed) % 256)
    buf = BytesIO()
    image.save(buf, format="JPEG")
    return buf.getvalue()


async def _upload(
    client: AsyncClient,
    auth_headers: dict[str, str],
    *,
    seed: int,
    name: str,
    item_type: str,
    ownership: str | None = None,
    extra: dict[str, str] | None = None,
):
    data = {"name": name, "type": item_type, "skip_ai": "true"}
    if ownership is not None:
        data["ownership"] = ownership
    if extra:
        data.update(extra)
    return await client.post(
        "/api/v1/items",
        files={"image": (f"{name}.jpg", _image_bytes(seed), "image/jpeg")},
        data=data,
        headers=auth_headers,
    )


@pytest.mark.asyncio
class TestToBuySeparation:
    """待购 must not leak into anything the wardrobe reads."""

    async def test_default_list_and_counts_only_see_owned(
        self, client: AsyncClient, auth_headers, test_user
    ):
        owned = await _upload(client, auth_headers, seed=1, name="Owned shirt", item_type="shirt")
        assert owned.status_code == 201
        pending = await _upload(
            client, auth_headers, seed=2, name="Planned shirt", item_type="shirt", ownership="to_buy"
        )
        assert pending.status_code == 201
        assert pending.json()["ownership"] == "to_buy"

        default_list = (await client.get("/api/v1/items", headers=auth_headers)).json()
        assert default_list["total"] == 1
        assert [i["ownership"] for i in default_list["items"]] == ["owned"]
        assert default_list["items"][0]["id"] == owned.json()["id"]

        # An explicit owned filter is the same answer as the bare default.
        explicit = (await client.get("/api/v1/items?ownership=owned", headers=auth_headers)).json()
        assert explicit["total"] == 1

        to_buy_list = (await client.get("/api/v1/items?ownership=to_buy", headers=auth_headers)).json()
        assert to_buy_list["total"] == 1
        assert to_buy_list["items"][0]["id"] == pending.json()["id"]
        assert to_buy_list["items"][0]["reference_price"] is None

        owned_types = (await client.get("/api/v1/items/types", headers=auth_headers)).json()
        assert owned_types == [{"type": "shirt", "count": 1}]
        to_buy_types = (
            await client.get("/api/v1/items/types?ownership=to_buy", headers=auth_headers)
        ).json()
        assert to_buy_types == [{"type": "shirt", "count": 1}]

        colors_owned = (await client.get("/api/v1/items/colors", headers=auth_headers)).json()
        assert colors_owned == []

    async def test_search_and_paging_stay_inside_one_side(
        self, client: AsyncClient, auth_headers, test_user
    ):
        """Search/paging are decided by the server per ownership, not per loaded page."""
        for index in range(3):
            await _upload(
                client, auth_headers, seed=10 + index, name=f"Search shirt {index}", item_type="shirt"
            )
        await _upload(
            client, auth_headers, seed=20, name="Search shirt planned", item_type="shirt", ownership="to_buy"
        )

        page_one = (
            await client.get(
                "/api/v1/items?search=Search%20shirt&page=1&page_size=2", headers=auth_headers
            )
        ).json()
        assert page_one["total"] == 3
        assert all(item["ownership"] == "owned" for item in page_one["items"])
        page_two = (
            await client.get(
                "/api/v1/items?search=Search%20shirt&page=2&page_size=2", headers=auth_headers
            )
        ).json()
        assert len(page_two["items"]) == 1
        assert page_two["has_more"] is False

        pending = (
            await client.get(
                "/api/v1/items?search=Search%20shirt&ownership=to_buy", headers=auth_headers
            )
        ).json()
        assert pending["total"] == 1

    async def test_bulk_select_all_never_sweeps_up_to_buy(
        self, client: AsyncClient, auth_headers, db_session: AsyncSession, test_user
    ):
        await _upload(client, auth_headers, seed=31, name="Bulk owned", item_type="shirt")
        pending = await _upload(
            client, auth_headers, seed=32, name="Bulk planned", item_type="shirt", ownership="to_buy"
        )
        response = await client.post(
            "/api/v1/items/bulk/delete",
            json={"select_all": True, "filters": {}},
            headers=auth_headers,
        )
        assert response.status_code == 200
        assert response.json()["deleted"] == 1

        still_there = await db_session.get(ClothingItem, UUID(pending.json()["id"]))
        await db_session.refresh(still_there)
        assert still_there is not None
        assert still_there.ownership == ItemOwnership.to_buy

    async def test_recommendation_candidates_exclude_to_buy(
        self, client: AsyncClient, auth_headers, db_session: AsyncSession, test_user
    ):
        owned = await _upload(client, auth_headers, seed=41, name="Rec owned", item_type="shirt")
        pending = await _upload(
            client, auth_headers, seed=42, name="Rec planned", item_type="shirt", ownership="to_buy"
        )
        service = RecommendationService(db_session)
        candidates = await service.get_candidate_items(
            user=test_user, weather=None, occasion="casual", preferences=None, exclude_items=[]
        )
        ids = {str(item.id) for item in candidates}
        assert owned.json()["id"] in ids
        assert pending.json()["id"] not in ids


@pytest.mark.asyncio
class TestDuplicateAcrossOwnership:
    """One photo, one row — whichever side the row is on."""

    async def test_same_photo_reports_the_to_buy_row_and_keeps_its_ownership(
        self, client: AsyncClient, auth_headers, db_session: AsyncSession, test_user
    ):
        first = await _upload(
            client, auth_headers, seed=51, name="Planned coat", item_type="coat", ownership="to_buy"
        )
        assert first.status_code == 201

        again = await client.post(
            "/api/v1/items",
            files={"image": ("coat.jpg", _image_bytes(51), "image/jpeg")},
            data={"type": "coat"},
            headers=auth_headers,
        )
        assert again.status_code == 409
        detail = again.json()["detail"]
        assert detail["error_code"] == "DUPLICATE_IMAGE"
        assert detail["existing_item_id"] == first.json()["id"]
        assert detail["existing_ownership"] == "to_buy"
        assert "to-buy list" in detail["message"]

        item = await db_session.get(ClothingItem, UUID(first.json()["id"]))
        await db_session.refresh(item)
        assert item.ownership == ItemOwnership.to_buy, "a refused duplicate must not move the row"

    async def test_same_photo_reports_the_owned_row_too(
        self, client: AsyncClient, auth_headers, test_user
    ):
        first = await _upload(client, auth_headers, seed=52, name="Owned coat", item_type="coat")
        assert first.status_code == 201
        again = await client.post(
            "/api/v1/items",
            files={"image": ("coat.jpg", _image_bytes(52), "image/jpeg")},
            data={"type": "coat", "ownership": "to_buy"},
            headers=auth_headers,
        )
        assert again.status_code == 409
        detail = again.json()["detail"]
        assert detail["existing_ownership"] == "owned"
        assert "wardrobe" in detail["message"]


@pytest.mark.asyncio
class TestPurchase:
    """待购 → 已拥有: same row, stable under repeats, clear on stale input."""

    async def test_purchase_keeps_id_images_and_outfit_links(
        self, client: AsyncClient, auth_headers, db_session: AsyncSession, test_user
    ):
        pending = await _upload(
            client, auth_headers, seed=61, name="Plan dress", item_type="skirt", ownership="to_buy",
            extra={"reference_price": "299.50", "source_url": "https://shop.example.com/d/1"},
        )
        assert pending.status_code == 201
        pending_body = pending.json()
        owned = await _upload(client, auth_headers, seed=62, name="Worn top", item_type="top")

        outfit = await client.post(
            "/api/v1/outfits/suggestions",
            json={
                "items": [owned.json()["id"], pending_body["id"]],
                "occasion": "casual",
                "name": "试搭",
            },
            headers=auth_headers,
        )
        assert outfit.status_code == 201
        assert outfit.json()["contains_to_buy"] is True
        assert {i["ownership"] for i in outfit.json()["items"]} == {"owned", "to_buy"}
        outfit_id = outfit.json()["id"]

        purchased = await client.post(
            f"/api/v1/items/{pending_body['id']}/purchase", headers=auth_headers
        )
        assert purchased.status_code == 200
        body = purchased.json()
        assert body["id"] == pending_body["id"]
        assert body["ownership"] == "owned"
        assert body["image_path"] == pending_body["image_path"]
        assert body["thumbnail_path"] == pending_body["thumbnail_path"]
        assert body["reference_price"] == "299.50"
        assert body["source_url"] == "https://shop.example.com/d/1"
        # A reference price is not a paid amount.
        assert body["purchase_price"] is None

        counts = (await client.get("/api/v1/items", headers=auth_headers)).json()
        assert counts["total"] == 2
        pending_list = (await client.get("/api/v1/items?ownership=to_buy", headers=auth_headers)).json()
        assert pending_list["total"] == 0

        reopened = await client.get(f"/api/v1/outfits/{outfit_id}", headers=auth_headers)
        assert reopened.status_code == 200
        assert reopened.json()["contains_to_buy"] is False
        assert {i["ownership"] for i in reopened.json()["items"]} == {"owned"}
        assert len(reopened.json()["items"]) == 2, "no garment may be lost by the transition"

    async def test_repeat_and_racing_purchase_yield_one_row(
        self, client: AsyncClient, auth_headers, db_session: AsyncSession, test_user
    ):
        pending = await _upload(
            client, auth_headers, seed=63, name="Plan bag", item_type="bag", ownership="to_buy"
        )
        item_id = pending.json()["id"]

        first = await client.post(f"/api/v1/items/{item_id}/purchase", headers=auth_headers)
        second = await client.post(f"/api/v1/items/{item_id}/purchase", headers=auth_headers)
        assert first.status_code == second.status_code == 200
        assert first.json()["id"] == second.json()["id"] == item_id
        assert second.json()["ownership"] == "owned"

        # The concurrent case, at the level that actually decides it: the transition is
        # one conditional UPDATE, so a second one racing it matches zero rows.
        raced = await db_session.execute(
            update(ClothingItem)
            .where(
                ClothingItem.id == UUID(item_id),
                ClothingItem.ownership == ItemOwnership.to_buy,
            )
            .values(ownership=ItemOwnership.owned)
        )
        assert raced.rowcount == 0, "an already-owned row must not be flipped a second time"

        rows = (
            await db_session.execute(select(ClothingItem).where(ClothingItem.user_id == test_user.id))
        ).scalars().all()
        assert len(rows) == 1
        assert (await client.get("/api/v1/items", headers=auth_headers)).json()["total"] == 1

    async def test_purchase_of_archived_item_is_refused_with_a_reason(
        self, client: AsyncClient, auth_headers, test_user
    ):
        pending = await _upload(
            client, auth_headers, seed=64, name="Plan hat", item_type="hat", ownership="to_buy"
        )
        item_id = pending.json()["id"]
        archived = await client.post(
            f"/api/v1/items/{item_id}/archive", json={"reason": "mistake"}, headers=auth_headers
        )
        assert archived.status_code == 200

        response = await client.post(f"/api/v1/items/{item_id}/purchase", headers=auth_headers)
        assert response.status_code == 409
        assert response.json()["detail"]["error_code"] == "ITEM_ARCHIVED"

        # Still 待购: the refusal must not have half-applied the transition. Read by id,
        # because the default 待购 list (like the wardrobe list) hides archived rows.
        still = (await client.get(f"/api/v1/items/{item_id}", headers=auth_headers)).json()
        assert still["ownership"] == "to_buy"
        assert still["is_archived"] is True

    async def test_purchase_of_unknown_or_foreign_id_is_404(
        self, client: AsyncClient, auth_headers, test_user
    ):
        missing = await client.post(
            f"/api/v1/items/{uuid4()}/purchase", headers=auth_headers
        )
        assert missing.status_code == 404
        assert missing.json()["detail"]["error_code"] == "ITEM_NOT_FOUND"

    async def test_purchase_of_another_accounts_item_is_404(
        self, client: AsyncClient, auth_headers, db_session: AsyncSession, test_user
    ):
        other_user = User(
            id=uuid4(),
            external_id=f"foreign-{uuid4()}",
            email=f"foreign-{uuid4()}@example.com",
            display_name="Other account",
            timezone="UTC",
            is_active=True,
        )
        db_session.add(other_user)
        await db_session.flush()
        other = ClothingItem(
            user_id=other_user.id,
            image_path="foreign/original.jpg",
            type="shirt",
            ownership=ItemOwnership.to_buy,
        )
        db_session.add(other)
        await db_session.commit()

        response = await client.post(f"/api/v1/items/{other.id}/purchase", headers=auth_headers)
        assert response.status_code == 404
        refreshed = await db_session.get(ClothingItem, other.id)
        await db_session.refresh(refreshed)
        assert refreshed.ownership == ItemOwnership.to_buy


@pytest.mark.asyncio
class TestDeleteGuard:
    """A stale 待购 screen may not delete a garment that has become owned."""

    async def test_guard_refuses_an_owned_item_and_keeps_it(
        self, client: AsyncClient, auth_headers, db_session: AsyncSession, test_user
    ):
        owned = await _upload(client, auth_headers, seed=71, name="Stale delete", item_type="shirt")
        item_id = owned.json()["id"]
        response = await client.delete(f"/api/v1/items/{item_id}?ownership=to_buy", headers=auth_headers)
        assert response.status_code == 409
        assert response.json()["detail"]["error_code"] == "ITEM_OWNERSHIP_CHANGED"
        assert await db_session.get(ClothingItem, UUID(item_id)) is not None

    async def test_guard_allows_a_real_to_buy_delete(
        self, client: AsyncClient, auth_headers, db_session: AsyncSession, test_user
    ):
        pending = await _upload(
            client, auth_headers, seed=72, name="Delete plan", item_type="shirt", ownership="to_buy"
        )
        item_id = pending.json()["id"]
        response = await client.delete(f"/api/v1/items/{item_id}?ownership=to_buy", headers=auth_headers)
        assert response.status_code == 204
        assert await db_session.get(ClothingItem, UUID(item_id)) is None

    async def test_unguarded_delete_keeps_the_pre_round_4_behaviour(
        self, client: AsyncClient, auth_headers, test_user
    ):
        owned = await _upload(client, auth_headers, seed=73, name="Plain delete", item_type="shirt")
        response = await client.delete(f"/api/v1/items/{owned.json()['id']}", headers=auth_headers)
        assert response.status_code == 204


@pytest.mark.asyncio
class TestNotWornWhileToBuy:
    """An un-bought garment has not been worn, on every wear path."""

    async def test_item_wear_is_refused(self, client: AsyncClient, auth_headers, test_user):
        pending = await _upload(
            client, auth_headers, seed=81, name="Plan boots", item_type="boots", ownership="to_buy"
        )
        response = await client.post(
            f"/api/v1/items/{pending.json()['id']}/wear", json={}, headers=auth_headers
        )
        assert response.status_code == 409
        assert response.json()["detail"]["error_code"] == "ITEM_NOT_OWNED_YET"

        after = (await client.get(f"/api/v1/items/{pending.json()['id']}", headers=auth_headers)).json()
        assert after["wear_count"] == 0
        assert after["last_worn_at"] is None

    async def test_outfit_feedback_worn_is_refused(
        self, client: AsyncClient, auth_headers, db_session: AsyncSession, test_user
    ):
        owned = await _upload(client, auth_headers, seed=82, name="Wear top", item_type="top")
        pending = await _upload(
            client, auth_headers, seed=83, name="Wear plan", item_type="shirt", ownership="to_buy"
        )
        outfit = await client.post(
            "/api/v1/outfits/suggestions",
            json={"items": [owned.json()["id"], pending.json()["id"]], "occasion": "casual"},
            headers=auth_headers,
        )
        assert outfit.status_code == 201
        outfit_id = outfit.json()["id"]

        refused = await client.post(
            f"/api/v1/outfits/{outfit_id}/feedback",
            json={"worn": True},
            headers=auth_headers,
        )
        assert refused.status_code == 409
        assert refused.json()["detail"]["error_code"] == "OUTFIT_CONTAINS_TO_BUY"

        # Neither garment collected a wear, and the outfit is still openable.
        for item_id in (owned.json()["id"], pending.json()["id"]):
            item = (await client.get(f"/api/v1/items/{item_id}", headers=auth_headers)).json()
            assert item["wear_count"] == 0
        assert (await client.get(f"/api/v1/outfits/{outfit_id}", headers=auth_headers)).status_code == 200

    async def test_feedback_worn_works_once_everything_is_owned(
        self, client: AsyncClient, auth_headers, test_user
    ):
        owned = await _upload(client, auth_headers, seed=84, name="Wear top 2", item_type="top")
        pending = await _upload(
            client, auth_headers, seed=85, name="Wear plan 2", item_type="shirt", ownership="to_buy"
        )
        outfit = await client.post(
            "/api/v1/outfits/suggestions",
            json={"items": [owned.json()["id"], pending.json()["id"]], "occasion": "casual"},
            headers=auth_headers,
        )
        outfit_id = outfit.json()["id"]
        await client.post(f"/api/v1/items/{pending.json()['id']}/purchase", headers=auth_headers)

        accepted = await client.post(
            f"/api/v1/outfits/{outfit_id}/feedback", json={"worn": True}, headers=auth_headers
        )
        assert accepted.status_code == 200
        assert accepted.json()["worn_at"] is not None
        item = (await client.get(f"/api/v1/items/{owned.json()['id']}", headers=auth_headers)).json()
        assert item["wear_count"] == 1


@pytest.mark.asyncio
class TestToBuyValidation:
    """Money and links are validated on the server, not only in the form."""

    @pytest.mark.parametrize(
        "field,value,message_fragment",
        [
            ("reference_price", "1.234", "两位小数"),
            ("reference_price", "-5", "greater than or equal to 0"),
            ("reference_price", "abc", "decimal"),
            ("source_url", "javascript:alert(1)", "http://"),
            ("source_url", "ftp://example.com/x", "http://"),
        ],
    )
    async def test_invalid_values_are_rejected(
        self, client: AsyncClient, auth_headers, field, value, message_fragment
    ):
        response = await _upload(
            client, auth_headers, seed=90, name="Bad value", item_type="shirt", extra={field: value}
        )
        assert response.status_code == 422
        assert message_fragment in str(response.json())

    async def test_empty_values_are_stored_as_null(
        self, client: AsyncClient, auth_headers, test_user
    ):
        response = await _upload(
            client,
            auth_headers,
            seed=91,
            name="Blank fields",
            item_type="shirt",
            ownership="to_buy",
            extra={"reference_price": "", "source_url": "   "},
        )
        assert response.status_code == 201
        assert response.json()["reference_price"] is None, "an empty price is not 0"
        assert response.json()["source_url"] is None

    async def test_legacy_create_without_ownership_still_enters_the_wardrobe(
        self, client: AsyncClient, auth_headers, test_user
    ):
        """The pre-round-4 request shape must keep doing exactly what it did."""
        response = await client.post(
            "/api/v1/items",
            files={"image": ("legacy.jpg", _image_bytes(92), "image/jpeg")},
            data={"type": "shirt", "name": "Legacy upload"},
            headers=auth_headers,
        )
        assert response.status_code == 201
        assert response.json()["ownership"] == "owned"
        listed = (await client.get("/api/v1/items", headers=auth_headers)).json()
        assert listed["total"] == 1


@pytest.mark.asyncio
class TestToBuyEdit:
    """Fields stay editable; ownership does not ride along with a generic patch."""

    async def test_edit_updates_the_to_buy_fields_without_moving_the_row(
        self, client: AsyncClient, auth_headers, db_session: AsyncSession, test_user
    ):
        pending = await _upload(
            client, auth_headers, seed=95, name="Edit plan", item_type="shirt", ownership="to_buy",
            extra={"reference_price": "88.00"},
        )
        item_id = pending.json()["id"]

        patched = await client.patch(
            f"/api/v1/items/{item_id}",
            json={"reference_price": "79.90", "source_url": "https://shop.example.com/p/9", "notes": "等打折"},
            headers=auth_headers,
        )
        assert patched.status_code == 200
        body = patched.json()
        assert body["reference_price"] == "79.90"
        assert body["source_url"] == "https://shop.example.com/p/9"
        assert body["ownership"] == "to_buy", "editing must not buy the garment"

        # `ItemUpdate` has no `ownership` field, so a client cannot flip the side by
        # patching attributes at all.
        attempted = await client.patch(
            f"/api/v1/items/{item_id}", json={"ownership": "owned"}, headers=auth_headers
        )
        assert attempted.status_code in (200, 422)
        refreshed = await db_session.get(ClothingItem, UUID(item_id))
        await db_session.refresh(refreshed)
        assert refreshed.ownership == ItemOwnership.to_buy
