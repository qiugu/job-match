# 01 · 后端与安全隔离

> 评审对象：`app/`（56 个 `.py`，约 8,700 行）、`migrations/`、`tests/`
> 评审方式：只读通读 + 调用链回读 + 实测（`pytest` 233 例）
> 结论基准日：2026-10-27（HEAD `bc9b04c`）

## 结论

后端的分层与鉴权基础比预期扎实：**对象级授权（BOLA）全链路无缺失**、积分预扣为原子 UPDATE、
口令哈希用 scrypt + 恒定时间比较、令牌有 `token_version` 失效机制、SQL 无任何字符串拼接。
真正的问题集中在三类「机制遗漏」而非「个人疏忽」：

1. **LLM 计费口径不一致** —— 匹配与话术扣积分，AI 代理三个端点完全不扣（S3）；
2. **入口护栏缺失** —— 简历 PDF 上传是唯一没有体积上限的入口（S4）；
3. **声明与实现脱节** —— HttpOnly Cookie 签发了却从不读取（S5），令牌有效期默认值与文档冲突（C1）。

---

## 问题清单

### S3 · AI 代理端点不扣积分、无限流（P1）

**证据**

- `app/api/ai.py:59`、`:81`、`:103` —— 三个端点（`/polish`、`/grammar`、`/resume-import`）唯一的外层包装是 `track_llm(...)`：

  ```python
  async with track_llm(ENDPOINT_AI_POLISH, user_id=user.id):
      async for chunk in ai_proxy.stream_polish(req.content, req.customInstructions):
  ```

- `app/services/usage.py:199-251` —— `track_llm` 的实现只做「计时 + 记录 token 台账」，**不含任何扣减**；`record_llm_usage`（`usage.py:254`）仅 `db.add(LlmUsage(...))`。
- 全库检索 `consume_credits` 的调用点只有 3 处：`app/api/match.py:129`、`app/api/cover_letter.py:109`，以及定义本身 `app/services/quota.py:24`。

**对照证据（说明这是机制缺口，不是有意豁免）**
`app/api/ai.py:50`、`:76`、`:98` 三处 docstring 都写着「需要登录：每次调用都会消耗后端 LLM 额度」——
即开发者认为已经计费，实际没有任何扣减代码。同一仓库内另外两条 LLM 路径（匹配、话术）都严格
「先扣后调、失败归还」（`match.py:126-138`、`cover_letter.py:104-112`），只有 AI 代理漏了。

**根因** 计费逻辑内联在各 Router 里，没有下沉到统一入口；新增端点靠人记得加 `consume_credits`。

**影响** 任一登录账号可无限次调用润色 / 语法检查 / 简历导入，成本全部由部署方承担；
注册默认发放 50 积分的商业模型（`config.py:83`）在这条路径上完全失效。属 OWASP API4:2023
「Unrestricted Resource Consumption」。

**建议** 为 `/api/ai/*` 补 `ai_polish_cost` / `ai_grammar_cost` / `ai_resume_import_cost`
三项定价并走 `consume_credits` 的同一套语义（先扣、异常归还）；更彻底的做法是把扣费做成
依赖项（`Depends(charge(ENDPOINT_X))`），让「新增端点必须声明价格」成为编译期无法绕过的约束。

---

### S4 · 简历 PDF 上传无体积 / 页数上限（P1）

**证据**

- `app/api/resume.py:281-294`：

  ```python
  if not file.filename or not file.filename.lower().endswith(".pdf"):
      raise HTTPException(status_code=400, detail="仅支持 PDF 格式的简历")
  ...
  data = await file.read()          # 一次性读入内存，无任何长度判断
  text, markdown_structure, global_settings = await _extract_upload_artifacts(data)
  ```

- `app/core/config.py`（全文 123 行）不存在任何 upload / max_bytes / page 相关配置项 —— 已逐行确认。

**对照证据** PDF **导出**侧护栏齐全（`export.py:80` 校验 `pdf_export_max_html_bytes`、
`export.py:53-70` 每用户每小时限流、`config.py:97-110` 六项上限），说明团队清楚这类风险，
只是导入侧没做。

**影响** 认证用户提交超大 PDF 即可让进程一次性分配同等内存，`pypdf` / `pymupdf4llm` 的解析
是 CPU 密集同步调用（`resume.py:301-302` 注释已说明必须 `to_thread`），并发若干次即拖垮实例。

