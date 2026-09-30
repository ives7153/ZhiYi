"""End-to-end tests for Round 6: formal authentication, credentials, session revocation, and data isolation."""

import io
from uuid import uuid4
from PIL import Image
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.item import ClothingItem, ItemOwnership
from app.models.user import User
from app.services.email_service import TestMailbox
from app.utils.security import hash_password


def create_test_image_bytes() -> bytes:
    img = Image.new("RGB", (100, 100), color="blue")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


@pytest.fixture(autouse=True)
def clean_test_mailbox():
    TestMailbox.clear()
    yield
    TestMailbox.clear()


@pytest.mark.asyncio
async def test_auth_config_exposes_password_auth(client: AsyncClient):
    res = await client.get("/api/v1/auth/config")
    assert res.status_code == 200
    data = res.json()
    assert data["password_auth"] is True
    assert "oidc" in data


@pytest.mark.asyncio
async def test_legacy_account_login_and_dev_bypass_prevention(
    client: AsyncClient, db_session: AsyncSession
):
    """Verify legacy account with bound password can log in, but CANNOT be bypassed via dev /auth/sync."""
    unique_id = uuid4().hex[:6]
    legacy_email = f"dev002_{unique_id}@example.com"
    legacy_ext_id = f"legacy-dev-user-{unique_id}"
    legacy_user = User(
        external_id=legacy_ext_id,
        email=legacy_email,
        display_name="第二用户",
        password_hash=hash_password("TestPassword123!"),
        email_verified=True,
        token_version=2,
    )
    db_session.add(legacy_user)
    await db_session.commit()
    await db_session.refresh(legacy_user)

    # 1. Dev sync bypass attempt should be blocked with 403
    sync_res = await client.post(
        "/api/v1/auth/sync",
        json={
                "external_id": "malicious-takeover",
                "email": legacy_email,
                "display_name": "Attacker",
        },
    )
    assert sync_res.status_code == 403
    assert "禁止通过开发免密入口登录" in sync_res.json()["detail"]

    # 1b. New registrant cannot claim existing account with same email via /auth/send-code
    claim_res = await client.post(
        "/api/v1/auth/send-code",
        json={"email": legacy_email, "purpose": "register"},
    )
    assert claim_res.status_code == 409
    # 2. Login with correct password succeeds
    login_res = await client.post(
        "/api/v1/auth/login",
        json={"email": legacy_email, "password": "TestPassword123!"},
    )
    assert login_res.status_code == 200
    token_data = login_res.json()
    token = token_data["access_token"]
    assert token
    assert token_data["user"]["email"] == legacy_email

    # 3. Access protected endpoint
    me_res = await client.get(
        "/api/v1/users/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert me_res.status_code == 200
    assert me_res.json()["email"] == legacy_email

    # 4. Wrong password returns generic 401
    bad_login = await client.post(
        "/api/v1/auth/login",
        json={"email": legacy_email, "password": "WrongPassword123!"},
    )
    assert bad_login.status_code == 401
    assert bad_login.json()["detail"] == "邮箱或密码错误"

@pytest.mark.asyncio
async def test_registration_and_rate_limiting(client: AsyncClient):
    """Verify code sending, rate limiting, and new user registration."""
    unique_email = f"user_{uuid4().hex[:8]}@test-zhiyi.com"

    # 1. Send registration code
    send_res = await client.post(
        "/api/v1/auth/send-code",
        json={"email": unique_email, "purpose": "register"},
    )
    assert send_res.status_code == 200
    assert send_res.json()["success"] is True
    assert send_res.json()["delivery_mode"] in ("test_mailbox", "smtp")

    # 2. Immediate re-request should be rate-limited (429)
    rate_res = await client.post(
        "/api/v1/auth/send-code",
        json={"email": unique_email, "purpose": "register"},
    )
    assert rate_res.status_code == 429

    # 3. Retrieve code from isolated TestMailbox
    code = TestMailbox.get_latest_code(unique_email, purpose="register")
    assert code is not None
    assert len(code) == 6

    # 4. Attempt registration with wrong code
    bad_reg = await client.post(
        "/api/v1/auth/register",
        json={
            "email": unique_email,
            "password": "SecurePassword123!",
            "code": "999999",
            "display_name": "Test User",
        },
    )
    assert bad_reg.status_code == 400
    assert "验证码错误" in bad_reg.json()["detail"]

    # 5. Successful registration
    reg_res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": unique_email,
            "password": "SecurePassword123!",
            "code": code,
            "display_name": "Test User",
        },
    )
    assert reg_res.status_code == 200
    reg_data = reg_res.json()
    token = reg_data["access_token"]
    assert token
    assert reg_data["user"]["email"] == unique_email
    assert reg_data["user"]["email_verified"] is True

    # 6. Re-using the same code fails (atomic single-use)
    reuse_res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": unique_email,
            "password": "SecurePassword123!",
            "code": code,
        },
    )
    assert reuse_res.status_code == 400


