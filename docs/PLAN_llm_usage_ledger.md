# R1 · LLM 用量台账：设计与落地说明

> 对应 `Plan.md` 第一批 R1。状态：已实现（2026-09-10）。
> 范围：数据模型 + 埋点 + 聚合查询；**不含**管理端查询接口（属 R3）。

## 一、为什么先做它

v1 路线图把「用量统计」放在管理员后台（P0-5）、「AI 限流」放在成本防护（P0-6），
但两者都需要同一个数据源：谁在什么时候、调用了什么、花了多少。没有台账，
统计只能靠猜、限流只能按进程内计数器拍脑袋。这是典型的依赖倒置，故提为第一批第一项。

## 二、设计决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 记录粒度 | 一条记录 = 一次**业务端点**调用（工作流内多次 LLM 请求汇总） | 成本归因与限流都应对齐「用户做了什么」；按次请求记会让「一次匹配」在报表里散成 5 行 |
| 埋点方式 | `langchain_core.callbacks.get_usage_metadata_callback` 包在业务入口外层 | 调用点分散（多节点工作流 + 流式接口），逐个解析返回值易漏；回调基于 contextvar 传播，新增模型调用无需改台账代码 |
| 写入事务 | 独立短事务（与 `quota.py` 同策略） | 主请求可能持有长事务（匹配要跑几分钟），复用会长期占用 SQLite 写锁 |
| 失败处理 | 吞异常、只记日志 | 台账是旁路数据，统计少一条可以接受，业务失败不行 |
| 隐私 | 只记 user_id / endpoint / model / token / 耗时，**不记 prompt 与响应正文** | 简历内容属敏感个人信息，台账不应成为第二份数据副本 |

## 三、数据模型（`llm_usage`）

| 列 | 说明 |
| --- | --- |
| `user_id` | 归属用户 |
| `endpoint` | 业务端点，取值见 `app/models/llm_usage.py` 的 `ENDPOINT_*` 常量 |
| `model` | 实际模型名（工作流多模型时取首个） |
| `prompt_tokens` / `completion_tokens` / `total_tokens` | 厂商未回传 usage 时记 0，**不估算、不伪造** |
| `latency_ms` | 整段业务调用耗时 |
| `status` | `success` / `error` |
| `error_type` | 失败时的异常类名，便于分类（超时 / 解析失败 / 厂商错误） |
| `created_at` | 索引；联合索引 `(user_id, created_at)` 为主查询路径 |

迁移：`migrations/versions/i2e4f6a8b0c1_add_llm_usage_ledger.py`（down_revision `d3e5f6a8b0c1`，即当前 head）。

## 四、埋点位置

| 端点常量 | 位置 |
| --- | --- |
| `ENDPOINT_MATCH` | `app/api/match.py` → `create_match` 包裹 `run_match` |
| `ENDPOINT_COVER_LETTER` | `app/api/cover_letter.py` → `_generate_text`（覆盖生成与重新生成） |
| `ENDPOINT_AI_POLISH` | `app/api/ai.py` → `/polish` 的事件流生成器内 |
| `ENDPOINT_AI_GRAMMAR` | `app/api/ai.py` → `/grammar` |
| `ENDPOINT_AI_RESUME_IMPORT` | `app/api/ai.py` → `/resume-import` |

统一用法：

```python
async with track_llm(ENDPOINT_MATCH, user_id=user.id):
    result = await run_match(...)
```

异常会被记录（status=error + error_type）后原样抛出，不改变既有错误处理语义。

## 五、已知边界

1. **流式接口的 token 可能缺失**：`/polish` 的 token 取决于厂商是否在流末回传 usage。
   缺失时 token 记 0，但调用次数与耗时仍留痕——足够 R2 按次限流使用。
2. **客户端中断计为 error**：流式请求被客户端断开时 `error_type=GeneratorExit`。
   成本确实已产生，但做错误率统计时建议按 `error_type` 过滤掉该类。
3. **测试要点**：`app.services.usage` 以 `from ... import AsyncSessionLocal` 绑定会话工厂，
   `tests/conftest.py` 已加入重定向，否则测试会把台账写进真实 `jobmatch.db`。
4. **顺带发现的既有 schema 漂移（本迁移已剔除，需另立项处理）**：`alembic revision
   --autogenerate` 同时报出 ①`cover_letters` 四列的 NOT NULL 与模型定义不一致；
   ②`master_resumes` 的 `uq_master_resumes_user_title` 在库里是 unique **索引**，
   模型里却是 unique **约束**。二者与本需求无关，夹带进「加表」迁移会带来不必要且
   不可逆的 ALTER，故未纳入。建议后续单独做一次「模型 ↔ 库结构对齐」迁移。

## 六、验证

- 迁移：临时库 `upgrade head` 建表成功、`downgrade -1` 整表删除，迁移链单 head。
- 单测：`tests/test_usage.py` 13 项（token 汇总、成功/失败落库、写入失败不影响业务、
  聚合过滤、三条链路的路由级接线）。
- 全量：`pytest` 124 passed（原基线 111）。

## 七、后续（R2 / R3 如何复用）

- R2 限流：按 `(user_id, endpoint, 时间窗)` 直接 `COUNT` 本表即可，已有联合索引支撑。
- R3 管理员后台：调用 `app.services.usage.aggregate_usage(...)` 取按端点的汇总；
  按天/按用户维度可在其基础上加 group by（当前默认窗口 30 天以避免全表扫描）。