**建议** 在 `Settings` 增 `resume_upload_max_bytes`（建议 10MB）与 `resume_upload_max_pages`；
读取改为分块累计并在超限时 `raise 413`，不要等 `await file.read()` 返回后再判断。

---

### S5 · HttpOnly Cookie 签发后从未被读取（P2，纵深防御形同虚设）

**证据**

- `app/api/auth.py:156-171` 登录时 `response.set_cookie(key="access_token", httponly=True, samesite="strict", ...)`，docstring 声称「缓解 XSS 盗用令牌」。
- 全库检索 `cookies`：仅 `auth.py:156`、`:163` 两行（签发侧）。`app/api/deps.py:30-48` 的
  `get_current_user` 只读 `HTTPBearer` 的 Authorization 头：

  ```python
  if credentials is None or not credentials.credentials:
      raise unauthorized()
  ```

- 前端 `frontend/src/lib/auth.ts:78` 也只发 `Authorization: Bearer`，`fetch` 未设 `credentials: "include"`。

**根因** 「双通道」只实现了写端，读端从未接入。

**影响** 当前不构成漏洞（Cookie 无人校验），但有两个实质后果：① 注释与前端注释
（`auth.ts:10`「后端同时签发 HttpOnly Cookie 作为双通道」）给维护者**虚假的安全感**，误以为
存在 XSS 缓解；② 一旦后续有人按注释去实现 Cookie 鉴权，`samesite="strict"` 之外的 CSRF 面
会立刻打开，而项目没有任何 CSRF token 机制。

**建议** 二选一并写进设计文档：要么删除该 Cookie（承认只有 Bearer 单通道，同步修正两处注释），
要么真正接入（新增读 Cookie 的依赖 + 双提交 CSRF token）。

---

### S6 · 匿名可写端点缺限流（P2）

**证据**

- `app/api/admin.py:24-36` `POST /api/site-visits`：依赖仅 `get_db`，无用户、无限流，直接 `db.add` + `commit`。
- `app/api/telemetry.py:18-39` `POST /api/growth-events`：依赖 `get_optional_user`（允许匿名），同上。
- 对照：登录/注册有进程内滑动窗口限流（`auth.py:99-134`）、导出有限流（`export.py:53`）—— 唯独这两个匿名写端点没有。

**影响** `SiteVisit` 有唯一约束、`GrowthEvent` 按 `eventId` 幂等（`telemetry.py:38` 注释），所以
单条重复投递无害；但攻击者每次换 `visitorId` / `eventId` 即可无限插入，直接把 SQLite 撑大，
并污染后台仪表盘（`services/admin_stats.py`）。属 OWASP API4。

**建议** 复用 `auth.py` 已有的限流器（抽成 `app/core/ratelimit.py` 共用），对匿名写端点按 IP
做分钟级窗口；`path` / `referrer` 已限长（`schemas/telemetry.py`），补上频率即可。

---

### S7 · 上游异常原文透传给客户端（P2）

**证据**（4 处）

| 位置 | 代码 |
| --- | --- |
| `app/api/match.py:196` | `raise HTTPException(status_code=503, detail=str(e))` |
| `app/api/cover_letter.py:130` | 同形 |
| `app/api/ai.py:85` | `return {"error": {"message": str(e), "code": "ConfigError"}}` |
| `app/api/ai.py:110` | `return {"error": f"AI 解析失败：{e}"}` |

**已排除**：全局兜底 `main.py:42-60` 只回 `request_id`，不回 traceback —— 这一层是对的。
问题只在这几处显式 `detail=str(e)`。

**影响** `str(e)` 可能携带上游 OpenAI 兼容端点返回的原始 JSON（含模型名、base_url 片段、
额度不足的具体提示），泄露部署细节；也让前端错误提示不可控（技术栈信息直接呈现给终端用户）。

**建议** 按异常类型映射用户可读文案，原始 `str(e)` 只进日志（现有 `logger.warning` 已记录）。

---

### C1 · 令牌有效期默认值与文档、注释三方冲突（P1）

**证据**

- `app/core/config.py:69-70`：

  ```python
  # 登录令牌有效期（分钟），默认 7 天
  auth_token_expire_minutes: int = 60 * 24 * 1
  ```

  `60 * 24 * 1` = **1440 分钟 = 1 天**，与上一行注释「默认 7 天」直接矛盾。
- `.env.example`：`AUTH_TOKEN_EXPIRE_MINUTES=10080`（7 天）。
- `AGENTS.md` 环境变量表：`AUTH_TOKEN_EXPIRE_MINUTES`｜「登录令牌有效期（分钟，默认 10080）」。

