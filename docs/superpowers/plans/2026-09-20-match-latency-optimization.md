# 简历匹配耗时优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在事实准确性、简历完整性和积分语义不退化的前提下，降低匹配完成耗时、失败等待时间和首个可用结果等待时间。

**Architecture:** 先建立分阶段测量、统一模型配置并修复失败短路；随后对比现有三阶段与“联合分析 → 简历优化”两阶段链路。保留现有返回契约，通过功能开关灰度；前端独立显示匹配与话术状态，流式展示作为后续独立阶段。

**Tech Stack:** FastAPI、LangChain、LangGraph、Pydantic、SQLite、React、TanStack Start、pytest、Vitest。

## Global Constraints

- 前后端 API 保持 `/api` 前缀；现有 `keywords`、`markdownContent`、`matchAnalysis`、`jobId`、`remainingCredits` 契约兼容。
- 保持匹配分析证据约束：不得编造经历、数字、公司、技术栈；missing 项不可凭空补齐。
- `MatchItem.strength` 现有值 `unspported` 本次保持兼容，不顺手修改。
- 后端依赖使用 uv，新增依赖同步 `uv.lock`；前端新增依赖同步 pnpm 锁文件。
- 数据库 schema 变更必须走 Alembic；重启后端前备份数据库。前四项任务不需要数据库迁移。
- 保留失败退款、成功落库、岗位归属、接受匹配幂等行为。禁止自动重发整个付费 POST。
- 真实模型评测使用脱敏样本，单独预算；不在普通测试中发外网请求，不打印简历正文和密钥。
- 本文是分析与实施规划；此次没有修改应用逻辑、重启服务或发起真实模型调用。

## 一、证据与结论

分析日期：2026-09-20。依据当前工作区源码、已安装依赖源码及只读本地数据库查询。

### 用户补充：单次匹配约 3 分钟

用户报告当前单次简历匹配约 **180 秒**。这是用户侧观测基线，尚不清楚样本数量、简历长度、是否包含话术以及成功/失败状态，不能把它直接标记为 P50 或 P95。

排查优先收集同一次慢请求的已有三条节点耗时日志及工作流总耗时，并对齐浏览器请求起止时间；不必等完整埋点上线才开始定位。约 180 秒本身不能证明触发默认 300 秒超时，也不能推断每个节点各耗时 60 秒。

若模型节点耗时之和接近 180 秒，重点比较各阶段生成量、首 token 等待和重试；若明显小于用户等待时间，再排查话术尾延迟、台账/结果落库与网络链路。成功完成的慢请求与最终失败的慢请求分开统计。

### 已确认：成功路径有三次串行模型调用

`app/services/agent.py:305` 构建固定链路：

```text
POST /api/derived-resumes
  → 积分预扣
  → jd_extract：JD → JDAnalysis
  → resume_match：JDAnalysis + 整份简历 → MatchResult
  → keyword_optimize：MatchResult + 整份简历 → 完整 Markdown
  → 用量台账写入 → 结果及岗位落库 → 返回
```

无重试情况下，模型部分近似为 `T提取 + T匹配 + T优化`。后两个节点重复输入整份简历，最后一个节点输出完整简历。当前存在数据依赖，不能直接用 `asyncio.gather` 并行三个节点。

全文生成是主要瓶颈候选，但没有节点耗时样本，不能认定它占比最大。图编译、数据库写入和前端渲染也没有证据表明是主要瓶颈，不优先重构它们。

### 已确认：模型配置存在两条路径

`app/core/llm.py:14` 的 `get_llm()` 配置了 `base_url`、`max_tokens=4096`、`max_retries=2` 和配置温度；匹配节点实际使用 `app/core/llm.py:32` 的全局 `model = init_chat_model(...)`：

- `base_url=settings.llm_base_url` 被注释；不能认为匹配使用了配置中的地址。
- 温度固定 `0.1`，未使用 `settings.llm_temperature`。
- 未显式传入输出预算和重试次数；不能把 `get_llm()` 的 4096 上限当作匹配上限。

