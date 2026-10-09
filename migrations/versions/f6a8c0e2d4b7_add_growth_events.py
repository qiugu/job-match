"""add growth events

Revision ID: f6a8c0e2d4b7
Revises: n7h9j1k3m5p7
"""
from alembic import op
import sqlalchemy as sa

revision = "f6a8c0e2d4b7"
down_revision = "n7h9j1k3m5p7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "growth_events",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("event_id", sa.String(length=64), nullable=False),
        sa.Column("event_name", sa.String(length=48), nullable=False),
        sa.Column("visitor_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=True),
        sa.Column("path", sa.String(length=255), nullable=False),
        sa.Column("referrer", sa.String(length=512), nullable=False),
        sa.Column("utm_source", sa.String(length=128), nullable=False),
        sa.Column("utm_medium", sa.String(length=128), nullable=False),
        sa.Column("utm_campaign", sa.String(length=128), nullable=False),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("event_id", name="uq_growth_events_event_id"),
    )
    op.create_index(
        "ix_growth_events_name_occurred",
        "growth_events",
        ["event_name", "occurred_at"],
        unique=False,
    )
    op.create_index(
        "ix_growth_events_user_occurred",
        "growth_events",
        ["user_id", "occurred_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_growth_events_user_occurred", table_name="growth_events")
    op.drop_index("ix_growth_events_name_occurred", table_name="growth_events")
    op.drop_table("growth_events")
