"""全局配置：环境变量读取与跨域等设置。"""
from __future__ import annotations

from functools import lru_cache
from typing import List, Literal, Self

from pydantic import model_validator
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
    llm_timeout: int = 300  # 非匹配 LLM 调用的单次请求超时（秒）

    # 匹配工作流独立预算。节点 timeout 未显式配置时继承整体预算，避免三个
    # 串行节点各自把总耗时扩张到 MATCH_TOTAL_TIMEOUT_SECONDS 的数倍。
    match_pipeline_version: Literal["legacy", "combined"] = "legacy"
    match_total_timeout_seconds: float = 300
    match_extract_timeout_seconds: float | None = None
    match_analyze_timeout_seconds: float | None = None
    match_optimize_timeout_seconds: float | None = None
    # 匹配节点输出预算可按部署模型分别显式配置。默认不向 provider 下发上限：
    # 旧匹配路径没有 max_tokens，且 OpenAI 兼容端点对应的模型能力无法从本地可靠
    # 推断；贸然设 4096 会截断长简历。采集真实输出分位数后再按环境收紧。
    match_extract_max_tokens: int | None = None
    match_analyze_max_tokens: int | None = None
    match_optimize_max_tokens: int | None = None

    @model_validator(mode="after")
    def _inherit_match_stage_timeouts(self) -> Self:
        for field in (
            "match_extract_timeout_seconds",
            "match_analyze_timeout_seconds",
            "match_optimize_timeout_seconds",
        ):
            if getattr(self, field) is None:
                setattr(self, field, self.match_total_timeout_seconds)
        return self

    # ---------- 登录鉴权 ----------
    # JWT 签名密钥。生产必须显式配置 AUTH_SECRET_KEY：留空时进程会生成随机密钥，
    # 重启后所有登录态立即失效（详见 app/core/security.py 的 _secret_key）。
    auth_secret_key: str = ""
    # 登录令牌有效期（分钟），默认 7 天（10080 分钟）。
    # 注：.env.example 与 AGENTS.md 均声明默认 10080，此处必须保持一致，否则
    # 裸跑（未设环境变量）与 compose（注入 .env）行为会分叉，表现为「隔天被强制登出」。
    auth_token_expire_minutes: int = 60 * 24 * 7
    # 是否开放注册；关闭后只能由 AUTH_BOOTSTRAP_* 或已有账号登录
    auth_allow_registration: bool = True
    # 初始账号（可选）：服务启动时若该账号不存在则创建，并接管迁移遗留的历史数据。
    # 创建出来即为管理员（匹配额度无限制），首次部署时用它登录即可看到升级前已有的简历。
    auth_bootstrap_username: str = ""
    auth_bootstrap_password: str = ""
    # ---------- 积分（credits）定价 ----------
    # JD 简历匹配 / JD 话术生成（创建与重新生成）分别消耗的积分；
    # 两者共享同一余额 users.credits（新注册码默认充入 registration_default_credits）。
    resume_match_cost: int = 5
    cover_letter_cost: int = 1
    # 注册码默认授予的积分（官网自助领取的注册码用；新注册账号默认 50）
    registration_default_credits: int = 50
    # 官网「自助获取注册码」每日发放上限（对应官网提示「每天可获取的注册账号最多 10 个」）
    registration_daily_limit: int = 10
    # 自助获取的注册码有效期（天）
    registration_code_validity_days: int = 30
    # 每日发放窗口的时区偏移（小时）：「每天 0 点重置」按该时区计算，默认 UTC+8（北京时间）
    registration_reset_utc_offset: int = 8

    # ---------- 投递数据保留策略 ----------
    # 已归档（closed）岗位卡的保留天数：超过该窗口自动清理（子资产 job_id 置空
    # 转「未归类」，话术/匹配结果不删除；状态事件随卡删除）。0 表示禁用自动清理。
    # 统计区间上限（app/services/job_stats.py::ALLOWED_DAYS 最大值）必须 ≤ 该值：
    # 更早的事件已不存在，长区间图表会缺数。
    job_retention_days: int = 180

    # ---------- 简历 PDF 上传（导入侧护栏，S4） ----------
    # 上传 PDF 的体积硬上限（字节）：超过直接返回 413，不在整体读入内存后再判断。
    # 对照：PDF 导出侧另有 pdf_export_max_* 六项上限，导入侧此前缺失。
    resume_upload_max_bytes: int = 10 * 1024 * 1024
    # 上传 PDF 的页数硬上限：防止超大/恶意 PDF 拖垮同步解析线程（pymupdf 需遍历全文档预扫描标题）。
    resume_upload_max_pages: int = 50

    # ---------- 服务端 PDF 导出（headless Chromium 矢量渲染） ----------
    # 打印版 HTML 内 root-relative 字体 URL（/fonts/...）的解析源。
    # 生产 compose 内前端服务名固定为 frontend:3005（backend 容器可直接访问）；
    # 本机开发（uvicorn 直跑）需覆盖为 http://localhost:3005。
    pdf_export_font_origin: str = "http://frontend:3005"
    # 接收 HTML 的最大字节数（防内存滥用；打印版 HTML 无 base64 字体时应仅数百 KB）
    pdf_export_max_html_bytes: int = 2 * 1024 * 1024
    # 单次渲染内每个字体/图片资源服务端拉取的上限（字节），防大文件撑爆内存；
    # 需大于最大字体文件（NotoSansSC OTF 约 16–17MB/字重），给到 24MB 余量。
    pdf_export_max_asset_bytes: int = 24 * 1024 * 1024
    # 单次渲染超时（秒）
    pdf_export_timeout_seconds: int = 30
    # 内联字体后 HTML 的体积上限（字节）。当前字体内联为 data: URL，2 个字重约
    # 16–24MB；设 50MB 作为护栏——一旦超过说明误入了多余字体/资源，直接拒绝渲染，
    # 避免把百 MB 级 HTML 喂给 Chromium 导致其进程崩溃（表现为导出请求永久 pending）。
    pdf_export_max_inline_html_bytes: int = 50 * 1024 * 1024
    # 同时渲染的最大并发数（每页简历渲染峰值内存 200–400MB，低配机勿调高）
    pdf_export_max_concurrency: int = 2
    # 单用户每小时导出上限（内存滑动窗口，多实例部署时仅对本实例生效）
    pdf_export_rate_limit_per_hour: int = 20

    @property
    def cors_origin_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
