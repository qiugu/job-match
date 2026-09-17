"""add job_status_events ledger

岗位卡状态事件台账（投递统计分析的数据基础）。

背景：`jobs` 表只有 `created_at` / `updated_at`，而 `updated_at` 带 `onupdate=_now`，
改标题/公司或任一状态推进都会刷新它 ⇒「某天投递了几家」无法从 `jobs` 还原，
用 `updated_at` 近似会导致历史图表随元数据编辑而漂移。本表把每次状态变更
（from → to）与发生时刻固化为只插不改的事实记录。

存量回填（一次性、不可逆推断，已在统计接口以 source='backfill' 显式标注）：
    1. 每张存量卡补一条建卡事件：NULL → greeting_sent @ created_at；
    2. 当前状态 != greeting_sent 的卡再补一条：greeting_sent → 当前状态 @ updated_at。
    ⚠ 存量卡进入 applied 的真实日期不可考，只能用 updated_at 近似；这是已知不精确，
      前端对回填日以斜纹底纹区分呈现，不把推测当事实。
      漏斗按「累计到达」口径计算，因此缺失中间级（greeting_sent → applied 一步到位）
      不影响漏斗各级计数正确性。

downgrade：整表删除。事件可从业务状态重放（近似），无独立历史包袱。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

revision = "j3f5a7b9c1d2"
down_revision = "i2e4f6a8b0c1"
branch_labels = None
depends_on = None

# 回填时使用的默认态常量（与 app/models/job.py 保持一致；迁移内不 import 应用代码，
# 避免迁移随应用重构而失效——这是 Alembic 的通行约定）。
_DEFAULT_STATUS = "greeting_sent"


def upgrade() -> None:
    op.create_table(
        "job_status_events",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("job_id", sa.String(length=32), nullable=False),
        sa.Column("from_status", sa.String(length=32), nullable=True),
        sa.Column("to_status", sa.String(length=32), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    # 统计主查询路径：某用户某时间窗的事件（user_id 为最左前缀，兼作按用户过滤）
    op.create_index(
        "ix_job_status_events_user_occurred",
        "job_status_events",
        ["user_id", "occurred_at"],
    )
    # 删除岗位卡时按 job_id 清理事件
    op.create_index(
        "ix_job_status_events_job_id", "job_status_events", ["job_id"]
    )

    _backfill_existing_jobs()


def _backfill_existing_jobs() -> None:
    """为存量岗位卡重建近似事件（幂等：跳过已有事件的卡）。"""
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, user_id, status, created_at, updated_at FROM jobs"
        )
    ).fetchall()
    if not rows:
        return

    # 已存在事件的 job_id：避免重复回填（例如手工重跑 upgrade 的场景）
    existing = {
        r[0]
        for r in bind.execute(
            sa.text("SELECT DISTINCT job_id FROM job_status_events")
        ).fetchall()
    }

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    params: list[dict] = []
    for job_id, user_id, status, created_at, updated_at in rows:
        if job_id in existing:
            continue
        created = created_at or updated_at or now
        current = status or _DEFAULT_STATUS
        # 1) 建卡事件（from_status 为 NULL 表示无前驱）
        params.append(
            {
                "id": uuid.uuid4().hex,
                "user_id": user_id or "",
                "job_id": job_id,
                "from_status": None,
                "to_status": _DEFAULT_STATUS,
                "source": "backfill",
                "occurred_at": created,
            }
        )
        # 2) 当前状态非默认态时，再补一条推进事件（时间只能用 updated_at 近似）
        if current != _DEFAULT_STATUS:
            params.append(
                {
                    "id": uuid.uuid4().hex,
                    "user_id": user_id or "",
                    "job_id": job_id,
                    "from_status": _DEFAULT_STATUS,
                    "to_status": current,
                    "source": "backfill",
                    "occurred_at": updated_at or created,
                }
            )

    if not params:
        return
    bind.execute(
        sa.text(
            "INSERT INTO job_status_events "
            "(id, user_id, job_id, from_status, to_status, source, occurred_at) "
            "VALUES (:id, :user_id, :job_id, :from_status, :to_status, :source, :occurred_at)"
        ),
        params,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_job_status_events_job_id", table_name="job_status_events"
    )
    op.drop_index(
        "ix_job_status_events_user_occurred", table_name="job_status_events"
    )
    op.drop_table("job_status_events")
