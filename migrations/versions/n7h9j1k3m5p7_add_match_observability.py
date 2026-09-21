"""add persisted resume match observability"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "n7h9j1k3m5p7"
down_revision = "m6a8c0e2f4b7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "match_runs",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("job_id", sa.String(length=32), nullable=True),
        sa.Column("derived_resume_id", sa.String(length=32), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
        sa.Column("match_score", sa.Float(), nullable=True),
        sa.Column("matched_count", sa.Integer(), nullable=False),
        sa.Column("weak_count", sa.Integer(), nullable=False),
        sa.Column("missing_count", sa.Integer(), nullable=False),
        sa.Column("unsupported_count", sa.Integer(), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False),
        sa.Column("completion_tokens", sa.Integer(), nullable=False),
        sa.Column("total_tokens", sa.Integer(), nullable=False),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("error_type", sa.String(length=64), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_match_runs_user_id", "match_runs", ["user_id"])
    op.create_index("ix_match_runs_job_id", "match_runs", ["job_id"])
    op.create_index(
        "ix_match_runs_derived_resume_id", "match_runs", ["derived_resume_id"]
    )
    op.create_index("ix_match_runs_status", "match_runs", ["status"])
    op.create_index("ix_match_runs_started_at", "match_runs", ["started_at"])
    op.create_index("ix_match_runs_created_at", "match_runs", ["created_at"])

    op.create_table(
        "match_run_steps",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("match_run_id", sa.String(length=32), nullable=False),
        sa.Column("step_key", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False),
        sa.Column("completion_tokens", sa.Integer(), nullable=False),
        sa.Column("total_tokens", sa.Integer(), nullable=False),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("error_type", sa.String(length=64), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_match_run_steps_match_run_id", "match_run_steps", ["match_run_id"])
    op.create_index("ix_match_run_steps_step_key", "match_run_steps", ["step_key"])

    with op.batch_alter_table("llm_usage") as batch_op:
        batch_op.add_column(sa.Column("match_run_id", sa.String(length=32), nullable=True))
        batch_op.create_index("ix_llm_usage_match_run_id", ["match_run_id"])


def downgrade() -> None:
    with op.batch_alter_table("llm_usage") as batch_op:
        batch_op.drop_index("ix_llm_usage_match_run_id")
        batch_op.drop_column("match_run_id")
    op.drop_index("ix_match_run_steps_step_key", table_name="match_run_steps")
    op.drop_index("ix_match_run_steps_match_run_id", table_name="match_run_steps")
    op.drop_table("match_run_steps")
    for index_name in (
        "ix_match_runs_created_at",
        "ix_match_runs_started_at",
        "ix_match_runs_status",
        "ix_match_runs_job_id",
        "ix_match_runs_derived_resume_id",
        "ix_match_runs_user_id",
    ):
        op.drop_index(index_name, table_name="match_runs")
    op.drop_table("match_runs")