@pytest.mark.asyncio
async def test_session_revocation_on_logout_and_password_change(client: AsyncClient):
    """Verify that logging out or changing password immediately invalidates existing JWT tokens on server."""
    user_email = f"revoc_{uuid4().hex[:8]}@test-zhiyi.com"

    # Register user
    await client.post(
        "/api/v1/auth/send-code", json={"email": user_email, "purpose": "register"}
    )
    code = TestMailbox.get_latest_code(user_email, purpose="register")
    reg_res = await client.post(
        "/api/v1/auth/register",
        json={"email": user_email, "password": "OldPassword123!", "code": code},
    )
    old_token = reg_res.json()["access_token"]

    # Verify old token works
    check1 = await client.get("/api/v1/users/me", headers={"Authorization": f"Bearer {old_token}"})
    assert check1.status_code == 200

    # Change password
    cp_res = await client.post(
        "/api/v1/auth/change-password",
        json={"old_password": "OldPassword123!", "new_password": "NewPassword456!"},
        headers={"Authorization": f"Bearer {old_token}"},
    )
    assert cp_res.status_code == 200

    # Crucial security check: Old token must be rejected (401 Revoked)
    check2 = await client.get("/api/v1/users/me", headers={"Authorization": f"Bearer {old_token}"})
    assert check2.status_code == 401
    assert "revoked" in check2.json()["detail"].lower()

    # Login with new password
    new_login = await client.post(
        "/api/v1/auth/login",
        json={"email": user_email, "password": "NewPassword456!"},
    )
    assert new_login.status_code == 200
    new_token = new_login.json()["access_token"]

    # Logout revokes the new session
    logout_res = await client.post(
        "/api/v1/auth/logout",
        headers={"Authorization": f"Bearer {new_token}"},
    )
    assert logout_res.status_code == 200

    # Token after logout must be rejected (401)
    check3 = await client.get("/api/v1/users/me", headers={"Authorization": f"Bearer {new_token}"})
    assert check3.status_code == 401


@pytest.mark.asyncio
async def test_forgot_and_reset_password_flow(client: AsyncClient):
    """Verify forgot password flow, email verification, and token invalidation on reset."""
    user_email = f"reset_{uuid4().hex[:8]}@test-zhiyi.com"

    # Create user
    await client.post(
        "/api/v1/auth/send-code", json={"email": user_email, "purpose": "register"}
    )
    code = TestMailbox.get_latest_code(user_email, "register")
    await client.post(
        "/api/v1/auth/register",
        json={"email": user_email, "password": "FirstPassword123!", "code": code},
    )

    # Login to get active token
    login1 = await client.post(
        "/api/v1/auth/login", json={"email": user_email, "password": "FirstPassword123!"}
    )
    assert login1.status_code == 200
    active_token = login1.json()["access_token"]

    # Request reset code
    forgot_res = await client.post(
        "/api/v1/auth/forgot-password",
        json={"email": user_email, "purpose": "reset_password"},
    )
    assert forgot_res.status_code == 200
    reset_code = TestMailbox.get_latest_code(user_email, "reset_password")
    assert reset_code is not None

    # Reset password
    reset_res = await client.post(
        "/api/v1/auth/reset-password",
        json={"email": user_email, "code": reset_code, "new_password": "ResetPassword999!"},
    )
    assert reset_res.status_code == 200

    # Prior token is invalidated
    check = await client.get(
        "/api/v1/users/me", headers={"Authorization": f"Bearer {active_token}"}
    )
    assert check.status_code == 401

    # Old password cannot log in
    bad_login = await client.post(
        "/api/v1/auth/login", json={"email": user_email, "password": "FirstPassword123!"}
    )
    assert bad_login.status_code == 401

    # New password can log in
    ok_login = await client.post(
        "/api/v1/auth/login", json={"email": user_email, "password": "ResetPassword999!"}
    )
    assert ok_login.status_code == 200


