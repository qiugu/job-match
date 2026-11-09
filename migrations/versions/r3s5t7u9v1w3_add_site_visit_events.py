"""add append-only site visit events (true PV + deduplicated UV)

旧表 site_visits 以 (visit_date, visitor_hash, path) 唯一约束去重，只能度量
「访客×路径」组合数，无法表达真实 PV。本迁移新增追加式事件表，并把旧表数据
按 1 行 = 1 次浏览回填作为历史基线（旧数据本身已去重，历史 PV 会偏低，
无法还原，故不做放大推算）。旧表保留但不删除，便于审计与回滚。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "r3s5t7u9v1w3"
down_revision = "q9j2k4l6n8p0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "site_visit_events",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("visitor_hash", sa.String(length=64), nullable=False),
        sa.Column("path", sa.String(length=255), nullable=False),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_site_visit_events_occurred_visitor",
        "site_visit_events",
        ["occurred_at", "visitor_hash"],
    )
    # 迁移须自包含，不依赖应用代码：旧表 path 未归一化，但新口径的 PV/UV
    # 不按 path 去重，因此原样回填不影响统计结果。
    op.execute(
        "INSERT INTO site_visit_events (id, visitor_hash, path, occurred_at) "
        "SELECT id, visitor_hash, path, created_at FROM site_visits"
    )


def downgrade() -> None:
    op.drop_index("ix_site_visit_events_occurred_visitor", table_name="site_visit_events")
    op.drop_table("site_visit_events")
