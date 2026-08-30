"""add content_hash to master_resumes

为简历表新增正文指纹列，用于识别「同一份简历」：
1. 新增 content_hash 列 + 索引；
2. 回填历史数据的指纹；
3. 清理历史重复记录（同一指纹仅保留最早一条）。

注意：步骤 3 会删除重复行，downgrade 无法恢复被删除的数据（仅回滚 schema）。
"""
from __future__ import annotations

import hashlib
import sqlalchemy as sa
from alembic import op

revision = "a1f4c9e7b2d3"
down_revision = "5c1e3f7a2b84"
branch_labels = None
depends_on = None


def _normalize(raw_text: str | None, markdown_content: str | None) -> str:
    text = (raw_text or "").strip() or (markdown_content or "").strip()
    if not text:
        return ""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return "\n".join(line.strip() for line in lines if line.strip())


def _hash(raw_text: str | None, markdown_content: str | None) -> str:
    normalized = _normalize(raw_text, markdown_content)
    if not normalized:
        return ""
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def upgrade() -> None:
    op.add_column(
        "master_resumes",
        sa.Column("content_hash", sa.String(64), nullable=False, server_default=""),
    )
    op.create_index(
        op.f("ix_master_resumes_content_hash"), "master_resumes", ["content_hash"]
    )

    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, raw_text, markdown_content, created_at FROM master_resumes")
    ).fetchall()

    # 指纹 -> 保留的记录 id（最早创建的一条）
    keep_by_hash: dict[str, str] = {}
    # 指纹 -> 保留记录的创建时间，用于选出最早一条
    created_by_hash: dict[str, str] = {}
    hashes: dict[str, str] = {}
    duplicates: list[str] = []

    for row in rows:
        rid = row[0]
        digest = _hash(row[1], row[2])
        hashes[rid] = digest
        if not digest:
            continue
        created = str(row[3])
        kept = keep_by_hash.get(digest)
        if kept is None:
            keep_by_hash[digest] = rid
            created_by_hash[digest] = created
        else:
            # 保留创建时间更早的一条，其余视为重复
            if created < created_by_hash[digest]:
                duplicates.append(kept)
                keep_by_hash[digest] = rid
                created_by_hash[digest] = created
            else:
                duplicates.append(rid)

    for rid, digest in hashes.items():
        conn.execute(
            sa.text("UPDATE master_resumes SET content_hash = :h WHERE id = :id"),
            {"h": digest, "id": rid},
        )

    for rid in duplicates:
        conn.execute(
            sa.text("DELETE FROM master_resumes WHERE id = :id"), {"id": rid}
        )


def downgrade() -> None:
    op.drop_index(op.f("ix_master_resumes_content_hash"), table_name="master_resumes")
    op.drop_column("master_resumes", "content_hash")