这是配置一致性问题，不代表恢复 base URL 或降低输出上限必然提速。实际模型、服务端默认思考行为、限流、吞吐和重试次数仍需测量；不能凭代码注释判断已启用思考模式。

### 已复现：提取失败仍执行后续调用

`app/services/agent.py:57` 捕获 JD 提取异常，写入空 `JDAnalysis` 和 `error`。后续匹配只判断对象是否为 None，因此仍继续分析和优化；最终 `run_match()` 因 `error` 失败。

本次使用内存假模型复现，调用序列为：

```text
JDAnalysis [抛 ValueError]
→ MatchResult [仍调用]
→ keyword_optimize [仍调用]
→ RuntimeError [整体失败]
```

这种失败请求额外浪费两次模型调用。修复只直接改善失败路径，不应算作成功请求的普遍提速。

结构化输出异常还会被节点内 `except Exception` 吞掉并转成状态错误，外层 `except ValidationError` 的整图重试无法可靠覆盖这些错误。因此不应声称每个解析失败都会重跑整图；应改成可验证的节点级策略。

### 已确认：超时粒度混用，且没有首结果返回

每个节点、模型客户端、整个图共用 `settings.llm_timeout`，代码默认 300 秒。整体不是“每节点各获得 300 秒”，而是整图受同一个 300 秒预算约束；晚启动的优化节点可能被整体截止时间中断。

现有 POST 一次性返回 JSON，直到完整简历产出才展示分析。`frontend/src/app/app/dashboard/match/page.tsx:405` 已 `setResult(data)` 后，在 both 模式仍 await 话术；直到 finally 才关闭 `loading`，而 `:831` 的渲染优先展示 loading 骨架，因此隐藏已完成结果。

代码注释“话术约 2 秒”不是实测保证。Nginx 两份配置已经关闭 `/api` 代理缓冲且有 600 秒读超时，不将“关闭缓冲”重复列为当前主要优化。

### 已有优化与数据缺口

- 匹配 prompt 已限制 requirements ≤15、evidence ≤30 字、suggestion ≤50 字、summary ≤80 字。
- 优化节点已经使用紧凑 JSON；话术已经从后端匹配图移出。
- 上述字段长度目前是 prompt 约束，不是 Pydantic 硬限制；模型未遵守时可能放大输出，但未测得发生率。
- 节点已有总耗时日志；台账只有业务级汇总，没有节点 token、首 token、重试细分。
- 本地 `jobmatch.db` 的 `llm_usage` 表为 **0 条记录**，工作区未找到可用日志文件。生产容器数据库可能不同，这不证明线上没有数据。
- 台账 latency 计到模型流程结束，未包含随后台账写入及业务落库，不能直接当作用户端耗时。

## 二、优化目标与测量口径

以下为建议验收目标，不是已实现收益或现状测量值：

- 相同样本、模型配置和并发条件下，两阶段路径的完整结果 P50 比旧路径下降至少 25%；P95 不恶化。达不到则保留旧路径默认值。
- 结合约 180 秒的用户观测，25% 改善仅相当于约 135 秒，作为阶段性门槛，不能视为体验问题已解决。建议完整结果的后续体验目标为 **60–90 秒**，需经过节点实测和质量评测验证可行性；若全文优化占据绝大多数耗时，仅合并前两步不足以达到目标，应提前评估优化阶段的模型配置与输出规模。
- 失败节点之后不再调用后续模型；节点重试不能重跑已成功的上游节点。
- both 模式下匹配请求完成即可展示结果，不受话术尾延迟影响。
- 质量门槛：脱敏固定集不出现新增事实错误、重要事实丢失、未经建议的模块删除；结构化解析成功率与原链路相比不下降。
- 延迟指标必须同时报告成功率与失败耗时，避免通过更早超时虚假改善 P95。

采集 `request_id / pipeline_version / stage / attempt / effective_model / duration_ms / input_tokens / output_tokens / error_type`。记录输入字符数用于长度分层，不能用字符数冒充 token。可获得时另外记录 `ttft_ms / reasoning_tokens / provider_retry_count`；不可获得记 null，不填 0。

分开衡量：点击到分析可见、点击到完整简历可用、点击到话术可用、整个 HTTP 请求、各模型节点、台账写入、结果落库。日志不得带正文或完整 prompt。

