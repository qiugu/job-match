"""LLM 客户端：通过 OpenAI 兼容接口接入国产大模型（DeepSeek/通义/智谱等）。

统一封装：从 .env 读取 api_key / base_url / model，使用 langchain-openai 的
ChatOpenAI（兼容任意 OpenAI 协议端点），便于后续扩展其他国产模型。
"""
from __future__ import annotations
from functools import lru_cache
from langchain_openai import ChatOpenAI
from langchain.chat_models import init_chat_model
from app.core.config import settings


@lru_cache
def get_llm(temperature: float | None = None) -> ChatOpenAI:
    return ChatOpenAI(
        model=settings.llm_model,
        temperature=settings.llm_temperature if temperature is None else temperature,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        max_tokens=4096,
        # 单次请求硬超时：避免出现「连接建立但接口不返回」时 await 永久挂起、
        # 进而卡死整个 uvicorn 事件循环（表现为主接口与 /health 一起 pending）。
        # 取值统一走 settings.llm_timeout（默认 300 秒，可用 LLM_TIMEOUT 覆盖）。
        request_timeout=settings.llm_timeout,
        max_retries=2,
    )


def is_configured() -> bool:
    return bool(settings.llm_api_key)

model = init_chat_model(
    settings.llm_model,
    api_key=settings.llm_api_key,
    model_provider=settings.llm_provider,
    # base_url=settings.llm_base_url,
    timeout=settings.llm_timeout,
    temperature=0.1
)
