"""配置默认值一致性校验（C1：令牌有效期三方取值必须一致）。

代码默认值、.env.example、AGENTS.md 均声明 10080（7 天）。本测试锁定代码默认值，
避免再次出现「裸跑 1 天、compose 7 天」的分叉（见 docs/review 分册 01 的 C1）。
"""

from __future__ import annotations

from app.core.config import Settings


def test_token_expire_minutes_default_is_seven_days():
    # 不读取 .env（_env_file=None），仅校验代码内声明的默认值；
    # 若 .env 显式设置则以其为准，那是部署方有意为之，不属此测试范围。
    s = Settings(_env_file=None)
    assert s.auth_token_expire_minutes == 60 * 24 * 7
    assert s.auth_token_expire_minutes == 10080
