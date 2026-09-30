"""add user credentials and verification codes

Revision ID: 6a7b8c9d0e1f
Revises: f4a5b6c7d8e9
Create Date: 2026-09-30

Round 6 adds password-based authentication, verification codes, and token revocation:
- users: password_hash, email_verified, token_version
- auth_verification_codes: purpose-bound, rate-limited, single-use email verification
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "6a7b8c9d0e1f"
down_revision: str | None = "f4a5b6c7d8e9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. Add credentials and session version to users
    op.add_column("users", sa.Column("password_hash", sa.String(length=255), nullable=True))
    op.add_column(
        "users",
        sa.Column(
            "email_verified",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
            comment="True if user email has been verified",
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "token_version",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("1"),
            comment="Incremented on logout/password reset to revoke existing tokens",
        ),
    )

    # 2. Create verification codes table
    op.create_table(
        "auth_verification_codes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("code_hash", sa.String(length=255), nullable=False),
        sa.Column("purpose", sa.String(length=50), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default=sa.text("5")),
        sa.Column("is_used", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_auth_verification_codes_email", "auth_verification_codes", ["email"]
    )
    op.create_index(
        "ix_auth_verification_codes_purpose", "auth_verification_codes", ["purpose"]
    )


def downgrade() -> None:
    op.drop_index("ix_auth_verification_codes_purpose", table_name="auth_verification_codes")
    op.drop_index("ix_auth_verification_codes_email", table_name="auth_verification_codes")
    op.drop_table("auth_verification_codes")
    op.drop_column("users", "token_version")
    op.drop_column("users", "email_verified")
    op.drop_column("users", "password_hash")
