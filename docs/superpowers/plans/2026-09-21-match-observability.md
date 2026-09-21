# 简历匹配可观测性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints.

**Goal:** 在现有投递分析页增加“匹配可观测性”Tab，追踪每次简历匹配的运行状态、节点耗时、Token 用量、匹配质量和最近运行详情。

**Architecture:** 为一次完整匹配建立 `MatchRun`，为 Agent 的三个阶段建立 `MatchRunStep`，并用 `match_run_id` 关联现有 `LlmUsage`。新增聚合接口只读这些台账，不改变现有 `/api/jobs/stats` 口径；前端在现有 analytics 页面中增加 Tab，投递分析保持默认页。

**Tech Stack:** FastAPI, SQLAlchemy 2, Alembic, Pydantic v2, React, TanStack Router, TypeScript, ECharts, Vitest/pytest。

## Global Constraints

- 后端依赖统一使用 uv，数据库结构变更必须新增 Alembic 迁移。
- 所有业务数据按 `user_id` 隔离，观测表不保存原始 JD 或完整简历文本。
- 现有 `/api/jobs/stats` 与投递分析的统计口径保持不变。
- 前端图表颜色继续通过现有 analytics token 体系获取，不在新图表中硬编码主题色。
- 新增接口兼容已有认证、时区和时间范围白名单：`days` 使用 7/14/30/90/180/365。

### Task 1: 建立匹配运行台账与迁移

**Files:**
- Create: `app/models/match_run.py`
- Create: `app/models/match_run_step.py`
- Modify: `app/models/llm_usage.py`
- Modify: `app/models/__init__.py`
- Modify: `app/core/database.py`
- Create: `migrations/versions/n7h9j1k3m5p7_add_match_observability.py`
- Test: `tests/test_match_observability.py`

**Interfaces:**
- `MatchRun(id, user_id, job_id, derived_resume_id, status, started_at, completed_at, latency_ms, match_score, matched_count, weak_count, missing_count, unsupported_count, prompt_tokens, completion_tokens, total_tokens, model, error_type, error_message)`。
- `MatchRunStep(id, match_run_id, step_key, status, started_at, completed_at, latency_ms, prompt_tokens, completion_tokens, error_type, retry_count)`。
- `LlmUsage.match_run_id` nullable foreign-key-free string for compatibility with existing ledger conventions.

- [ ] **Step 1: Write failing migration/model tests** covering table creation, nullable run linkage, user ownership fields, and migration graph reaching the new revision.
- [ ] **Step 2: Run `pytest tests/test_match_observability.py -q` and verify failure because the models/revision do not exist.**
- [ ] **Step 3: Implement the two SQLAlchemy models, export them, register them in `init_db`, extend `LlmUsage`, and add an Alembic revision from the current head `m6a8c0e2f4b7`.**
- [ ] **Step 4: Run the focused tests and `pytest tests/test_migration_graph.py -q`; both must pass.**

### Task 2: 记录完整匹配运行和节点状态

**Files:**
- Create: `app/services/match_observability.py`
- Modify: `app/services/usage.py`
- Modify: `app/services/agent.py`
- Modify: `app/api/match.py`
- Test: `tests/test_match_observability.py`

**Interfaces:**
- `start_match_run(user_id, job_id, master_resume_id=None) -> str`
- `finish_match_run(run_id, *, status, derived_resume_id=None, analysis=None, error=None) -> None`
- `record_match_step(run_id, *, step_key, status, latency_ms, error_type="") -> None`
- `track_llm(..., match_run_id: str | None = None)` preserves existing behavior while attaching ledger rows.