**影响** 三种部署形态行为不同：compose（注入 `.env`）7 天、裸跑 uvicorn 且未设环境变量 1 天。
用户会表现为「昨天还好，今天突然全部要重新登录」，且日志里没有任何线索。属配置类回归，
每次排查都要翻配置文件才能发现。

**建议** 统一为 10080（改代码默认值），或把注释与两份文档改成 1440。**选定后三处必须同批改**，
否则下次仍会分叉。建议顺带加一条测试断言 `settings.auth_token_expire_minutes == 10080`。

---

### C2 · `latest_acceptance` 的语义与字段名不符（P2）

**证据** `app/services/job.py:350-364`：

```python
select(
    DerivedResume.job_id,
    func.count().label("count"),
    func.max(DerivedResume.created_at).label("last_created"),
    func.max(DerivedResume.accepted).label("accepted"),     # ← max(布尔)
)
...
result[job_id]["latest_acceptance"] = bool(accepted)
```

`func.max(accepted)` 在 SQLite 上等价于「是否存在任意一条 `accepted=True`」（OR 语义），
但字段名 `latest_acceptance` 表达的是「最新一条是否已接受」（取最新再判断）。

**影响** 用户先接受 A 简历、后又生成 B 简历（未接受）时，岗位卡仍显示「已接受」。
是否构成可见缺陷取决于前端如何消费该字段，需产品确认；但从命名契约看，实现与名字不符。

**建议** 二选一：改名为 `has_accepted`（承认 OR 语义），或改为「按 `created_at` 取最新一条的
`accepted`」（子查询或窗口函数）。**建议前者** —— 投递漏斗关心的是「是否已投出」而非
「最后一次是否投出」。

---

### C3 · 文档声明的 `app/api/master.py` 不存在（P2）

**证据** `AGENTS.md`「目录结构」段写 `app/api/ # 路由层（master.py, match.py ...）`；
实际 `ls app/api/` 为：`admin.py ai.py auth.py cover_letter.py deps.py export.py jobs.py match.py resume.py telemetry.py`。
`ls app/api/master.py` → `No such file or directory`。

**根因** 简历相关端点早期在 `master.py`，重构进 `resume.py` 后文档未回填。详见分册 `04` 的 D2（同源问题）。

---

## 改进建议（按性价比排序）

| 顺序 | 动作 | 覆盖条目 | 预估 |
| --- | --- | --- | --- |
| 1 | 统一令牌有效期三处取值，并加断言 | C1 | 10 分钟 |
| 2 | 上传侧补体积/页数上限 | S4 | 30 分钟 |
| 3 | 抽出共享限流器，接入两个匿名写端点 | S6 | 1 小时 |
| 4 | `/api/ai/*` 接入积分扣减（或至少按次限流） | S3 | 2 小时（需产品定单价） |
| 5 | 异常文案映射表，禁止 `detail=str(e)` | S7 | 1 小时 |
| 6 | Cookie 二选一（删或真接入），同步改注释 | S5 | 决策 10 分钟 / 实施 半天 |
| 7 | `latest_acceptance` 改名或改实现 | C2 | 需产品确认 |

> **不建议**在没有测试基线的前提下动 S3/S5 —— 两者都改鉴权/计费语义，风险高于收益。
> 见分册 `03` 的整改路线图（测试基线先行）。

## 验收标准（可执行）

```bash
# C1：三处取值一致
grep -n "auth_token_expire_minutes" app/core/config.py .env.example AGENTS.md
grep -c "auth_token_expire_minutes: int = 60 \* 24 \* 7" app/core/config.py   # 期望 1

# S3：AI 端点必须出现扣减
grep -c "consume_credits" app/api/ai.py        # 期望 >= 1（当前为 0）

# S4：上传上限存在且被引用
grep -n "resume_upload_max_bytes" app/core/config.py app/api/resume.py   # 两者均需命中

# S6：匿名写端点接入限流
grep -n "ratelimit\|rate_limit" app/api/admin.py app/api/telemetry.py    # 两者均需命中

# S7：不再向上游异常原文透传
grep -rn "detail=str(e)" app/api/    # 期望 0 行（或仅剩经映射的包装）
```

> 注：本机 Bash 的 `grep -c` 有静默返回 0 的历史问题（见项目记忆），上述命令请在
> 终端人工复核一次，或改用 `rg`。
