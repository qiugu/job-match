"""岗位卡唯一约束迁移必须无损收敛历史重复数据。"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory


# 被测试迁移：按 (user_id, jd_text) 收敛历史重复岗位卡并新建唯一约束
# （migrations/versions/m6a8c0e2f4b7_make_job_attachment_unique.py）。
# 该 id 固定，不随后续新增迁移改变；它的 down_revision（l5f7a9c2d4e6）才是
# 「前置状态」的锚点——先升级到它，再插入重复数据模拟历史脏数据。
MIGRATION_UNDER_TEST = "m6a8c0e2f4b7"


def _script_directory() -> ScriptDirectory:
    # 不读取带中文注释的 alembic.ini，避免 C/ASCII locale 下把编码问题
    # 误报成迁移图问题（与 tests/test_migration_graph.py 一致）。
    root = Path(__file__).resolve().parents[1]
    config = Config()
    config.set_main_option("script_location", str(root / "migrations"))
    return ScriptDirectory.from_config(config)


def _current_head() -> str:
    """当前迁移链的真实 head（动态取，避免硬编码常量随新增迁移失效）。"""
    head = _script_directory().get_current_head()
    assert head is not None, "迁移图无 head"
    return head


def _previous_head() -> str:
    """被测试迁移的前置 revision：先升级到它，再插入重复数据模拟历史脏数据。"""
    down_revision = _script_directory().get_revision(MIGRATION_UNDER_TEST).down_revision
    assert down_revision is not None, f"{MIGRATION_UNDER_TEST} 缺少 down_revision"
    if isinstance(down_revision, (tuple, list)):
        return down_revision[0]
    return down_revision


def _run_alembic(root: Path, database_url: str, *args: str) -> None:
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", *args],
        cwd=root,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )


def test_job_uniqueness_migration_reparents_associated_records(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[1]
    db_path = tmp_path / "duplicate-jobs.db"
    database_url = f"sqlite+aiosqlite:///{db_path}"
    _run_alembic(root, database_url, "upgrade", _previous_head())

    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "INSERT INTO jobs "
            "(id, user_id, jd_text, title, company, status, created_at, updated_at) "
            "VALUES ('job-old', 'user-1', 'Python engineer', 'original title', "
            "'original company', "
            "'greeting_sent', '2026-01-01', '2026-01-01')"
        )
        connection.execute(
            "INSERT INTO jobs "
            "(id, user_id, jd_text, title, company, status, created_at, updated_at) "
            "VALUES ('job-mid-a', 'user-1', 'Python engineer', 'edited title a', '', "
            "'applied', '2026-01-15', '2026-03-01')"
        )
        connection.execute(
            "INSERT INTO jobs "
            "(id, user_id, jd_text, title, company, status, created_at, updated_at) "
            "VALUES ('job-mid-b', 'user-1', 'Python engineer', 'edited title b', '', "
            "'resume_ready', '2026-01-16', '2026-03-01')"
        )
        connection.execute(
            "INSERT INTO jobs "
            "(id, user_id, jd_text, title, company, status, created_at, updated_at) "
            "VALUES ('job-new', 'user-1', 'Python engineer', '', 'latest company', "
            "'resume_ready', '2026-02-01', '2026-04-01')"
        )
        connection.execute(
            "INSERT INTO derived_resumes "
            "(id, title, jd_text, markdown_content, keywords, has_cover_letter, "
            "created_at, updated_at, accepted, user_id, accepted_master_id, job_id, "
            "analysis_json) VALUES "
            "('derived-1', 'derived', 'Python engineer', '# resume', '[]', 0, "
            "'2026-02-01', '2026-02-01', 0, 'user-1', NULL, 'job-new', NULL)"
        )
        connection.execute(
            "INSERT INTO cover_letters "
            "(id, derived_resume_id, content, created_at, updated_at, user_id, "
            "resume_text, jd_text, scene, model, job_id) VALUES "
            "('letter-1', NULL, 'hello', '2026-02-01', '2026-02-01', 'user-1', "
            "'# resume', 'Python engineer', 'greeting', '', 'job-mid-a')"
        )
        connection.execute(
            "INSERT INTO job_status_events "
            "(id, user_id, job_id, from_status, to_status, source, occurred_at) "
            "VALUES ('event-1', 'user-1', 'job-mid-b', NULL, 'resume_ready', "
            "'create', '2026-02-01')"
        )
        connection.commit()

    _run_alembic(root, database_url, "upgrade", "head")

    with sqlite3.connect(db_path) as connection:
        # head 到位：迁移链走到当前 head，证明被测试迁移已被纳入（动态取，
        # 不再硬编码常量，避免后续新增迁移后此断言必然失败一次）。
        assert connection.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchone() == (_current_head(),)
        assert connection.execute(
            "SELECT id, title, company, status, created_at, updated_at FROM jobs "
            "WHERE user_id = 'user-1' AND jd_text = 'Python engineer'"
        ).fetchall() == [
            (
                "job-old",
                "edited title b",
                "latest company",
                "applied",
                "2026-01-01",
                "2026-04-01",
            )
        ]
        assert connection.execute(
            "SELECT job_id FROM derived_resumes WHERE id = 'derived-1'"
        ).fetchone() == ("job-old",)
        assert connection.execute(
            "SELECT job_id FROM cover_letters WHERE id = 'letter-1'"
        ).fetchone() == ("job-old",)
        assert connection.execute(
            "SELECT job_id FROM job_status_events WHERE id = 'event-1'"
        ).fetchone() == ("job-old",)

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO jobs "
                "(id, user_id, jd_text, title, company, status, created_at, updated_at) "
                "VALUES ('job-third', 'user-1', 'Python engineer', 'third', '', "
                "'greeting_sent', '2026-03-01', '2026-03-01')"
            )
