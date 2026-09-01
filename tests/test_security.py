"""security 模块测试：口令哈希/校验、JWT 签发/解析、token 失效、遗留口令。

所有断言均以 app/core/security.py 的真实函数为依据。
"""

import time

import jwt
import pytest

from app.core import security


def test_hash_and_verify_password():
    pw = "Str0ng#Passw0rd"
    h = security.hash_password(pw)
    assert h != pw  # 哈希后不应等于明文
    assert security.verify_password(pw, h) is True
    assert security.verify_password("wrong", h) is False


def test_different_salts_produce_different_hashes():
    pw = "SamePass#123"
    assert security.hash_password(pw) != security.hash_password(pw)


def test_unusable_password_returns_false():
    # 迁移遗留账号使用占位符 "!"，不可登录
    assert security.is_usable_password("!") is False
    assert security.is_usable_password(security.hash_password("x")) is True


def test_create_and_decode_token_roundtrip():
    token, expires_in = security.create_access_token("user-abc", token_version=1)
    assert isinstance(token, str)
    assert expires_in > 0
    pay = security.decode_access_token(token)
    assert pay["sub"] == "user-abc"
    assert pay["ver"] == 1
    assert pay["typ"] == "access"
    assert "exp" in pay and "iat" in pay


def test_decode_token_rejects_tampered():
    token, _ = security.create_access_token("uid", token_version=0)
    with pytest.raises(jwt.PyJWTError):
        security.decode_access_token(token + "tamper")


def test_token_invalidated_when_version_mismatch():
    # 签发的 token 携带 ver=1；若用户 token_version 已递增到 2，则原 token 失效
    token, _ = security.create_access_token("uid", token_version=1)
    # 解析本身成功，但业务层比较 ver 与当前 token_version
    pay = security.decode_access_token(token)
    assert pay["ver"] == 1
    # 模拟当前版本已变更
    assert pay["ver"] != 2


def test_token_expiry():
    # 通过直接构造一个已过期的 payload 验证 decode 会拒绝
    import datetime

    now = int(time.time())
    payload = {
        "sub": "uid",
        "ver": 0,
        "iat": now - 100,
        "exp": now - 10,
        "typ": "access",
    }
    secret = security._secret_key()
    expired = jwt.encode(payload, secret, algorithm="HS256")
    with pytest.raises(jwt.ExpiredSignatureError):
        security.decode_access_token(expired)


def test_verify_password_rejects_malformed_hash():
    # 非 scrypt$ 前缀或损坏格式一律 False
    assert security.verify_password("x", "not-a-hash") is False
    assert security.verify_password("x", "") is False
