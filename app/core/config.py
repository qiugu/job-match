"""全局配置：环境变量读取与跨域等设置。"""
from __future__ import annotations

from functools import lru_cache
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    backend_host: str = "0.0.0.0"
    backend_port: int = 8005
    # 允许的前端来源：开发与生产统一使用前端端口 3005，以及经 nginx 同源代理(80) 与容器内来源
    cors_origins: str = (
        "http://localhost:3005,http://127.0.0.1:3005,"
        "http://localhost,http://frontend:3005"
    )

    database_url: str = "sqlite+aiosqlite:///./jobmatch.db"

    @property
    def async_database_url(self) -> str:
        # 确保使用 aiosqlite 异步驱动
        url = self.database_url
        if url.startswith("sqlite://"):
            return "sqlite+aiosqlite://" + url[len("sqlite://"):]
        return url

    # 国产大模型（OpenAI 兼容接口）
    llm_provider: str = "deepseek"
    llm_api_key: str = ""
    llm_base_url: str = "https://api.deepseek.com/v1"
    llm_model: str = "deepseek-v4-flash"
    llm_temperature: float = 0.3
    llm_timeout: int = 300  # LLM 单次请求超时（秒），匹配工作流节点/整体统一沿用此配置

    # ---------- 登录鉴权 ----------
    # JWT 签名密钥。生产必须显式配置 AUTH_SECRET_KEY：留空时进程会生成随机密钥，
    # 重启后所有登录态立即失效（详见 app/core/security.py 的 _secret_key）。
    auth_secret_key: str = ""
    # 登录令牌有效期（分钟），默认 7 天
    auth_token_expire_minutes: int = 60 * 24 * 1
    # 是否开放注册；关闭后只能由 AUTH_BOOTSTRAP_* 或已有账号登录
    auth_allow_registration: bool = True
    # 初始账号（可选）：服务启动时若该账号不存在则创建，并接管迁移遗留的历史数据。
    # 创建出来即为管理员（匹配额度无限制），首次部署时用它登录即可看到升级前已有的简历。
    auth_bootstrap_username: str = ""
    auth_bootstrap_password: str = ""
    # 注册码默认授予的「JD 匹配次数」（官网自助领取的注册码用）
    registration_default_matches: int = 10
    # 官网「自助获取注册码」每日发放上限（对应官网提示「每天可获取的注册账号最多 10 个」）
    registration_daily_limit: int = 10
    # 自助获取的注册码有效期（天）
    registration_code_validity_days: int = 30
    # 每日发放窗口的时区偏移（小时）：「每天 0 点重置」按该时区计算，默认 UTC+8（北京时间）
    registration_reset_utc_offset: int = 8

    @property
    def cors_origin_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
