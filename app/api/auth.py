"""自建账号登录 API：注册 / 登录 / 登出 / 当前用户 / 修改口令。

登录后才允许调用业务接口（简历、匹配）与 AI 接口——AI 能力由后端统一持有
api_key，匿名可调用等同于把额度公开。

令牌为无状态 JWT，服务端失效能力依赖 users.token_version（登出 / 改口令时递增）。
"""
from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.core.logging import get_logger
from app.core.security import (
    create_access_token,
    hash_password,
    verify_password,
)
from app.core.timeutils import utcnow
from app.models.registration_code import RegistrationCode
from app.models.user import ROLE_USER, User
from app.schemas.auth import (
    AuthResponse,
    ChangePasswordRequest,
    LoginRequest,
    LogoutResponse,
    RegisterRequest,
    RegistrationCodeOut,
    RegistrationCodeStatusOut,
    UserOut,
)
from app.services.registration_code import (
    create_code,
    issue_day_window,
    issued_count,
)

logger = get_logger("auth")

router = APIRouter(prefix="/api/auth", tags=["auth"])

_USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,64}$")
_MIN_PASSWORD = 8
_MAX_PASSWORD = 128

# ---------- 速率限制（进程内简单实现；单实例够用，多实例需换 Redis） ----------
# 维度：账号 + 客户端 IP。登录失败累计到阈值后临时锁定，阻止暴力破解。
_LOGIN_FAIL: dict[tuple[str, str], int] = {}
_LOGIN_LOCK_UNTIL: dict[tuple[str, str], float] = {}
_REGISTER_IP: dict[str, list[float]] = {}
_LOGIN_MAX_FAIL = 5
_LOGIN_LOCK_SECONDS = 15 * 60
_REGISTER_WINDOW_SECONDS = 60 * 60
_REGISTER_IP_MAX = 10

# 自助领取注册码的每 IP 每日限领（进程内实现，重启清零，与登录限流同一取舍）：
# 防止单一来源把当日全网名额一次性领空。窗口与每日发放窗口一致（0 点重置）。
_CODE_IP: dict[str, list[datetime]] = {}
_CODE_IP_DAILY_MAX = 3

# 「查剩余名额 → 发码 → 提交」需原子，进程内锁保证并发下不超发
# （单实例够用，与上方限流器同一取舍；多实例需换 Redis）
_ISSUE_LOCK = asyncio.Lock()


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _check_login_ratelimit(username: str, ip: str) -> None:
    key = (username, ip)
    until = _LOGIN_LOCK_UNTIL.get(key, 0.0)
    if until and utcnow().timestamp() < until:
        raise HTTPException(
            status_code=429,
            detail="登录失败次数过多，请 15 分钟后再试",
        )


def _on_login_failure(username: str, ip: str) -> None:
    key = (username, ip)
    _LOGIN_FAIL[key] = _LOGIN_FAIL.get(key, 0) + 1
    if _LOGIN_FAIL[key] >= _LOGIN_MAX_FAIL:
        _LOGIN_LOCK_UNTIL[key] = utcnow().timestamp() + _LOGIN_LOCK_SECONDS
        _LOGIN_FAIL[key] = 0


def _on_login_success(username: str, ip: str) -> None:
    _LOGIN_FAIL.pop((username, ip), None)
    _LOGIN_LOCK_UNTIL.pop((username, ip), None)


def _check_register_ratelimit(ip: str) -> None:
    now = utcnow().timestamp()
    hits = [t for t in _REGISTER_IP.get(ip, []) if now - t < _REGISTER_WINDOW_SECONDS]
    if len(hits) >= _REGISTER_IP_MAX:
        raise HTTPException(
            status_code=429,
            detail="注册过于频繁，请稍后再试",
        )
    hits.append(now)
    _REGISTER_IP[ip] = hits


def _check_code_ip_limit(ip: str, window_start: datetime) -> None:
    hits = [t for t in _CODE_IP.get(ip, []) if t >= window_start]
    if len(hits) >= _CODE_IP_DAILY_MAX:
        raise HTTPException(
            status_code=429,
            detail=f"当前网络今日领取已达上限（{_CODE_IP_DAILY_MAX} 个），请明天再试",
        )
    hits.append(utcnow())
    _CODE_IP[ip] = hits


def _iso_utc(value: datetime) -> str:
    """naive UTC → 带 UTC 时区的 ISO8601，前端可直接转本地时区渲染。"""
    return value.replace(tzinfo=timezone.utc).isoformat()


