"""注册码生成与发放。

注册码唯一的发放渠道是官网「自助获取注册码」入口
（POST /api/auth/registration-code，每日限量），生成逻辑统一收敛到本服务。
此前并行的管理脚本（scripts/generate_registration_code.py）已按需求移除，
不再支持脚本直连数据库发码。
"""
from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.timeutils import utcnow
from app.models.registration_code import RegistrationCode

# 去掉 0/O/1/I/L 等易混字符，便于口头或聊天窗口传递
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def generate_code(group_size: int = 4, groups: int = 3) -> str:
    """生成形如 ABCD-EFGH-JKLM 的注册码。"""
    return "-".join(
        "".join(secrets.choice(ALPHABET) for _ in range(group_size))
        for _ in range(groups)
    )


def issue_day_window(now: datetime | None = None) -> tuple[datetime, datetime]:
    """当前发放日窗口 [start, next_start)，按配置时区偏移取每日 0 点。

    默认按 UTC+8（北京时间）0 点重置：把时刻平移到目标时区取当天 0 点
    再平移回 UTC——整数偏移的确定性运算，不依赖系统本地时区与 tzdata。
    返回 naive UTC（与 timeutils 口径一致）。
    """
    now = now or utcnow()
    offset = settings.registration_reset_utc_offset
    shifted = now + timedelta(hours=offset)
    day_start = shifted.replace(hour=0, minute=0, second=0, microsecond=0)
    return (
        day_start - timedelta(hours=offset),
        day_start + timedelta(days=1) - timedelta(hours=offset),
    )


async def issued_count(db: AsyncSession, window_start: datetime) -> int:
    """窗口起点以来发放的注册码数量（每日限量的计数依据）。

    发放渠道唯一（官网自助），因此统计窗口内全部注册码即可。
    """
    return (
        await db.execute(
            select(func.count())
            .select_from(RegistrationCode)
            .where(RegistrationCode.created_at >= window_start)
        )
    ).scalar_one()


async def create_code(
    db: AsyncSession,
    *,
    days: int = 30,
    credits: int | None = None,
    note: str = "",
) -> RegistrationCode:
    """生成并写入一枚注册码（不提交事务，提交时机由调用方决定）。"""
    record = RegistrationCode(
        code=generate_code(),
        grant_credits=(
            credits if credits is not None else settings.registration_default_credits
        ),
        expires_at=utcnow() + timedelta(days=days),
        note=note,
    )
    db.add(record)
    return record
