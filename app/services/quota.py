"""积分（credits）：JD 简历匹配 / JD 话术生成共享余额的预扣与归还。

匹配要跑几分钟的 LLM 工作流，因此预扣/归还都走独立短事务——
若放在主请求的长事务里，SQLite 的写锁会被这个几分钟的事务一直持有，
其他请求（包括上传简历、保存）会被阻塞。

策略：调用 LLM 之前原子预扣（`WHERE credits >= cost` 保证并发下不超扣成负），
失败时归还。这样「积分」只在真正产出结果时消耗。
每种动作的单价由调用方传入（app.core.config：简历匹配 5、话术生成 1）。
"""
from __future__ import annotations

from typing import Any, cast

from sqlalchemy import CursorResult, update

from app.core.database import AsyncSessionLocal
from app.core.logging import get_logger
from app.models.user import User

logger = get_logger("quota")


async def consume_credits(user_id: str, cost: int = 1) -> bool:
    """原子预扣 cost 积分：余额 >= cost 时成功扣减返回 True，不足返回 False。

    无限额度账号（credits < 0）由调用方在 API 层用 unlimited_credits 提前跳过，
    本函数只处理有界余额（`credits >= cost` 对负值天然不成立）。
    """
    async with AsyncSessionLocal() as db:
        # UPDATE 语句的 execute 返回 CursorResult（才有 rowcount），
        # 类型存根只标注为 Result，故显式 cast
        result = cast(
            "CursorResult[Any]",
            await db.execute(
                update(User)
                .where(User.id == user_id, User.credits >= cost)
                .values(credits=User.credits - cost)
            ),
        )
        await db.commit()
        return result.rowcount == 1


async def refund_credits(user_id: str, cost: int = 1) -> None:
    """调用失败时归还预扣的积分（不对无限额度账号调用，负值不追加）。

    归还守卫 `credits >= 0`：若期间账号被置为无限（-1），不为其 +cost。
    """
    async with AsyncSessionLocal() as db:
        await db.execute(
            update(User)
            .where(User.id == user_id, User.credits >= 0)
            .values(credits=User.credits + cost)
        )
        await db.commit()
    logger.info("已归还积分 | user_id=%s cost=%s", user_id, cost)
