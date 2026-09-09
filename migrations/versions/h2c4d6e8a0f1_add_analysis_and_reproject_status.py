"""add derived_resumes.analysis_json and reproject job statuses to 4-state model

岗位卡状态机 V2（操作驱动）配套迁移，两道改动：

1. derived_resumes 新增 analysis_json（Text，可空）：
   匹配分析（MatchResult：role/score/requirements/summary）此前仅在 create_match
   响应中实时返回、从不落库，岗位页无法「回看匹配结果」。本列自 V2 起在写链路落库；
   历史记录保持 NULL（不伪造分析）。

2. 存量 jobs.status 一次性重投影到 4 态模型（greeting_sent / resume_ready /
   applied / closed，删除 replied）：
   - replied 且卡下有任意衍生简历 → resume_ready（「已定制即投递阶段」语义）
   - replied 且卡下无衍生简历（仅话术）→ greeting_sent
   - greeting_sent 但卡下已有衍生简历（旧逻辑仅「接受」才推进导致漏网）→ resume_ready
   - applied / closed / resume_ready 一律保留：applied/closed 是用户确认的终态，
     resume_ready 已在旧模型与 accepted 绑定，不因本条迁移回退（保持单调前进不变量）。

downgrade：仅移除 analysis_json 列。状态值不可无损还原（旧 replied 混合语义已被
重投影拆分），不再反向恢复；如需回滚用此前备份的 jobmatch.db。
"""
from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy import text

from alembic import op

revision = "h2c4d6e8a0f1"
down_revision = "g1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1) derived_resumes 增加 analysis_json 列（SQLite batch 重建）
    with op.batch_alter_table("derived_resumes") as batch_op:
        batch_op.add_column(sa.Column("analysis_json", sa.Text(), nullable=True))

    conn = op.get_bind()
    # 2) replied / greeting_sent 中已具备衍生简历的卡 → resume_ready
    conn.execute(
        text(
            """
            UPDATE jobs SET status = 'resume_ready'
            WHERE status IN ('greeting_sent', 'replied')
              AND EXISTS (
                  SELECT 1 FROM derived_resumes d
                  WHERE d.job_id = jobs.id
              )
            """
        )
    )
    # 3) 无衍生简历的 replied（仅话术）→ greeting_sent
    conn.execute(
        text(
            """
            UPDATE jobs SET status = 'greeting_sent'
            WHERE status = 'replied'
              AND NOT EXISTS (
                  SELECT 1 FROM derived_resumes d
                  WHERE d.job_id = jobs.id
              )
            """
        )
    )


def downgrade() -> None:
    with op.batch_alter_table("derived_resumes") as batch_op:
        batch_op.drop_column("analysis_json")
    # 状态不可无损还原（见模块 docstring），此处不再反向修改。