def _set_auth_cookie(response: Response, token: str, expires_in: int) -> None:
    """签发 HttpOnly Cookie：前端 JS 不可读，缓解 XSS 盗用令牌。

    同时响应体仍返回 token（前端存入 sessionStorage 并通过 Authorization
    header 发送），双通道兼容现有前端逻辑。生产环境（配置了 AUTH_SECRET_KEY）
    即要求 HTTPS（secure=True）。
    """
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        secure=bool(settings.auth_secret_key),
        samesite="strict",
        max_age=expires_in,
        path="/",
    )


def _user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        username=user.username,
        nickname=user.nickname or user.username,
        role=user.role,
        # 负号（默认 -1）对前端即「无限制」
        matchQuota=int(user.match_quota),
        createdAt=user.created_at.isoformat(),
        lastLoginAt=user.last_login_at.isoformat() if user.last_login_at else None,
    )


def _issue(user: User, response: Response) -> AuthResponse:
    token, expires_in = create_access_token(user.id, user.token_version)
    _set_auth_cookie(response, token, expires_in)
    return AuthResponse(
        token=token, tokenType="Bearer", expiresIn=expires_in, user=_user_out(user)
    )


def _validate_credentials(username: str, password: str) -> None:
    """注册/初始账号共用的格式校验，错误直接抛 400（提示面向最终用户）。"""
    if not _USERNAME_RE.match(username or ""):
        raise HTTPException(
            status_code=400,
            detail="用户名需为 3-64 位字母、数字或 _ . - 组合",
        )
    if len(password or "") < _MIN_PASSWORD:
        raise HTTPException(status_code=400, detail=f"密码至少 {_MIN_PASSWORD} 位")
    if len(password or "") > _MAX_PASSWORD:
        raise HTTPException(status_code=400, detail=f"密码最长 {_MAX_PASSWORD} 位")


async def _redeem_code(db: AsyncSession, raw: str) -> RegistrationCode:
    """校验注册码并登记一次兑换（注册码一次性，用后即失效）。

    校验顺序：非空 → 存在性 → 是否已使用 → 是否过期。redeemed_count 仅审计。
    """
    if not raw:
        raise HTTPException(status_code=400, detail="请输入注册码")
    # 注册码不区分大小写（生成时为大写，这里归一化，避免手抄时大小写出错）
    code_value = raw.upper()
    code = (
        await db.execute(
            select(RegistrationCode)
            .where(RegistrationCode.code == code_value)
            .limit(1)
        )
    ).scalars().first()
    if code is None:
        raise HTTPException(status_code=400, detail="注册码无效")
    if code.used:
        raise HTTPException(status_code=400, detail="注册码已被使用")
    if code.expires_at <= utcnow():
        raise HTTPException(status_code=400, detail="注册码已过期")

    code.redeemed_count = int(code.redeemed_count or 0) + 1
    code.last_redeemed_at = utcnow()
    code.used = True  # 一次性：注册成功后立即失效，防注册码被反复注册
    return code


