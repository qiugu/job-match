"""路由依赖：解析当前登录用户。

所有业务接口（简历 / 匹配 / AI）都必须注入 get_current_user：
AI 能力由后端统一持有 api_key，未登录即可调用会直接造成费用与额度泄漏。
"""
from __future__ import annotations

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.logging import get_logger
from app.core.security import decode_access_token
from app.models.user import User

logger = get_logger("auth.deps")

# auto_error=False：凭证缺失时由本模块统一转成 401（HTTPBearer 默认返回 403，
# 且与自定义提示文案冲突）
bearer_scheme = HTTPBearer(auto_error=False, scheme_name="Bearer")


def unauthorized(detail: str = "未登录或登录状态已失效，请重新登录") -> HTTPException:
    return HTTPException(
        status_code=401, detail=detail, headers={"WWW-Authenticate": "Bearer"}
    )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    if credentials is None or not credentials.credentials:
        raise unauthorized()

    try:
        payload = decode_access_token(credentials.credentials)
    except Exception:  # noqa: BLE001 - 过期/签名错误/结构非法一律视为未登录
        raise unauthorized() from None

    user = await db.get(User, str(payload.get("sub")))
    if user is None or not user.is_active:
        raise unauthorized()
    # 登出/改口令会递增 token_version，使旧令牌立即失效
    if int(payload.get("ver", -1)) != int(user.token_version):
        raise unauthorized("登录状态已失效，请重新登录")
    return user


async def get_optional_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """为匿名可用的遥测端点尽力关联登录用户；无效令牌按匿名处理。"""
    if credentials is None or not credentials.credentials:
        return None
    try:
        payload = decode_access_token(credentials.credentials)
    except Exception:  # noqa: BLE001 - 遥测不能因过期令牌阻断产品流程
        return None
    user = await db.get(User, str(payload.get("sub")))
    if user is None or not user.is_active:
        return None
    if int(payload.get("ver", -1)) != int(user.token_version):
        return None
    return user


async def get_admin_user(user: User = Depends(get_current_user)) -> User:
    """管理员接口的统一鉴权依赖。"""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="仅管理员可访问系统管理页面")
    return user
