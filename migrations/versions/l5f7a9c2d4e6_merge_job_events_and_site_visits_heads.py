"""merge job status events and site visits migration heads"""
from __future__ import annotations

from alembic import op

revision = "l5f7a9c2d4e6"
down_revision = ("j3f5a7b9c1d2", "k4e6f8a1c2d3")
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 纯拓扑合并：两条分支的表结构迁移均已执行，这里只把它们收敛为单一 head。
    pass


def downgrade() -> None:
    # 回退合并 revision 后，Alembic 会回到两个父 revision；父迁移本身不回退。
    pass
