"""add anonymous site visits for admin dashboard"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "k4e6f8a1c2d3"
down_revision = "i2e4f6a8b0c1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "site_visits",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("visit_date", sa.Date(), nullable=False),
        sa.Column("visitor_hash", sa.String(length=64), nullable=False),
        sa.Column("path", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "visit_date", "visitor_hash", "path",
            name="uq_site_visits_day_visitor_path",
        ),
    )
    op.create_index("ix_site_visits_date", "site_visits", ["visit_date"])


def downgrade() -> None:
    op.drop_index("ix_site_visits_date", table_name="site_visits")
    op.drop_table("site_visits")
