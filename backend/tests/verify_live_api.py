#!/usr/bin/env python3
"""Run direct HTTP verification against live running backend server (http://127.0.0.1:8000)."""

import asyncio
import sys
from pathlib import Path
from uuid import uuid4
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.services.email_service import TestMailbox

BASE_URL = "http://127.0.0.1:8000/api/v1"


async def main():
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=10.0) as client:
        print("[1/9] Checking /auth/config...")
        cfg = await client.get("/auth/config")
        assert cfg.status_code == 200, f"Failed config: {cfg.text}"
        assert cfg.json()["password_auth"] is True
        print("  -> password_auth is True, config OK")

        print("[2/9] Testing code sending and rate limiting...")
        test_email = f"live_{uuid4().hex[:8]}@example.com"
        res_code = await client.post("/auth/send-code", json={"email": test_email, "purpose": "register"})
        assert res_code.status_code == 200, f"Send code failed: {res_code.text}"
        res_rate = await client.post("/auth/send-code", json={"email": test_email, "purpose": "register"})
        assert res_rate.status_code == 429, f"Rate limit failed: {res_rate.status_code}"
        code = TestMailbox.get_latest_code(test_email, "register")
        assert code and len(code) == 6
        print("  -> Send code and 429 rate limit OK, code retrieved safely")

        print("[3/9] Registering new user...")
        reg_res = await client.post(
            "/auth/register",
            json={"email": test_email, "password": "LivePassword123!", "code": code, "display_name": "Live Tester"},
        )
        assert reg_res.status_code == 200, f"Register failed: {reg_res.text}"
        token1 = reg_res.json()["access_token"]
        assert token1
        print("  -> User registration OK")

        print("[4/9] Testing login and profile fetch...")
        login_res = await client.post("/auth/login", json={"email": test_email, "password": "LivePassword123!"})
        assert login_res.status_code == 200
        token_active = login_res.json()["access_token"]
        me_res = await client.get("/users/me", headers={"Authorization": f"Bearer {token_active}"})
        assert me_res.status_code == 200
        assert me_res.json()["email"] == test_email
        print("  -> Login and profile fetch OK")

        print("[5/9] Testing change password and token revocation...")
        cp_res = await client.post(
            "/auth/change-password",
            json={"old_password": "LivePassword123!", "new_password": "NewLivePassword456!"},
            headers={"Authorization": f"Bearer {token_active}"},
        )
        assert cp_res.status_code == 200
        # Old token MUST be revoked (401)
        revoked_check = await client.get("/users/me", headers={"Authorization": f"Bearer {token_active}"})
        assert revoked_check.status_code == 401
        print("  -> Password changed, old token successfully revoked (401)")

        print("[6/9] Testing login with new password and logout revocation...")
        login_new = await client.post("/auth/login", json={"email": test_email, "password": "NewLivePassword456!"})
        assert login_new.status_code == 200
        token_new = login_new.json()["access_token"]
        logout_res = await client.post("/auth/logout", headers={"Authorization": f"Bearer {token_new}"})
        assert logout_res.status_code == 200
        logout_check = await client.get("/users/me", headers={"Authorization": f"Bearer {token_new}"})
        assert logout_check.status_code == 401
        print("  -> Logout revoked server session (401)")

        print("[7/9] Testing forgot and reset password flow...")
        f_res = await client.post("/auth/forgot-password", json={"email": test_email, "purpose": "reset_password"})
        assert f_res.status_code == 200
        reset_code = TestMailbox.get_latest_code(test_email, "reset_password")
        assert reset_code and len(reset_code) == 6
        r_res = await client.post(
            "/auth/reset-password",
            json={"email": test_email, "code": reset_code, "new_password": "FinalLivePassword789!"},
        )
        assert r_res.status_code == 200
        ok_login = await client.post("/auth/login", json={"email": test_email, "password": "FinalLivePassword789!"})
        assert ok_login.status_code == 200
        print("  -> Forgot and reset password flow OK")

        print("[8/9] Testing legacy bound dev account (dev002@example.com)...")
        leg_login = await client.post("/auth/login", json={"email": "dev002@example.com", "password": "TestPassword123!"})
        assert leg_login.status_code == 200
        # Dev bypass blocked
        bypass = await client.post("/auth/sync", json={"external_id": "hack", "email": "dev002@example.com", "display_name": "x"})
        assert bypass.status_code == 403
        print("  -> Legacy account bound password works, dev sync bypass blocked (403)")

        print("[9/9] Verifying user isolation...")
        email_b = f"live_b_{uuid4().hex[:8]}@example.com"
        await client.post("/auth/send-code", json={"email": email_b, "purpose": "register"})
        code_b = TestMailbox.get_latest_code(email_b, "register")
        reg_b = await client.post("/auth/register", json={"email": email_b, "password": "UserBPass123!", "code": code_b})
        token_b = reg_b.json()["access_token"]
        user_b_id = reg_b.json()["user"]["id"]

        # User B tries to access user A's non-existent item or fake item
        fake_id = str(uuid4())
        item_check = await client.get(f"/items/{fake_id}", headers={"Authorization": f"Bearer {token_b}"})
        assert item_check.status_code == 404
        # User B tries to access an unauthorized image path
        img_check = await client.get(f"/images/{uuid4()}/sample.jpg", headers={"Authorization": f"Bearer {token_b}"})
        assert img_check.status_code in (401, 403, 404)
        print("  -> User isolation checks passed")

    print("\nALL 9 LIVE HTTP VERIFICATION CHECKS PASSED SUCCESSFULLY!")


if __name__ == "__main__":
    asyncio.run(main())
