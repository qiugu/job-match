"""匹配额度：注册码发放的「JD 匹配次数」的预扣与归还。

匹配要跑几分钟的 LLM 工作流，因此预扣/归还都走独立短事务——
若放在主请求的长事务里，SQLite 的写锁会被这个几分钟的事务一直持有，
其他请求（包括上传简历、保存）会被阻塞。

策略：调用 LLM 之前原子预扣（`WHERE match_quota > 0` 保证并发下不超发），
失败时归还。这样「次数」只在真正产出结果时消耗。
"""
from __future__ import annotations

from typing import Any, cast

from sqlalchemy import CursorResult, update

from app.core.database import AsyncSessionLocal
from app.core.logging import get_logger
from app.models.user import User

logger = get_logger("quota")


async def reserve_match_quota(user_id: str) -> bool:
    """预扣 1 次匹配额度：成功 True，额度已用完 False。"""
    async with AsyncSessionLocal() as db:
        # UPDATE 语句的 execute 返回 CursorResult（才有 rowcount），
        # 类型存根只标注为 Result，故显式 cast
        result = cast(
            "CursorResult[Any]",
            await db.execute(
                update(User)
                .where(User.id == user_id, User.match_quota > 0)
                .values(match_quota=User.match_quota - 1)
            ),
        )
        await db.commit()
        return result.rowcount == 1


async def refund_match_quota(user_id: str) -> None:
    """匹配失败时归还预扣的额度（不对无限额度账号调用）。"""
    async with AsyncSessionLocal() as db:
        await db.execute(
            update(User)
            .where(User.id == user_id, User.match_quota >= 0)
            .values(match_quota=User.match_quota + 1)
        )
        await db.commit()
    logger.info("已归还匹配额度 | user_id=%s", user_id)
