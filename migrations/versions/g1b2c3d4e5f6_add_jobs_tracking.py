"""add jobs tracking entity and link cover_letters / derived_resumes

岗位卡（Job Tracking）：以 JD 为中心的「机会容器」。

1. 新建 jobs 表：id / user_id / jd_text(归一化) / title / company / status / 时间戳。
2. cover_letters、derived_resumes 各加可空 job_id FK → jobs.id（ondelete=SET NULL）：
   删岗位卡默认仅置空 job_id（话术/匹配作为用户资产仍保留），不级联删除。
3. 历史数据一次性回填：按 (user_id, 归一化 jd_text) 归组既有 cover_letters 与
   derived_resumes，每组建一张岗位卡并回填子记录 job_id；状态推导见下。

状态推导（每组）：
- 组内存在 accepted=1 的衍生简历 → resume_ready
- 否则组内存在任意衍生简历 → replied
- 否则（仅含话术）→ greeting_sent

SQLite 下 add_column / 建表经 batch_alter_table 重建；FK 在 batch 内一并重建。
downgrade：仅删除 jobs 表与两列（已回填的 job_id 一并移除，子记录本身保留）。
"""
from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy import text

from alembic import op

from app.core.text_utils import normalize_jd_text

revision = "g1b2c3d4e5f6"
down_revision = "f1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1) 新建 jobs 表
    op.create_table(
        "jobs",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("user_id", sa.String(length=32), nullable=False, server_default=""),
        sa.Column("jd_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("title", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("company", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="greeting_sent"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_jobs_user_id", "jobs", ["user_id"])
    op.create_index("ix_jobs_status", "jobs", ["status"])

    # 2) 既有表加可空 job_id FK（SET NULL）
    with op.batch_alter_table("cover_letters") as batch_op:
        batch_op.add_column(
            sa.Column(
                "job_id",
                sa.String(length=32),
                sa.ForeignKey(
                    "jobs.id", ondelete="SET NULL", name="fk_cover_letters_job_id"
                ),
                nullable=True,
            )
        )
    with op.batch_alter_table("derived_resumes") as batch_op:
        batch_op.add_column(
            sa.Column(
                "job_id",
                sa.String(length=32),
                sa.ForeignKey(
                    "jobs.id", ondelete="SET NULL", name="fk_derived_resumes_job_id"
                ),
                nullable=True,
            )
        )

    # 3) 历史数据回填：注册归一化函数为 SQLite 标量函数，按 (user_id, 归一化 jd) 归组。
    conn = op.get_bind()
    raw = conn.connection  # DBAPI 连接（sqlite3），用于注册自定义函数
    raw.create_function("norm_jd", 1, normalize_jd_text)

    # 每组建一张岗位卡：取组内最小 created_at 为卡 created_at、最大 updated_at 为 updated_at；
    # 标题取归一化 jd 首 40 字兜底；状态按「是否有 accepted 衍生简历 / 是否有衍生简历」推导。
    conn.execute(
        text(
            """
            INSERT INTO jobs (id, user_id, jd_text, title, status, created_at, updated_at)
            SELECT
                hex(randomblob(16)),
                u,
                nj,
                substr(nj, 1, 40),
                CASE
                    WHEN EXISTS (
                        SELECT 1 FROM derived_resumes d
                        WHERE d.user_id = x.u AND norm_jd(d.jd_text) = x.nj AND d.accepted = 1
                    ) THEN 'resume_ready'
                    WHEN EXISTS (
                        SELECT 1 FROM derived_resumes d
                        WHERE d.user_id = x.u AND norm_jd(d.jd_text) = x.nj
                    ) THEN 'replied'
                    ELSE 'greeting_sent'
                END,
                MIN(created),
                MAX(updated)
            FROM (
                SELECT user_id AS u, norm_jd(jd_text) AS nj,
                       MIN(created_at) AS created, MAX(updated_at) AS updated
                FROM cover_letters
                WHERE jd_text IS NOT NULL AND TRIM(jd_text) <> ''
                GROUP BY user_id, norm_jd(jd_text)
                UNION ALL
                SELECT user_id, norm_jd(jd_text),
                       MIN(created_at), MAX(updated_at)
                FROM derived_resumes
                WHERE jd_text IS NOT NULL AND TRIM(jd_text) <> ''
                GROUP BY user_id, norm_jd(jd_text)
            ) x
            GROUP BY x.u, x.nj
            """
        )
    )

    # 回填子记录 job_id：按 (user_id, 归一化 jd) 匹配到岗位卡
    conn.execute(
        text(
            """
            UPDATE cover_letters SET job_id = (
                SELECT jobs.id FROM jobs
                WHERE jobs.user_id = cover_letters.user_id
                  AND jobs.jd_text = norm_jd(cover_letters.jd_text)
                LIMIT 1
            )
            WHERE job_id IS NULL
              AND jd_text IS NOT NULL AND TRIM(jd_text) <> ''
            """
        )
    )
    conn.execute(
        text(
            """
            UPDATE derived_resumes SET job_id = (
                SELECT jobs.id FROM jobs
                WHERE jobs.user_id = derived_resumes.user_id
                  AND jobs.jd_text = norm_jd(derived_resumes.jd_text)
                LIMIT 1
            )
            WHERE job_id IS NULL
              AND jd_text IS NOT NULL AND TRIM(jd_text) <> ''
            """
        )
    )


def downgrade() -> None:
    with op.batch_alter_table("derived_resumes") as batch_op:
        batch_op.drop_column("job_id")
    with op.batch_alter_table("cover_letters") as batch_op:
        batch_op.drop_column("job_id")
    op.drop_index("ix_jobs_status", table_name="jobs")
    op.drop_index("ix_jobs_user_id", table_name="jobs")
    op.drop_table("jobs")
