#!/usr/bin/env python3
"""Controlled CLI tool to bind formal password credentials to legacy development accounts.

Usage:
    python scripts/bind_credentials.py --user-id <UUID> --email <EMAIL> --password <PASSWORD>
"""

import argparse
import asyncio
import re
import sys
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import func, select

from app.database import async_session_maker
from app.models.user import User
from app.utils.security import hash_password


def mask_email(email: str) -> str:
    if "@" not in email:
        return "***"
    local, domain = email.split("@", 1)
    if len(local) <= 2:
        masked_local = local[0] + "***"
    else:
        masked_local = local[0] + "***" + local[-1]
    return f"{masked_local}@{domain}"


async def bind_credentials(user_id_str: str, email: str, password: str) -> int:
    try:
        user_uuid = UUID(user_id_str)
    except ValueError:
        print(f"[ERROR] Invalid UUID format: {user_id_str}", file=sys.stderr)
        return 1

    norm_email = email.strip().lower()
    if not re.match(r"^[^@]+@[^@]+\.[^@]+$", norm_email):
        print(f"[ERROR] Invalid email format: {email}", file=sys.stderr)
        return 1

    if len(password) < 8:
        print("[ERROR] Password must be at least 8 characters long", file=sys.stderr)
        return 1

    async with async_session_maker() as session:
        # Check user by ID
        result = await session.execute(select(User).where(User.id == user_uuid))
        user = result.scalar_one_or_none()

        if user is None:
            print(f"[ERROR] User with ID {user_id_str} not found in database", file=sys.stderr)
            return 1

        # Security check: Email MUST match the existing record to prevent arbitrary account takeover
        if user.email.strip().lower() != norm_email:
            print(
                f"[ERROR] Provided email '{mask_email(norm_email)}' does not match target user's registered email",
                file=sys.stderr,
            )
            return 1

        # Bind credentials
        user.password_hash = hash_password(password)
        user.email_verified = True
        user.token_version = (user.token_version or 1) + 1

        await session.commit()
        await session.refresh(user)

        print("=" * 60)
        print("  LEGACY ACCOUNT CREDENTIAL BINDING SUCCESSFUL")
        print("=" * 60)
        print(f"  User ID:       {user.id}")
        print(f"  Email:         {mask_email(user.email)}")
        print(f"  Display Name:  {user.display_name}")
        print(f"  External ID:   {user.external_id}")
        print(f"  Verified:      {user.email_verified}")
        print(f"  Token Version: {user.token_version}")
        print("=" * 60)
        print("Existing garments, outfits, and associations are preserved intact.")
        print("You can now log in via standard email/password authentication.")
        return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Controlled migration tool: bind password credentials to legacy user account."
    )
    parser.add_argument("--user-id", required=True, help="Target User UUID in database")
    parser.add_argument("--email", required=True, help="Expected email of the target user")
    parser.add_argument("--password", required=True, help="New password to set (min 8 chars)")

    args = parser.parse_args()
    exit_code = asyncio.run(bind_credentials(args.user_id, args.email, args.password))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