@pytest.mark.asyncio
async def test_multitenant_data_isolation_between_user_a_and_b(
    client: AsyncClient, db_session: AsyncSession
):
    """Verify strict authorization isolation between User A and User B."""
    email_a = f"a_{uuid4().hex[:8]}@test-zhiyi.com"
    email_b = f"b_{uuid4().hex[:8]}@test-zhiyi.com"

    # 1. Register User A
    await client.post("/api/v1/auth/send-code", json={"email": email_a, "purpose": "register"})
    code_a = TestMailbox.get_latest_code(email_a, "register")
    res_a = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email_a,
            "password": "UserAPassword123!",
            "code": code_a,
            "display_name": "User A",
        },
    )
    token_a = res_a.json()["access_token"]
    user_a_id = res_a.json()["user"]["id"]

    # 2. Register User B
    await client.post("/api/v1/auth/send-code", json={"email": email_b, "purpose": "register"})
    code_b = TestMailbox.get_latest_code(email_b, "register")
    res_b = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email_b,
            "password": "UserBPassword123!",
            "code": code_b,
            "display_name": "User B",
        },
    )
    token_b = res_b.json()["access_token"]
    user_b_id = res_b.json()["user"]["id"]

    # 3. User A creates a clothing item directly in DB with ownership=owned
    item_a = ClothingItem(
        user_id=user_a_id,
        type="tops",
        subtype="t_shirt",
        primary_color="white",
        ownership="owned",
        image_path=f"{user_a_id}/test_garment.jpg",
        status="ready",
    )
    # Set actual user_id from A
    user_a_obj = (await db_session.get(User, uuid4())) or (
        await db_session.execute(User.__table__.select().where(User.email == email_a))
    ).first()
    item_a.user_id = user_a_obj.id
    db_session.add(item_a)
    await db_session.commit()
    await db_session.refresh(item_a)
    item_a_id = str(item_a.id)

    # 4. User B cannot read item A (returns 404)
    get_b = await client.get(
        f"/api/v1/items/{item_a_id}",
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert get_b.status_code == 404

    # 5. User B cannot update item A (returns 404)
    patch_b = await client.patch(
        f"/api/v1/items/{item_a_id}",
        json={"notes": "Hacked by B"},
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert patch_b.status_code == 404

    # 6. User B cannot delete item A (returns 404)
    del_b = await client.delete(
        f"/api/v1/items/{item_a_id}",
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert del_b.status_code == 404

    # 6b. User B cannot purchase or trigger AI analysis on User A's item (returns 404)
    pur_b = await client.post(
        f"/api/v1/items/{item_a_id}/purchase",
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert pur_b.status_code == 404

    an_b = await client.post(
        f"/api/v1/items/{item_a_id}/analyze",
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert an_b.status_code == 404

    # 6c. User B bulk action with User A's item ID is rejected (404 No matching items found)
    bulk_b = await client.post(
        "/api/v1/items/bulk/cancel-analysis",
        json={"item_ids": [item_a_id]},
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert bulk_b.status_code in (200, 404)
    if bulk_b.status_code == 200:
        assert bulk_b.json().get("cancelled_count", 0) == 0

    # 7. User B cannot access User A's private image directly, nor with expired/tampered signature
    img_res = await client.get(
        f"/api/v1/images/{item_a.user_id}/test_garment.jpg",
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert img_res.status_code in (401, 403)

    expired_img_res = await client.get(
        f"/api/v1/images/{item_a.user_id}/test_garment.jpg?expires=1000000000&sig=deadbeef",
    )
    assert expired_img_res.status_code == 401

    # 8. User B cannot create outfit referencing User A's item
    outfit_res = await client.post(
        "/api/v1/outfits/studio",
        json={
            "name": "Malicious Outfit",
            "items": [item_a_id],
            "occasion": "casual",
        },
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert outfit_res.status_code == 403
    assert outfit_res.json()["detail"]["error_code"] == "OUTFIT_ITEM_OWNERSHIP"

    # 9. User B's wardrobe list does not include User A's item
    list_b = await client.get(
        "/api/v1/items",
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert list_b.status_code == 200
    items_b = list_b.json()["items"]
    assert all(i["id"] != item_a_id for i in items_b)

    # 10. User A profile & location update is isolated from User B
    prof_a = await client.patch(
        "/api/v1/users/me",
        json={
            "display_name": "User A Updated",
            "location_name": "北京",
            "location_lat": 39.9075,
            "location_lon": 116.3972,
        },
        headers={"Authorization": f"Bearer {token_a}"},
    )
    assert prof_a.status_code == 200
    assert prof_a.json()["display_name"] == "User A Updated"
    assert prof_a.json()["location_name"] == "北京"
    assert prof_a.json()["email_verified"] is True
    assert prof_a.json()["has_password"] is True

    prof_b = await client.get(
        "/api/v1/users/me",
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert prof_b.status_code == 200
    assert prof_b.json()["location_name"] is None


@pytest.mark.asyncio
async def test_code_purpose_isolation_expiry_and_max_attempts(
    client: AsyncClient, db_session: AsyncSession
):
    """Verify verification code purpose binding, expiration, and attempt limits."""
    from datetime import UTC, datetime, timedelta
    from app.models.auth_code import AuthVerificationCode
    from app.utils.security import hash_code

    email = f"sec_{uuid4().hex[:8]}@test-zhiyi.com"
    await client.post("/api/v1/auth/send-code", json={"email": email, "purpose": "register"})
    reg_code = TestMailbox.get_latest_code(email, "register")
    assert reg_code is not None

    # 1. Purpose mismatch: cannot use a register code on reset-password
    mismatch = await client.post(
        "/api/v1/auth/reset-password",
        json={"email": email, "code": reg_code, "new_password": "Password123!"},
    )
    assert mismatch.status_code == 400

    # 2. Max attempts exhaustion (5 wrong tries invalidate the code)
    for _ in range(5):
        bad = await client.post(
            "/api/v1/auth/register",
            json={"email": email, "password": "Password123!", "code": "000000"},
        )
        assert bad.status_code == 400

    # Now even the correct code must be rejected because attempts >= max_attempts
    exhausted = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Password123!", "code": reg_code},
    )
    assert exhausted.status_code == 400
    assert "超限" in exhausted.json()["detail"] or "无效" in exhausted.json()["detail"]

    # 3. Expired code is rejected
    expired_email = f"exp_{uuid4().hex[:8]}@test-zhiyi.com"
    expired_record = AuthVerificationCode(
        email=expired_email,
        code_hash=hash_code("123456"),
        purpose="register",
        expires_at=datetime.now(UTC) - timedelta(minutes=1),
    )
    db_session.add(expired_record)
    await db_session.commit()

    exp_res = await client.post(
        "/api/v1/auth/register",
        json={"email": expired_email, "password": "Password123!", "code": "123456"},
    )
    assert exp_res.status_code == 400
    assert "过期" in exp_res.json()["detail"] or "无效" in exp_res.json()["detail"]


@pytest.mark.asyncio
async def test_formal_mode_disables_dev_sync_and_worker_checks_ownership(
    client: AsyncClient, db_session: AsyncSession, monkeypatch
):
    """Verify formal mode (debug=False) blocks /auth/sync and worker enforces user ownership."""
    from app.api import auth as auth_api
    from app.workers import tagging

    # 1. Simulate formal mode (debug=False, no OIDC)
    monkeypatch.setattr(auth_api, "_is_dev_mode", lambda: False)
    monkeypatch.setattr(auth_api, "_oidc_configured", lambda: False)

    sync_res = await client.post(
        "/api/v1/auth/sync",
        json={
            "external_id": "dev-attacker",
            "email": "victim@example.com",
            "display_name": "Attacker",
        },
    )
    assert sync_res.status_code == 503

    # 2. Worker ownership check rejects mismatched user_id
    user_a = User(
        external_id=f"worker-a-{uuid4().hex[:6]}",
        email=f"wa_{uuid4().hex[:6]}@example.com",
        display_name="Worker A",
        is_active=True,
    )
    db_session.add(user_a)
    await db_session.commit()
    await db_session.refresh(user_a)

    item_a = ClothingItem(
        user_id=user_a.id,
        type="tops",
        ownership="owned",
        image_path=f"{user_a.id}/test.jpg",
        status="processing",
    )
    db_session.add(item_a)
    await db_session.commit()
    await db_session.refresh(item_a)

    class _NoCloseSession:
        def __init__(self, s):
            self._s = s
        async def execute(self, *a, **kw):
            return await self._s.execute(*a, **kw)
        async def commit(self):
            await self._s.commit()
        async def close(self):
            pass

    monkeypatch.setattr(tagging, "get_db_session", lambda ctx: _NoCloseSession(db_session))
    wrong_user_id = str(uuid4())
    worker_res = await tagging.tag_item_image({}, str(item_a.id), __file__, user_id=wrong_user_id)
    assert worker_res["status"] == "error"
    assert worker_res["error"] == "Item ownership mismatch"