@router.post("/register", response_model=AuthResponse, summary="使用注册码注册账号")
async def register(
    payload: RegisterRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    if not settings.auth_allow_registration:
        raise HTTPException(status_code=403, detail="当前站点未开放注册")
    _check_register_ratelimit(_client_ip(request))
    username = (payload.username or "").strip()
    _validate_credentials(username, payload.password)

    # 先查重再验码：用户名冲突时不消耗注册码
    if (
        await db.execute(select(User.id).where(User.username == username).limit(1))
    ).first():
        raise HTTPException(status_code=409, detail=f"用户名「{username}」已存在")

    code = await _redeem_code(db, (payload.code or "").strip())
    user = User(
        username=username,
        nickname=username,
        password_hash=hash_password(payload.password),
        role=ROLE_USER,
        match_quota=max(int(code.grant_matches), 0),
        registered_code=code.code,
        last_login_at=utcnow(),
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        # 并发注册同一用户名：唯一约束兜底
        await db.rollback()
        raise HTTPException(status_code=409, detail=f"用户名「{username}」已存在") from None
    await db.refresh(user)
    logger.info(
        "新用户注册：%s（注册码 %s，匹配额度 %s）",
        username,
        code.code,
        user.match_quota,
    )
    return _issue(user, response)


@router.post("/login", response_model=AuthResponse, summary="登录")
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    username = (payload.username or "").strip()
    ip = _client_ip(request)
    _check_login_ratelimit(username, ip)
    user = (
        await db.execute(select(User).where(User.username == username).limit(1))
    ).scalars().first()
    # 用户不存在与口令错误返回同一提示，避免暴露账号是否注册
    if user is None or not verify_password(payload.password, user.password_hash):
        _on_login_failure(username, ip)
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="账号已被禁用")

    _on_login_success(username, ip)
    user.last_login_at = utcnow()
    await db.commit()
    await db.refresh(user)
    return _issue(user, response)


@router.post("/logout", response_model=LogoutResponse, summary="登出（令牌立即失效）")
async def logout(
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """递增 token_version：该账号此前签发的所有令牌立即失效（多端同时登出）。

    前端收到响应后仍需清除本地保存的 token。
    """
    user.token_version = int(user.token_version or 0) + 1
    user.updated_at = utcnow()
    await db.commit()
    # 清除 HttpOnly Cookie，避免登出后 Cookie 仍可被后端读取
    response.delete_cookie(key="access_token", path="/")
    return LogoutResponse(ok=True)


@router.get("/me", response_model=UserOut, summary="当前登录用户")
async def me(user: User = Depends(get_current_user)):
    return _user_out(user)


@router.post("/change-password", response_model=AuthResponse, summary="修改密码并重新签发令牌")
async def change_password(
    payload: ChangePasswordRequest,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not verify_password(payload.oldPassword, user.password_hash):
        raise HTTPException(status_code=400, detail="原密码不正确")
    _validate_credentials(user.username, payload.newPassword)

    user.password_hash = hash_password(payload.newPassword)
    # 使旧令牌失效，返回新令牌保持当前会话登录
    user.token_version = int(user.token_version or 0) + 1
    user.updated_at = utcnow()
    await db.commit()
    await db.refresh(user)
    return _issue(user, response)


# ---------- 自助领取注册码（官网 FAQ 入口，匿名可用） ----------
# 访客注册前还没有账号，因此与 register 一样匿名。官网自助是注册码唯一的
# 发放渠道（管理脚本已移除），每日限量（settings.registration_daily_limit）
# 统计窗口内全部注册码。


@router.get(
    "/registration-code/status",
    response_model=RegistrationCodeStatusOut,
    summary="自助领取注册码：全站今日剩余可注册账号数与下次重置时间",
)
async def registration_code_status(db: AsyncSession = Depends(get_db)):
    if not settings.auth_allow_registration:
        raise HTTPException(status_code=403, detail="当前站点未开放注册")
    window_start, next_reset = issue_day_window()
    issued = await issued_count(db, window_start)
    return RegistrationCodeStatusOut(
        dailyLimit=settings.registration_daily_limit,
        remaining=max(settings.registration_daily_limit - issued, 0),
        grantMatches=settings.registration_default_matches,
        validityDays=settings.registration_code_validity_days,
        nextResetAt=_iso_utc(next_reset),
    )


@router.post(
    "/registration-code",
    response_model=RegistrationCodeOut,
    summary="自助领取一枚注册码（全站每日限量，先到先得）",
)
async def issue_registration_code(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    if not settings.auth_allow_registration:
        raise HTTPException(status_code=403, detail="当前站点未开放注册")
    window_start, next_reset = issue_day_window()
    _check_code_ip_limit(_client_ip(request), window_start)

    limit = settings.registration_daily_limit
    # 锁内「查剩余 → 发码 → 提交」，并发下不超发；唯一索引碰撞兜底重试。
    # registration_codes.code 是唯一键，码空间极大（23^12）碰撞极罕见，重试 3 次足够。
    async with _ISSUE_LOCK:
        issued = await issued_count(db, window_start)
        if issued >= limit:
            raise HTTPException(
                status_code=429,
                detail=f"今日名额已发完（每日上限 {limit} 个），名额每天 0:00 更新，请明天再来",
            )
        record = None
        for _ in range(3):
            record = await create_code(
                db,
                days=settings.registration_code_validity_days,
            )
            try:
                await db.commit()
                break
            except IntegrityError:
                await db.rollback()
                record = None
        if record is None:
            raise HTTPException(status_code=503, detail="注册码生成失败，请稍后重试")

    remaining = max(limit - issued - 1, 0)
    logger.info("自助发放注册码：%s（今日剩余 %s/%s）", record.code, remaining, limit)
    return RegistrationCodeOut(
        code=record.code,
        grantMatches=record.grant_matches,
        expiresAt=_iso_utc(record.expires_at),
        remaining=remaining,
        nextResetAt=_iso_utc(next_reset),
    )
