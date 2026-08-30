"""登录鉴权基础设施：口令哈希（scrypt）与 JWT 签发/校验。

口令哈希选型说明（为什么不用 bcrypt / argon2）：
- hashlib.scrypt 是标准库能力，内存硬（n=2**14, r=8 约需 16MB/次），
  抗 GPU/ASIC 暴力破解；引入 argon2-cffi / bcrypt 会带来编译型依赖，
  在缺编译工具链的环境里安装失败会直接阻断服务启动。
- 每个口令使用独立随机盐，哈希参数随密文一起存储，便于日后平滑提升强度。
- 校验使用 hmac.compare_digest 做恒定时间比较，避免时序侧信道。

令牌说明：
- 使用 JWT（HS256，PyJWT），无状态；payload 携带用户 token_version，
  用户登出/改口令时递增该版本号即可让此前签发的所有令牌失效。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from typing import Any

import jwt

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger("security")

# scrypt 参数：OWASP 建议 (n=2**14, r=8, p=1) 为可接受的起点
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32
_SCRYPT_MAXMEM = 64 * 1024 * 1024  # 部分 OpenSSL 构建要求显式声明内存上限
_SALT_BYTES = 16
_PREFIX = "scrypt"

_TOKEN_TYPE = "access"

# AUTH_SECRET_KEY 未配置时的进程内随机密钥（仅保证服务不因缺配置而崩溃）
_ephemeral_secret: str | None = None


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"))


def hash_password(plain: str) -> str:
    """生成口令密文，格式：scrypt$n$r$p$salt$hash（全部 base64 编码）。"""
    salt = secrets.token_bytes(_SALT_BYTES)
    dk = hashlib.scrypt(
        plain.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_DKLEN,
        maxmem=_SCRYPT_MAXMEM,
    )
    return f"{_PREFIX}${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${_b64(salt)}${_b64(dk)}"


def verify_password(plain: str, encoded: str) -> bool:
    """校验口令。密文格式非法（如迁移遗留的不可用口令）一律返回 False。"""
    if not encoded:
        return False
    parts = encoded.split("$")
    if len(parts) != 6 or parts[0] != _PREFIX:
        return False
    try:
        n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
        salt, expected = _unb64(parts[4]), _unb64(parts[5])
    except Exception:  # noqa: BLE001 - 密文损坏时视为校验失败
        return False
    try:
        dk = hashlib.scrypt(
            plain.encode("utf-8"),
            salt=salt,
            n=n,
            r=r,
            p=p,
            dklen=len(expected),
            maxmem=_SCRYPT_MAXMEM,
        )
    except ValueError:
        return False
    return hmac.compare_digest(dk, expected)


def is_usable_password(encoded: str) -> bool:
    """密文是否可用于登录（迁移生成的遗留账号使用占位符 "!"，不可登录）。"""
    return encoded.startswith(f"{_PREFIX}$")


def _secret_key() -> str:
    if settings.auth_secret_key:
        # HS256 要求密钥不少于 32 字节（RFC 7518 §3.2），短密钥会削弱签名强度
        if len(settings.auth_secret_key.encode("utf-8")) < 32:
            logger.warning(
                "AUTH_SECRET_KEY 长度不足 32 字节，签名强度不足，建议使用更长的随机字符串"
            )
        return settings.auth_secret_key
    global _ephemeral_secret
    if _ephemeral_secret is None:
        _ephemeral_secret = secrets.token_urlsafe(48)
        logger.warning(
            "AUTH_SECRET_KEY 未配置：已生成一次性随机密钥，服务重启后所有登录态会失效"
        )
    return _ephemeral_secret


def create_access_token(user_id: str, token_version: int) -> tuple[str, int]:
    """签发访问令牌，返回 (token, 有效期秒数)。"""
    now = int(time.time())
    expires_in = max(int(settings.auth_token_expire_minutes * 60), 60)
    payload = {
        "sub": user_id,
        "ver": int(token_version),
        "iat": now,
        "exp": now + expires_in,
        "typ": _TOKEN_TYPE,
    }
    token = jwt.encode(payload, _secret_key(), algorithm="HS256")
    return token, expires_in


def decode_access_token(token: str) -> dict[str, Any]:
    """解析访问令牌，签名/类型/过期任一不合法都抛异常（由调用方转成 401）。"""
    payload = jwt.decode(
        token,
        _secret_key(),
        algorithms=["HS256"],
        options={"require": ["exp", "sub", "ver", "typ"]},
    )
    if payload.get("typ") != _TOKEN_TYPE:
        raise jwt.InvalidTokenError("令牌类型不匹配")
    return payload