- [ ] **Step 1: Add failing API tests that create a deterministic match, assert one successful `MatchRun`, three step rows, and `LlmUsage.match_run_id`; add an error case that persists `status=error` and `error_type`.**
- [ ] **Step 2: Run the focused tests and verify the new assertions fail.**
- [ ] **Step 3: Create the run before `run_match`, pass the run ID through `track_llm`, instrument `jd_extract`, `resume_match`, and `keyword_optimize`, and finish the run after persistence or exception. Keep ledger writes best-effort and never mask the original business error.**
- [ ] **Step 4: Run the focused tests plus existing match/job tests; verify success, failure, quota refund, and existing response behavior.**

### Task 3: 增加可观测性聚合接口和 schema

**Files:**
- Create: `app/services/match_stats.py`
- Modify: `app/schemas/job.py`
- Modify: `app/api/match.py`
- Modify: `app/main.py` only if router registration is needed
- Test: `tests/test_match_observability.py`

**Interfaces:**
- `GET /api/derived-resumes/observability?days=30&tz_offset=480`
- `GET /api/derived-resumes/observability/runs/{run_id}`
- Response sections: `range`, `overview`, `daily`, `steps`, `quality`, `outcome`, `recent_runs`.

- [ ] **Step 1: Add failing endpoint tests for user isolation, timezone-aware daily buckets, successful/failed counts, step aggregation, quality counts, recent runs, and run detail ownership.**
- [ ] **Step 2: Run those tests and verify the endpoints are absent or incomplete.**
- [ ] **Step 3: Implement Pydantic response models and aggregation using the existing `ALLOWED_DAYS`/timezone helpers; return `null` where no sample exists and never expose raw JD/resume content.**
- [ ] **Step 4: Run the endpoint tests and all backend tests.**

### Task 4: 前端 API 类型与匹配可观测性 Tab

**Files:**
- Modify: `frontend/src/lib/jobmatch.ts`
- Create: `frontend/src/components/analytics/MatchingObservability.tsx`
- Modify: `frontend/src/app/app/dashboard/analytics/page.tsx`
- Modify: `frontend/src/components/analytics/options.ts` and/or `scale.ts` only for new chart helpers
- Modify: `frontend/src/i18n/locales/zh.json`
- Modify: `frontend/src/i18n/locales/en.json`
- Test: `frontend/tests/analytics-scale.test.ts` or a new focused pure-function test

**Interfaces:**
- `getMatchObservability(days, tzOffset) -> MatchObservability`
- `getMatchRunDetail(runId) -> MatchRunDetail`
- Tab state reads/writes `?tab=matching`; default remains `delivery`.

- [ ] **Step 1: Add failing pure-function tests for daily series normalization, success-rate formatting, quality bucket totals, and empty-safe display helpers.**
- [ ] **Step 2: Run the focused Vitest test and verify failure.**
- [ ] **Step 3: Add typed API clients, tab controls, overview KPI row, daily trend, step health, quality distribution, recent runs, and a detail drawer/panel. Follow existing `EChart`/token patterns and support loading, empty, partial error, keyboard focus, and reduced motion.**
- [ ] **Step 4: Run frontend typecheck/tests/build and fix only issues caused by this feature.**

### Task 5: 文档、验收和回归

**Files:**
- Modify: `docs/ANALYTICS.md`
- Modify: `README.md` only if the new endpoint needs public developer documentation
- Test: `tests/test_match_observability.py`, frontend focused tests

- [ ] **Step 1: Document metric definitions, model-score disclaimer, privacy boundary, and endpoint parameters.**
- [ ] **Step 2: Run backend full suite, frontend tests, and frontend build.**
- [ ] **Step 3: Inspect the diff for migration ordering, user isolation, raw-content leakage, and unchanged delivery analytics behavior.**

## Self-review checklist

- The confirmed first phase is covered by Tasks 1–4; score-to-application correlation is included only where existing job linkage makes it reliable.
- No task changes the existing delivery analytics formulas.
- Every new aggregate is based on persisted run/step data rather than frontend recomputation of raw business events.
- Failed LLM work still records latency and tokens through the existing best-effort usage ledger.
- No raw JD or resume text is returned by observability endpoints.
