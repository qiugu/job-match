"""Alembic 迁移图必须保持单一 head，避免应用启动时 upgrade head 失败。"""

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory


def test_migrations_have_single_head():
    root = Path(__file__).resolve().parents[1]
    # 不读取带中文注释的 alembic.ini，避免在 C/ASCII locale 下把编码问题
    # 误报成迁移图问题；这里仅检查脚本目录的 revision 拓扑。
    config = Config()
    config.set_main_option("script_location", str(root / "migrations"))
    heads = ScriptDirectory.from_config(config).get_heads()
    assert len(heads) == 1, f"迁移图存在多个 head: {heads}"
