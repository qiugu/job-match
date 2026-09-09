"""登录鉴权的请求/响应模型。

请求字段沿用项目既有约定（camelCase，与前端对齐）；响应保留 snake_case 之外
的用户信息字段，前端类型定义在 src/lib/auth.ts。
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class RegisterRequest(BaseModel):
    """注册：用户名 + 口令 + 注册码（注册码决定该账号获得多少积分）。"""

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
    # 剩余积分（JD 简历匹配扣 5、JD 话术生成扣 1），-1 表示无限制
    credits: int
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
    # 用该注册码注册后获得的积分（全站统一默认值）
    grantCredits: int
    validityDays: int
    # ISO8601（UTC），前端转本地时区渲染
    nextResetAt: str


class RegistrationCodeOut(BaseModel):
    """成功领取的一枚注册码及领取后的剩余名额。"""

    code: str
    grantCredits: int
    expiresAt: str
    remaining: int
    nextResetAt: str
