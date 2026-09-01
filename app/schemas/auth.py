"""登录鉴权的请求/响应模型。

请求字段沿用项目既有约定（camelCase，与前端对齐）；响应保留 snake_case 之外
的用户信息字段，前端类型定义在 src/lib/auth.ts。
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class RegisterRequest(BaseModel):
    """注册：用户名 + 口令 + 注册码（注册码决定该账号获得多少匹配次数）。"""

    username: str
    password: str
    code: str


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    oldPassword: str
    newPassword: str


class UserOut(BaseModel):
    id: str
    username: str
    nickname: str
    role: str
    # 剩余可发起的「简历匹配 JD」次数，-1 表示无限制
    matchQuota: int
    createdAt: str
    lastLoginAt: str | None = None


class AuthResponse(BaseModel):
    token: str
    tokenType: str = "Bearer"
    expiresIn: int
    user: UserOut


class LogoutResponse(BaseModel):
    ok: bool = Field(default=True)


class RegistrationCodeStatusOut(BaseModel):
    """自助领取注册码的状态：今日剩余名额与下次重置时间（弹框顶部展示）。"""

    dailyLimit: int
    # 全站口径：今日全网还可发放的注册码数量 = 剩余可注册的账号数
    remaining: int
    grantMatches: int
    validityDays: int
    # ISO8601（UTC），前端转本地时区渲染
    nextResetAt: str


class RegistrationCodeOut(BaseModel):
    """成功领取的一枚注册码及领取后的剩余名额。"""

    code: str
    grantMatches: int
    expiresAt: str
    remaining: int
    nextResetAt: str
