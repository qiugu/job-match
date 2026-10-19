# 部署后 API 延迟优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 降低部署后常规 API 的数据库尾延迟，并为线上请求提供可区分应用处理时间与代理/网络时间的指标。

**Architecture:** 先把岗位列表的逐岗位聚合改为批量聚合，消除与岗位数量线性增长的查询放大；再为 SQLite 启用 WAL 与连接级 busy timeout，降低遥测、积分、观测台账并发写入时的锁等待；最后在 FastAPI 与 Nginx 暴露请求耗时，部署后可用一次 curl 明确慢点位。

**Tech Stack:** FastAPI、SQLAlchemy asyncio、SQLite/aiosqlite、Nginx、pytest。

## Global Constraints

- API 路由、响应字段、鉴权和积分语义保持不变。
- 数据库 schema 不变，不新增迁移；只调整连接运行参数和查询形态。
- 不把简历正文、JD、密钥写入耗时日志。
- 不把观测旁路失败升级为业务失败。
- 保留工作区中已有的未提交部署镜像优化文件。

### Task 1: 批量化岗位列表聚合

**Files:**
- Modify: `app/services/job.py`
- Modify: `app/api/jobs.py`
- Test: `tests/test_job_stats.py`

**Interfaces:** 新增 `get_jobs_aggregates(db, job_ids) -> dict[str, dict]`；保留 `get_job_aggregates` 供详情接口使用，并保证列表返回 JSON 契约完全不变。

- [x] 为多个岗位增加测试：批量函数返回每个岗位的话术数、匹配简历数、最新活动时间和接受标记；空 id 列表返回空字典。
- [x] 运行 `uv run pytest tests/test_job_stats.py -q`，确认新测试在批量函数不存在时失败。
- [x] 用按 `job_id IN (...) GROUP BY job_id` 的两次聚合查询替换列表里的逐岗位调用；无子记录时保持现有 `last_activity_at=null` 的响应口径。
- [x] 运行 `uv run pytest tests/test_job_stats.py tests/test_jobs.py -q`，确认列表字段和排序回归通过。

### Task 2: SQLite 并发写入参数

**Files:**
- Modify: `app/core/database.py`
- Test: `tests/test_database_performance.py`

**Interfaces:** 数据库 URL、模型和迁移接口不变；新增连接初始化 helper，仅对 SQLite 设置 WAL、`synchronous=NORMAL`、`foreign_keys=ON` 和 30 秒 busy timeout。

- [x] 先写连接配置测试，验证 SQLite 连接的 `journal_mode` 为 `wal`、`busy_timeout` 至少为 30000ms，非 SQLite 不执行 SQLite pragma。
- [x] 运行 `uv run pytest tests/test_database_performance.py -q`，确认测试在现有连接配置下失败。
- [x] 通过 SQLAlchemy async engine 的 connect 事件设置连接级参数，并用 `connect_args={"timeout": 30}` 作为首次连接等待兜底；不改变 Alembic 迁移路径。
- [x] 运行 `uv run pytest tests/test_database_performance.py tests/test_models.py tests/test_quota.py tests/test_auth_routes.py -q`。

### Task 3: 暴露可归因的请求耗时

**Files:**
- Modify: `app/main.py`
- Modify: `nginx/nginx.conf`
- Modify: `nginx/nginx.ssl.conf`
- Test: `tests/test_request_timing.py`

**Interfaces:** 每个 HTTP 响应增加 `Server-Timing: app;dur=<ms>`；Nginx 增加 `Server-Timing: upstream;dur=<seconds>`，不改变状态码和正文。

- [x] 写中间件测试，验证响应包含 app 耗时头且单位为毫秒数字，异常响应仍保留 request id。
- [x] 运行 `uv run pytest tests/test_request_timing.py -q`，确认现有中间件没有该 header 时失败。
- [x] 在 `send` 包装中只对 `http.response.start` 注入耗时头，避免 streaming response 被缓冲；Nginx 继续使用 keepalive 配置。
- [x] 在两份 Nginx 配置中保留/补齐 upstream timing，避免 HTTP 与 HTTPS 行为不一致。
- [x] 运行 `uv run pytest tests/test_request_timing.py tests/test_security.py tests/test_match_routes.py -q`，并执行前端已有静态检查不受影响。

## 验收

部署后执行：

```bash
curl -sk -o /dev/null -w 'total=%{time_total}s\n' -D - https://jdmatch.site/health
```

比较 `Server-Timing: app;dur=...` 与 `Server-Timing: upstream;dur=...`：应用耗时高说明继续查 SQLite/CPU/LLM；二者都低而 total 高说明问题在 TLS、客户端网络或外层代理。匹配接口仍需单独按 stage 日志统计，不能把普通健康检查耗时当作 LLM 耗时。
