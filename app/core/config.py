"""全局配置：环境变量读取与跨域等设置。"""
from __future__ import annotations

from functools import lru_cache
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    backend_host: str = "0.0.0.0"
    backend_port: int = 7001
    # 允许的前端来源：覆盖本地 dev(4001)/默认(4000)、Vite(5173)、Docker/生产(3000/4173)
    cors_origins: str = (
        "http://localhost:4001,http://127.0.0.1:4001,"
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

    @property
    def cors_origin_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