评测集：至少 30 对脱敏简历/JD，覆盖短、中、长简历，强匹配、弱匹配、中英文、复杂 Markdown；每个候选方案跑 3 次，随机交错旧/新执行顺序，分别统计并发 1 的基线和小批并发 3 的表现。90 次/方案的 P95 仅作初步判断，上线继续观测。普通 CI 使用假模型，不运行这批付费评测。

## 三、实施任务

### Task 1：补齐分段测量并修复失败短路（P0）

**Files:**
- Modify: `app/services/agent.py`、`app/api/match.py`、`app/services/usage.py`
- Create: `app/services/match_metrics.py`、`tests/test_match_agent.py`、`tests/test_match_metrics.py`
- Regression: `tests/test_match_routes.py`、`tests/test_usage.py`

**Interfaces:** 保持 `run_match(master_text, jd_text) -> tuple[list[str], str, dict | None]`；新增结构化 stage 日志，无数据库字段变更。

- [ ] 写假模型测试：JD 提取抛异常，断言后续匹配和优化调用数均为 0；匹配解析失败断言优化调用数为 0；成功断言三节点按序执行。
- [ ] 使用下列断言作为失败短路回归测试的核心，假模型通过 monkeypatch 注入节点而不访问外网：

```python
calls = []

async def failed_extract(state):
    calls.append("extract")
    raise RuntimeError("synthetic extraction failure")

async def forbidden_match(state):
    calls.append("match")
    raise AssertionError("upstream failure must stop the graph")

# 另一个用例要在实际 jd_extract 内注入抛异常的结构化模型，
# 覆盖当前吞异常并填空对象的真实故障，而不仅替换整个节点。
# 每个失败用例结束均断言：
assert calls == ["extract"]
```

- [ ] 运行 `uv run pytest tests/test_match_agent.py tests/test_match_metrics.py -q`，确认新用例在旧行为下失败。
- [ ] 将 JD/匹配节点失败转成带节点名的异常并终止图；移除“填空继续但最终必失败”的行为。若未来保留降级，必须显式定义成功降级的输出和计费语义，不能混用 error 状态。
- [ ] 引入请求关联 ID 和 stage 计时，使用 `time.perf_counter()`；在 finally 写失败耗时，日志结构如下：

```python
logger.info("match_stage %s", json.dumps({
    "request_id": request_id,
    "stage": stage,
    "attempt": attempt,
    "duration_ms": round((time.perf_counter() - started) * 1000),
    "status": status,
}, ensure_ascii=False))
```

- [ ] 保留现有业务台账一条记录的口径，节点信息写结构化日志，避免新增多条 match 记录影响管理统计。通过模型 callback 按 run_id 关联节点 token，兼容缺失 usage。
- [ ] 测试并发请求 ID 不串台、失败也留痕、日志不含正文；回归命令：`uv run pytest tests/test_match_agent.py tests/test_match_metrics.py tests/test_match_routes.py tests/test_usage.py -q`，预期全部通过。
- [ ] 独立提交：`fix: stop failed match stages and record stage timings`。

### Task 2：统一匹配模型入口与时间预算（P0）

**Files:**
- Modify: `app/core/llm.py`、`app/core/config.py`、`app/services/agent.py`、`.env.example`
- Create: `tests/test_match_llm_config.py`
- Regression: `tests/test_match_agent.py`、`tests/test_cover_letter_routes.py`

**Interfaces:** 新增 `get_match_llm(stage: Literal["extract", "analyze", "optimize"])`，统一在 core 构造 provider 客户端；保留其他业务入口，避免无意改变导入/润色/话术模型行为。

- [ ] mock `init_chat_model`，验证配置的 base_url、temperature、输出上限、max_retries 确实传给实际节点所用客户端，而不是测试闲置的 get_llm。
- [ ] 明确配置 `MATCH_TOTAL_TIMEOUT_SECONDS` 和分节点 timeout。初始总预算保留现有 300 秒，节点预算先继承总预算；采样后再收紧，不凭空制定 30 秒产品承诺。
- [ ] 每节点使用剩余总体时间裁剪预算，重试也消耗同一截止时间；规则为：

