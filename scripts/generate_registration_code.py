#!/usr/bin/env python3
"""生成注册码（管理用一次性脚本，直接写数据库，不需要后端服务在跑）。

注册账号必须提供注册码，注册码决定该账号获得多少次「JD 匹配」额度（默认 10 次）。

用法（仓库根目录执行）：

    # 默认：30 天有效、10 次匹配额度、生成 1 个
    uv run python scripts/generate_registration_code.py

    # 自定义有效期/额度/数量/备注
    uv run python scripts/generate_registration_code.py --days 7 --matches 50 --count 3 --note "内测用户"

参数：
    --days      有效天数（默认 30）
    --matches   用该码注册的账号获得的匹配次数（默认取 REGISTRATION_DEFAULT_MATCHES，缺省 10）
    --count     生成数量（默认 1）
    --note      备注，便于识别这批码发给了谁
"""
from __future__ import annotations

import argparse
import secrets
import sys
import uuid
from datetime import timedelta
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from sqlalchemy import create_engine, inspect, text  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.timeutils import utcnow  # noqa: E402

# 去掉 0/O/1/I/L 等易混字符，便于口头或聊天窗口传递
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def generate_code(group_size: int = 4, groups: int = 3) -> str:
    """生成形如 ABCD-EFGH-JKLM 的注册码。"""
    return "-".join(
        "".join(secrets.choice(ALPHABET) for _ in range(group_size))
        for _ in range(groups)
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="生成注册码")
    parser.add_argument("--days", type=int, default=30, help="有效天数（默认 30）")
    parser.add_argument(
        "--matches",
        type=int,
        default=None,
        help="授予的匹配次数（默认取 REGISTRATION_DEFAULT_MATCHES，缺省 10）",
    )
    parser.add_argument("--count", type=int, default=1, help="生成数量（默认 1）")
    parser.add_argument("--note", default="", help="备注（便于识别发给谁）")
    args = parser.parse_args()

    if args.days <= 0:
        print("--days 必须为正数", file=sys.stderr)
        return 2
    matches = (
        args.matches
        if args.matches is not None
        else settings.registration_default_matches
    )
    if matches < 0:
        print("--matches 不能为负（-1 是无限制，仅管理员账号可用）", file=sys.stderr)
        return 2
    if args.count <= 0:
        print("--count 必须为正数", file=sys.stderr)
        return 2

    sync_url = settings.database_url.replace("sqlite+aiosqlite://", "sqlite://")
    engine = create_engine(sync_url, future=True)

    # 校验表存在与写入放在同一事务里：engine.connect() 后的读操作会触发 autobegin，
    # 之后再 conn.begin() 会报「事务已开启」。
    with engine.begin() as conn:
        if "registration_codes" not in inspect(conn).get_table_names():
            print(
                "数据库里还没有 registration_codes 表，请先启动一次后端或执行 "
                "`uv run alembic upgrade head`",
                file=sys.stderr,
            )
            return 1

        now = utcnow()
        expires_at = now + timedelta(days=args.days)
        codes: list[str] = []
        for _ in range(args.count):
            code = generate_code()
            conn.execute(
                text(
                    "INSERT INTO registration_codes "
                    "(id, code, grant_matches, expires_at, redeemed_count, "
                    "last_redeemed_at, used, note, created_at) "
                    "VALUES (:id, :code, :grant_matches, :expires_at, 0, NULL, 0, "
                    ":note, :created_at)"
                ),
                {
                    "id": uuid.uuid4().hex,
                    "code": code,
                    "grant_matches": matches,
                    "expires_at": expires_at,
                    "note": args.note,
                    "created_at": now,
                },
            )
            codes.append(code)

    print(f"数据库：{settings.database_url}")
    print(f"有效期至：{expires_at.isoformat()}（{args.days} 天后过期）")
    print(f"授予匹配次数：{matches}")
    if args.note:
        print(f"备注：{args.note}")
    for code in codes:
        print(f"  注册码：{code}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
