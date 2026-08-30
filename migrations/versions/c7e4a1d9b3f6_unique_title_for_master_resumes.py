"""unique title for master_resumes

简历唯一性从「正文指纹去重」改为「标题唯一」：

背景：此前按 content_hash（正文指纹）识别同一份简历，命中即复用已有记录。
这会带来两类问题——
1. 用户上传/新建的简历被静默合并到另一条已有记录上，列表里显示的标题与
   用户上传的文件名不一致，前端还会把本地简历 id 改成那条记录的 id；
2. 列表按指纹二次去重，内容相同的记录只返回一条，其余的看不见也删不掉。
指纹归一化又只去掉空行与行尾空白，抗扰动弱（一个标点就产生新指纹），
既拦不住误重复，又误伤有意为之的分版本命名。

因此改为以标题（用户看到的名字）为唯一键：重名写入直接被数据库拒绝，
接口层返回 409 由用户改名。

步骤：
1. 为现存重名（含空标题）记录追加序号后缀，保证唯一；
2. 建 title 唯一索引 uq_master_resumes_title。

注意：content_hash 列保留不再使用，后续迁移再清理。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "c7e4a1d9b3f6"
down_revision = "b2c6d8e1a90f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, title FROM master_resumes ORDER BY created_at, id")
    ).fetchall()

    taken: set[str] = set()
    for rid, raw_title in rows:
        base = (raw_title or "").strip() or "我的简历"
        candidate = base
        suffix = 2
        while candidate in taken:
            candidate = f"{base} ({suffix})"
            suffix += 1
        taken.add(candidate)
        if candidate != (raw_title or ""):
            conn.execute(
                sa.text("UPDATE master_resumes SET title = :t WHERE id = :id"),
                {"t": candidate, "id": rid},
            )

    op.create_index(
        "uq_master_resumes_title", "master_resumes", ["title"], unique=True
    )


def downgrade() -> None:
    op.drop_index("uq_master_resumes_title", table_name="master_resumes")
    # 降级不会还原被加过后缀的标题（重名数据在唯一约束下无法原样恢复）。