```python
remaining = deadline - time.monotonic()
if remaining <= 0:
    raise TimeoutError("match deadline exhausted")
async with asyncio.timeout(min(stage_timeout, remaining)):
    response = await runnable.ainvoke(prompt)
```

- [ ] 将 SDK 重试显式设为 0，由节点包装层统一负责最多一次可恢复重试；只重试可恢复网络错误/429/5xx与结构化解析错误，遵守剩余时间，长 Retry-After 超出预算则失败。不重试鉴权/非法参数错误，不整体重跑图。
- [ ] 输出预算分别配置 `MATCH_EXTRACT_MAX_TOKENS`、`MATCH_ANALYZE_MAX_TOKENS`、`MATCH_OPTIMIZE_MAX_TOKENS`；初次与当前实际服务限制对齐，记录分位数后再调低分析输出。优化正文按长简历样本确定预算，检测 finish_reason=length，不把截断正文当成功。
- [ ] 保留 `method="json_mode"`。模型能力/思考模式参数需要实施时核对服务商实际支持情况；只通过 core 封装传入，不靠降低 temperature 宣称提速。
- [ ] 用可控时钟、假超时和假 429 测试总体截止、最多两次尝试、成功上游不重跑、截断不落库；运行 `uv run pytest tests/test_match_llm_config.py tests/test_match_agent.py tests/test_match_routes.py tests/test_cover_letter_routes.py -q`。
- [ ] 独立提交：`refactor: centralize match model policy and deadlines`。

### Task 3：两阶段链路实验（P1，主要成功路径优化）

**Files:**
- Modify: `app/schemas/agent.py`、`app/core/prompts.py`、`app/services/agent.py`、`app/core/config.py`、`.env.example`
- Create: `tests/test_match_pipeline.py`、`scripts/benchmark_match.py`、`tests/fixtures/match_latency_cases.json`

**Interfaces:** `MATCH_PIPELINE_VERSION=legacy|combined`，默认 legacy；新节点 `analyze_match(state)` 直接消费 JD 和简历，同时写入原有 `jd_analyze_results`、`keywords`、`resume_match_results`。

```python
class MatchAnalysisBundle(BaseModel):
    jd_analysis: JDAnalysis
    match_result: MatchResult
```

```text
combined: analyze_match(JD + resume) → keyword_optimize → existing response
legacy:   jd_extract → resume_match → keyword_optimize → existing response
```

- [ ] 新建两路径假模型测试：combined 恰好两次调用，legacy 三次；输出与现有前端契约相同；联合分析失败时不进入优化。
- [ ] 新 prompt 保留事实证据约束、15 条要求上限及短建议，联合输出 JD 分类和匹配分析；通过 `MatchAnalysisBundle` 校验后复用 `_flatten_keywords()`，避免前端关键词契约变化。
- [ ] 联合分析输出含 role、score、requirements、summary；严格保持现有 strength 枚举。不要只让模型输出优化简历而丢失用户需要的匹配分析。
- [ ] 编写评测脚本显式接受 `--cases`、`--pipeline`、`--repeats`、`--concurrency`、`--output`，默认拒绝真实调用，指定 `--live` 才执行；结果仅含 case_id、性能、token 和质量评审字段，正文留在受控样本位置。
- [ ] 测试命令：`uv run pytest tests/test_match_pipeline.py tests/test_match_agent.py tests/test_match_routes.py -q`。真实评测先旧后新交错执行，每次只切换 pipeline，不能同时换模型而无法归因。
- [ ] 以第二节门槛决定是否启用 combined。合并后单次分析可能变长，净收益近似 `T旧提取 + T旧分析 - T联合分析`，不能承诺调用数减 1 就提速三分之一。
- [ ] 独立提交：`feat: add gated two-stage resume matching pipeline`。

### Task 4：解除话术对匹配结果展示的阻塞（P1，可独立交付）

**Files:**
- Modify: `frontend/src/app/app/dashboard/match/page.tsx`
- Create: `frontend/tests/match-task-state.test.ts`
- 如为测试提取状态逻辑：Create `frontend/src/lib/match-task-state.ts`

