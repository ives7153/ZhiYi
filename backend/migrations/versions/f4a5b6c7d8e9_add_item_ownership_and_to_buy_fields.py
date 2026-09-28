"""add item ownership (待购) and reference price / source url

Revision ID: f4a5b6c7d8e9
Revises: d5e6f7a8b9c0
Create Date: 2026-09-28

Round 4 keeps 待购 和 已拥有 on ONE entity (`clothing_items`), told apart by
`ownership`, instead of introducing a second garment table: images, upload
de-duplication, the signed-image pipeline, tagging and the outfit association stay
exactly where they were.

Safety properties of this migration, in the order they matter:

* it only ADDs a column, an index and two nullable columns — no table is rebuilt,
  no row is rewritten, no image or `outfit_items` association is touched;
* `ownership` is created with `server_default 'owned'` and NOT NULL, so every row
  that already exists counts as **已拥有** the moment the column appears, and an
  INSERT from a client that does not know the column keeps working;
* `reference_price` is Numeric(10, 2) — the reference amount is exact decimal
  money, never a float — and `source_url` is a plain, manually typed link: nothing
  is scraped or downloaded. Both stay NULL for existing garments, which is not the
  same as 0;
* `downgrade()` drops only what `upgrade()` added. It does not delete rows, images
  or associations, so a rollback cannot lose user data.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f4a5b6c7d8e9"
down_revision: str | None = "d5e6f7a8b9c0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Declared explicitly rather than via `sa.Enum(..., create_type=False)`: the type is
# created here, by this migration, and reused by the column definition below.
OWNERSHIP_ENUM = sa.Enum("owned", "to_buy", name="item_ownership")

INDEX_NAME = "ix_clothing_items_ownership"


def upgrade() -> None:
    OWNERSHIP_ENUM.create(op.get_bind(), checkfirst=True)

    op.add_column(
        "clothing_items",
        sa.Column(
            "ownership",
            OWNERSHIP_ENUM,
            nullable=False,
            server_default="owned",
            comment="owned = 已拥有; to_buy = 待购 (round 4)",
        ),
    )
    op.add_column(
        "clothing_items",
        sa.Column("reference_price", sa.Numeric(10, 2), nullable=True),
    )
    op.add_column(
        "clothing_items",
        sa.Column("source_url", sa.String(length=500), nullable=True),
    )
    op.create_index(INDEX_NAME, "clothing_items", ["ownership"])


def downgrade() -> None:
    op.drop_index(INDEX_NAME, table_name="clothing_items")
    op.drop_column("clothing_items", "source_url")
    op.drop_column("clothing_items", "reference_price")
    op.drop_column("clothing_items", "ownership")
    OWNERSHIP_ENUM.drop(op.get_bind(), checkfirst=True)
