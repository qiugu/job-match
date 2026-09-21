"""make job attachment unique and merge historical duplicates

Revision ID: m6a8c0e2f4b7
Revises: l5f7a9c2d4e6

并发自动建档此前使用「先查再插」，两个请求可能为同一用户和归一化 JD
各建一张岗位卡。本迁移先按 (user_id, jd_text) 收敛历史重复卡：保留最早创建的
卡作为 canonical，把衍生简历、话术和状态事件全部改挂到 canonical，再删除冗余卡；
最后建立数据库唯一约束，作为并发写入的原子裁决。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime

import sqlalchemy as sa
from alembic import op


revision = "m6a8c0e2f4b7"
down_revision = "l5f7a9c2d4e6"
branch_labels = None
depends_on = None


_STATUS_RANK = {
    "greeting_sent": 0,
    "resume_ready": 1,
    "applied": 2,
    "closed": 3,
}


def _sort_time(value: datetime | None) -> datetime:
    return value or datetime.max


def _newest_non_empty(duplicates: list[sa.RowMapping], field: str) -> str:
    """按更新时间选择字段最新非空值；同一时刻以 id 做稳定决胜。"""
    candidates = [
        row for row in duplicates if str(row[field] or "").strip()
    ]
    if not candidates:
        return ""
    selected = max(
        candidates,
        key=lambda row: (
            row["updated_at"] or row["created_at"] or datetime.min,
            row["id"],
        ),
    )
    return selected[field]


def _merge_duplicate_jobs() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, user_id, jd_text, title, company, status, "
            "created_at, updated_at FROM jobs "
            "ORDER BY user_id, jd_text, created_at, id"
        )
    ).mappings().all()

    groups: dict[tuple[str, str], list[sa.RowMapping]] = defaultdict(list)
    for row in rows:
        groups[(row["user_id"] or "", row["jd_text"] or "")].append(row)

    for duplicates in groups.values():
        if len(duplicates) < 2:
            continue

        canonical = min(
            duplicates,
            key=lambda row: (_sort_time(row["created_at"]), row["id"]),
        )
        redundant = [row for row in duplicates if row["id"] != canonical["id"]]
        redundant_ids = [row["id"] for row in redundant]

        # 保留重复卡上的全部下游资产与事件。job_status_events 没有外键，仍需显式改挂。
        for table in ("derived_resumes", "cover_letters", "job_status_events"):
            bind.execute(
                sa.text(
                    f"UPDATE {table} SET job_id = :canonical "
                    "WHERE job_id = :redundant"
                ),
                [
                    {"canonical": canonical["id"], "redundant": job_id}
                    for job_id in redundant_ids
                ],
            )

        # canonical 使用最强阶段；标题和公司分别选择最新的非空编辑值，避免一个字段
        # 为空的最新记录遮蔽另一条记录上的有效编辑。ID 和创建时间始终来自最早卡，
        # 使外部已有链接保持稳定。
        strongest = max(
            duplicates,
            key=lambda row: (
                _STATUS_RANK.get(row["status"], -1),
                row["updated_at"] or row["created_at"] or datetime.min,
            ),
        )
        title = _newest_non_empty(duplicates, "title")
        company = _newest_non_empty(duplicates, "company")
        updated_at = max(
            (
                row["updated_at"] or row["created_at"]
                for row in duplicates
                if row["updated_at"] is not None or row["created_at"] is not None
            ),
            default=canonical["updated_at"],
        )
        bind.execute(
            sa.text(
                "UPDATE jobs SET title = :title, company = :company, status = :status, "
                "updated_at = :updated_at WHERE id = :canonical"
            ),
            {
                "title": title,
                "company": company,
                "status": strongest["status"],
                "updated_at": updated_at,
                "canonical": canonical["id"],
            },
        )
        bind.execute(
            sa.text("DELETE FROM jobs WHERE id = :redundant"),
            [{"redundant": job_id} for job_id in redundant_ids],
        )


def upgrade() -> None:
    _merge_duplicate_jobs()
    with op.batch_alter_table("jobs") as batch_op:
        batch_op.create_unique_constraint(
            "uq_jobs_user_id_jd_text", ["user_id", "jd_text"]
        )


def downgrade() -> None:
    with op.batch_alter_table("jobs") as batch_op:
        batch_op.drop_constraint(
            "uq_jobs_user_id_jd_text", type_="unique"
        )