**Interfaces:** 匹配和话术分别维护 pending/error 状态；匹配结果一旦完成就可见，话术区独立显示生成中；同一页面活动请求用序号或 request_id 防止旧响应覆盖新结果。

- [ ] 写状态测试：匹配完成、话术 pending 时主结果可见；话术失败不清空匹配；旧任务完成不能覆盖新任务；不能因提前解锁按钮重复提交扣费请求。
- [ ] 拆分结果可见条件与提交按钮锁定条件。最小原则：渲染骨架的条件应是“匹配 pending 且没有可用结果”，而不是所有子任务共享 loading。
- [ ] 保持 `derived_resume_id` 关联，因此第一版话术仍在匹配成功后启动，不盲目并行后破坏关联与积分展示。分别记录匹配耗时和话术耗时，移除“约 2 秒”的未验证保证。
- [ ] `pnpm -C frontend test`；在 frontend 内执行 `pnpm exec tsc --noEmit`、`pnpm build`。已有无关检查失败需要明确记录，不静默忽略。
- [ ] 浏览器使用延迟的假 API 手工验证 both/pitch/match 三种模式，以及失败、重复点击、切换任务。结果可见时不得允许接受尚未完成的简历。
- [ ] 独立提交：`fix: show completed match while cover letter is pending`。

### Task 5：按测量结果追加优化（P2，前四项验收后决策）

此阶段不预先加入 Redis、任务队列或整篇简历 patch 协议。先按节点成本和重复率选择一个可独立验收的后续项目。

- [ ] 若重复 JD 明显：针对 legacy 的 JDAnalysis 引入小容量 TTL/LRU 缓存，key 包含 user_id、规范化 JD 摘要、模型及 prompt/schema 版本；只缓存成功结果。单进程 single-flight 合并相同在途分析，测试隔离/过期/版本变化/失败不缓存。combined 路径不能直接复用旧 JD 缓存获得同样收益，两个方案必须独立比较。
- [ ] 若分析很快而全文生成主导：先试阶段化模型配置，固定输出质量评测；仍慢再单独设计按稳定模块 ID 改写并确定性组装的方案。不能直接字符串替换，必须覆盖重复文本、列表/HTML、模块增删和格式保持；此方案风险明显高于合并分析，暂不作为首批交付。
- [ ] 若总耗时可接受但盲等明显：单独设计 POST fetch 流，复用现有鉴权头，事件为 stage、analysis、markdown_delta、done、error，前端显示真实阶段和临时预览。仅 done 且业务落库成功后开放接受操作；失败不将局部内容当完成结果。
- [ ] 流式方案上线前测试分片拆包、UTF-8 跨块、断连、取消、心跳及退款。Nginx 已关闭缓冲仍需验证生产代理/CDN链路。POST 流重连不得自动重新扣费；若要求刷新恢复，另行引入持久任务及幂等键，需要 Alembic 迁移和独立设计，不能靠进程内后台任务保证可靠性。
- [ ] 流式传输主要减少首结果等待，不将它当成模型生成耗时下降。只有出现 429/并发排队证据才追加服务商配额范围内的并发控制，且单独记录排队时间。

## 四、交付顺序与回滚

推荐 Task 1 → Task 2 → Task 3；Task 4 独立交付，不需要等待链路实验。粗略开发量：前两项 1–2 天，两阶段及质量评测 1–2 天，前端状态拆分约半天；时间为规划估算，依现有测试情况和真实评测吞吐调整。

先在测试环境跑固定样本，再由配置选择旧/新路径灰度，保留 pipeline_version 指标。同一发布中避免同时合并链路、换服务商、压缩正文预算，以免性能回退无法定位。

失败率、事实错误或格式破坏增加即切回 legacy；保留测量、失败短路和前端展示修复。stage 模型配置也独立可回退。无需回滚已有匹配记录。

完成标准：提交可复现的前后对照数据、质量抽检结果、失败/退款/落库回归结果及配置说明。未获取真实模型数据前，只能报告结构性优化已实现，不能声称“从几分钟降到几秒”。
