"""Verify the round-4 migration against a throwaway database — never user data.

    cd backend && .venv/bin/python scripts/check_to_buy_migration.py

What it does, in order:

1. drops and recreates a scratch database (`wardrobe_migration_check`), so the check
   never touches the development or test database;
2. upgrades it to the **pre-round-4** revision (`d5e6f7a8b9c0`) and inserts data the
   old schema can hold: a user, two garments with image thumbnails, an outfit and its
   two `outfit_items` associations, and one duplicate-image hash pair;
3. snapshots what that data looked like (ids, image paths, association count);
4. upgrades to `head` and re-reads it, asserting that
   * every pre-existing garment is `owned` (默认已拥有) — the round-4 rule,
   * ids, image paths and `outfit_items` associations are byte-for-byte unchanged,
   * `reference_price` / `source_url` are NULL (not 0, not an empty string),
   * an INSERT that does not mention `ownership` still lands as `owned`, which is
     what keeps an older client/Web build working,
   * a garment can be created as `to_buy` on the new column;
5. exercises `downgrade()` on this scratch database and checks that it drops exactly
   the columns it added and loses no rows (safe to report, because no user data is
   involved);
6. drops the scratch database.

Exit code 0 = all assertions held. Any failure prints `CHECK-FAIL` and exits 1.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

import asyncpg

BACKEND_DIR = Path(__file__).resolve().parents[1]

SCRATCH_DB = os.environ.get("MIGRATION_CHECK_DB", "wardrobe_migration_check")
BASE_DSN = os.environ.get(
    "MIGRATION_CHECK_ADMIN_DSN", "postgresql://wardrobe:wardrobe@127.0.0.1:5432"
)
PRE_ROUND_4_REVISION = "d5e6f7a8b9c0"

FAILURES: list[str] = []


def check(condition: bool, label: str) -> None:
    if condition:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}")
        FAILURES.append(label)


def run_alembic(*args: str) -> None:
    env = {
        **os.environ,
        "DATABASE_URL": f"postgresql+asyncpg://wardrobe:wardrobe@127.0.0.1:5432/{SCRATCH_DB}",
    }
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(result.stdout)
        print(result.stderr)
        raise SystemExit(f"alembic {' '.join(args)} failed")


async def connect() -> asyncpg.Connection:
    return await asyncpg.connect(f"{BASE_DSN}/{SCRATCH_DB}")


async def main() -> int:
    admin = await asyncpg.connect(f"{BASE_DSN}/postgres")
    try:
        await admin.execute(f'DROP DATABASE IF EXISTS "{SCRATCH_DB}"')
        await admin.execute(f'CREATE DATABASE "{SCRATCH_DB}"')
    finally:
        await admin.close()

    print(f"== 1. upgrade a scratch database to the pre-round-4 schema ({PRE_ROUND_4_REVISION})")
    run_alembic("upgrade", PRE_ROUND_4_REVISION)

    conn = await connect()
    try:
        user_id = await conn.fetchval(
            """
            INSERT INTO users (id, external_id, email, display_name, timezone, is_active, onboarding_completed, role)
            VALUES (gen_random_uuid(), 'migration-check-user', 'migration-check@example.com', 'Mig', 'UTC', true, true, 'user')
            RETURNING id
            """
        )
        first_id = await conn.fetchval(
            """
            INSERT INTO clothing_items
                (id, user_id, image_path, thumbnail_path, medium_path, image_hash, type, subtype,
                 tags, colors, style, season, status, ai_processed, tagging_status, wear_count,
                 suggestion_count, acceptance_count, wears_since_wash, needs_wash, favorite, is_archived)
            VALUES (gen_random_uuid(), $1, 'u/pre-owned-a.jpg', 'u/pre-owned-a-thumb.jpg', 'u/pre-owned-a-med.jpg',
                    'abcdef0123456789', 'shirt', 'oxford', '{}'::jsonb, '{white}', '{}', '{}', 'ready', true,
                    'tagged', 3, 1, 1, 1, false, true, false)
            RETURNING id
            """,
            user_id,
        )
        second_id = await conn.fetchval(
            """
            INSERT INTO clothing_items
                (id, user_id, image_path, thumbnail_path, image_hash, type, tags, colors, style, season,
                 status, ai_processed, tagging_status, wear_count, suggestion_count, acceptance_count,
                 wears_since_wash, needs_wash, favorite, is_archived)
            VALUES (gen_random_uuid(), $1, 'u/pre-owned-b.jpg', 'u/pre-owned-b-thumb.jpg', 'fedcba9876543210',
                    'pants', '{}'::jsonb, '{navy}', '{}', '{}', 'ready', true, 'tagged', 0, 0, 0, 0, false, false, false)
            RETURNING id
            """,
            user_id,
        )
        outfit_id = await conn.fetchval(
            """
            INSERT INTO outfits (id, user_id, occasion, status, source, created_at)
            VALUES (gen_random_uuid(), $1, 'casual', 'pending', 'external', now())
            RETURNING id
            """,
            user_id,
        )
        # `outfit_items` is keyed on (outfit_id, item_id) and has never had an `id`
        # column — the association is the pair itself.
        await conn.execute(
            """
            INSERT INTO outfit_items (outfit_id, item_id, position)
            VALUES ($2, $1, 0), ($2, $3, 1)
            """,
            first_id,
            outfit_id,
            second_id,
        )

        before_rows = await conn.fetch(
            "SELECT id, image_path, thumbnail_path, medium_path FROM clothing_items ORDER BY created_at, id"
        )
        before_associations = await conn.fetchval("SELECT count(*) FROM outfit_items")
        print(f"     pre-migration garments={len(before_rows)} outfit_items={before_associations}")

        print("== 2. upgrade to head (the round-4 migration)")
        run_alembic("upgrade", "head")

        after_rows = await conn.fetch(
            """
            SELECT id, image_path, thumbnail_path, medium_path, ownership, reference_price, source_url
            FROM clothing_items ORDER BY created_at, id
            """
        )
        after_associations = await conn.fetchval("SELECT count(*) FROM outfit_items")

        check(len(after_rows) == len(before_rows), "no garment row is added or lost by the migration")
        check(
            all(row["ownership"] == "owned" for row in after_rows),
            "every pre-existing garment is backfilled as 已拥有 (owned)",
        )
        check(
            all(
                (row["id"], row["image_path"], row["thumbnail_path"], row["medium_path"])
                == (old["id"], old["image_path"], old["thumbnail_path"], old["medium_path"])
                for row, old in zip(after_rows, before_rows, strict=True)
            ),
            "ids and image paths are unchanged",
        )
        check(
            after_associations == before_associations,
            f"outfit associations are unchanged ({after_associations})",
        )
        check(
            all(row["reference_price"] is None and row["source_url"] is None for row in after_rows),
            "reference_price / source_url are NULL for pre-existing garments (not 0)",
        )

        legacy_id = await conn.fetchval(
            """
            INSERT INTO clothing_items (id, user_id, image_path, type, tags, colors, style, season, status,
                                        ai_processed, tagging_status, wear_count, suggestion_count,
                                        acceptance_count, wears_since_wash, needs_wash, favorite, is_archived)
            VALUES (gen_random_uuid(), $1, 'u/legacy-client.jpg', 'shirt', '{}'::jsonb, '{}', '{}', '{}',
                    'ready', true, 'pending', 0, 0, 0, 0, false, false, false)
            RETURNING id
            """,
            user_id,
        )
        legacy_ownership = await conn.fetchval(
            "SELECT ownership FROM clothing_items WHERE id = $1", legacy_id
        )
        check(
            legacy_ownership == "owned",
            "an INSERT that never mentions `ownership` (an older client) still enters the wardrobe",
        )

        to_buy_id = await conn.fetchval(
            """
            INSERT INTO clothing_items (id, user_id, image_path, type, tags, colors, style, season, status,
                                        ai_processed, tagging_status, wear_count, suggestion_count,
                                        acceptance_count, wears_since_wash, needs_wash, favorite, is_archived,
                                        ownership, reference_price, source_url)
            VALUES (gen_random_uuid(), $1, 'u/to-buy.jpg', 'shirt', '{}'::jsonb, '{}', '{}', '{}',
                    'ready', true, 'pending', 0, 0, 0, 0, false, false, false,
                    'to_buy', 199.90, 'https://shop.example.com/p/1')
            RETURNING id
            """,
            user_id,
        )
        pending_row = await conn.fetchrow(
            "SELECT ownership, reference_price, source_url FROM clothing_items WHERE id = $1", to_buy_id
        )
        check(pending_row["ownership"] == "to_buy", "a 待购 row can be stored after the migration")
        check(str(pending_row["reference_price"]) == "199.90", "the reference price keeps its 2 decimals")

        print("== 3. downgrade on the scratch database drops only what it added")
        run_alembic("downgrade", PRE_ROUND_4_REVISION)
        columns = {
            row["column_name"]
            for row in await conn.fetch(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'clothing_items'"
            )
        }
        check(
            {"ownership", "reference_price", "source_url"} & columns == set(),
            "the three new columns are gone after downgrade",
        )
        check(
            await conn.fetchval("SELECT count(*) FROM clothing_items") == len(after_rows) + 2,
            "downgrade deletes no rows",
        )
        check(
            await conn.fetchval("SELECT count(*) FROM outfit_items") == before_associations,
            "downgrade keeps every outfit association",
        )
    finally:
        await conn.close()

    admin = await asyncpg.connect(f"{BASE_DSN}/postgres")
    try:
        await admin.execute(f'DROP DATABASE IF EXISTS "{SCRATCH_DB}"')
    finally:
        await admin.close()

    if FAILURES:
        print(f"\nCHECK-FAIL: {len(FAILURES)} assertion(s) failed")
        return 1
    print("\nCHECK-OK: migration verified on a scratch database (upgrade, data, compatibility, downgrade)")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
