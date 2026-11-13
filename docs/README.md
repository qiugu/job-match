# 文档地图（docs/）

本目录存放项目文档，**按用途与生命周期分类存放**。唯一活跃路线图是仓库根的 `Plan.md`；工程约定、环境变量与常用命令见 `AGENTS.md`。本文件是 `docs/` 的唯一入口，新增文档须在对应类别下登记。

## 一、分类目录约定

| 类别 | 目录 | 内容 | 命名 |
| --- | --- | --- | --- |
| 文档地图 | `docs/README.md` | 本文件，索引所有文档 | — |
| 长期规范 | `docs/` 根（**仅规范类**） | 跨迭代有效的视觉、品牌、SEO、统计口径与验收基线 | 无前缀，如 `DESIGN.md` |
| 专题规划 | `docs/plans/` | 单个功能/模块的方案与设计稿 | `PLAN_<主题>.md` |
| 修复复盘 | `docs/fixes/` | 缺陷修复、事故复盘、前后对比与回归约定 | `FIX_<主题>.md` |
| 版本级规划 | `docs/v<N>/` | 整版本的产品规划及配套方案（含被取代方案的留痕），如 `docs/v2/` | `PLAN_<主题>.md` |
| 代码评审 | `docs/review/` | 分册评审报告与总览 | `NN-<主题>.md`、`README.md` |
| 归档 | `docs/archive/` | 已上线或已废弃的规划文档，仅作历史留痕 | 沿用原文件名 |
| 视觉资产 | `docs/design-preview/`、`docs/screenshots/` | 设计样张（HTML/截图）、界面预览图 | 随资产类型 |
| 工具产物 | `docs/superpowers/` | 外部工具生成的计划草稿，非项目正式规范 | 工具默认命名 |

> 根目录与子目录不是「活跃 / 归档」两层关系，而是**用途分类**关系；`docs/archive/` 只承担生命周期终点，不再承担「所有已完成文档」的收纳职责。

## 二、新增文档规则

1. **按类别落目录**：新文档放到上表对应目录；`docs/` 根目录**只接收长期规范类文档**，不再接收规划/修复类文档。目标目录不存在时创建：规划类进 `plans/`、修复复盘进 `fixes/`、整版本规划进 `v<N>/`。
2. **命名**：规划 `PLAN_<主题>.md`，修复/复盘 `FIX_<主题>.md`，评审分册 `NN-<主题>.md`；同一主题的方案与其复盘分开存放、互不混用。
3. **登记**：新增文档必须在本文件对应类别索引中登记一行；涉及环境变量或命令变更时，同步更新 `AGENTS.md`。
4. **完成与归档**：文档完成后不删除——结论回填 `Plan.md`，专题规划移入 `docs/archive/` 并在归档索引登记；版本级规划保留在 `v<N>/`，废弃方案在文档头部标注「已归档（废弃）」即可，不跨目录搬迁。
5. **存量迁移（过渡期）**：现有文件保持原位，**不强制一次性批量搬迁**（避免破坏源码、其他文档与工具中的路径引用）；某份文档被实质修改时，顺手迁入对应类别目录，并同步更新所有引用路径与本文件索引。

## 三、索引 · 长期规范（根目录）

| 文件 | 主题 |
| --- | --- |
| `README.md` | 本文档地图与分类规则 |
| `DESIGN.md` | JDMatch 视觉语言 Paper & Punch（色彩、密度、组件令牌） |
| `BRAND.md` | 品牌主标识构造、色板、资产清单与使用规则 |
| `SEO.md` | SEO 现状与收录策略（含 ICP / 站点地图约定） |
| `ANALYTICS.md` | 投递统计分析页的权威计算口径 |
| `M0.1_frontend_build_baseline.md` | M0.1 前端构建基线验收记录 |

## 四、索引 · 专题规划（`PLAN_*`，存量在根目录，新增进 `docs/plans/`）

| 文件 | 主题 | 状态 |
| --- | --- | --- |
| `PLAN_llm_usage_ledger.md` | R1 LLM 用量台账：数据模型、埋点、聚合查询 | 已实现 |
| `PLAN_delivery_analytics.md` | 投递统计分析页规划（权威口径见 `ANALYTICS.md`） | 已实现 |
| `PLAN_SEO.md` | SEO 优化方案（审计范围、S1→S5 阶段） | 方案稿；落地口径见 `SEO.md` |
| `PLAN_resume_translate.md` | 简历内容翻译：键值映射、专名策略、中英双向与积分裁决 | 已实现 |
| `PLAN_ai_observability.md` | AI 可观测性：翻译台账接入 analytics 与 admin 观测页 | 已落地 |
| `PLAN_unified_observability.md` | 统一可观测性：traces/spans（对齐 OTel）、节点状态与成本归因 | 已实施 |
| `PLAN_guest_access.md` | 游客模式：公开路由、本地草稿、登录承接 | 已实施（P4 待数据决策） |
| `PLAN_editor_align_selection.md` | 选中文字对齐改为「包裹选区」语义 | 已落地 |
| `PLAN_experience_memory.md` | 经历记忆库：对话式经历采集的数据模型与接口契约 | 设计稿，待评审 |
| `PLAN_feedback_module.md` | 用户反馈模块：现场快照、分诊状态机与接口契约 | 设计稿，待评审 |

## 五、索引 · 修复复盘（`FIX_*`，存量在根目录，新增进 `docs/fixes/`）

| 文件 | 主题 |
| --- | --- |
| `FIX_editor_heading_rhythm.md` | 编辑态标题垂直节奏：`.tiptap` 间距按 4px 栅格重排 |
| `FIX_editor_align_scope.md` | 编辑态对齐作用域：工具栏高亮与配对行压平缺陷 |
| `FIX_translate_proper_nouns.md` | 翻译静默漏译复盘：专名被整类吞掉与分组护栏 |
| `FIX_deploy_rsync_stale_file.md` | 部署时 rsync 陈旧文件导致前端镜像构建失败 |

## 六、索引 · 版本级规划与评审

### `docs/v2/`（2.0 版本规划）

| 文件 | 主题 |
| --- | --- |
| `v2/PLAN_conversation_memory.md` | 2.0 Agent MVP：目标驱动 + 有限 ReAct + 工具自主调度 + 三态记忆 + SSE 流式（含 MVP 复审修订） |
| `v2/PLAN_conversation_timeline.md` | 已归档（废弃）：以岗位卡为轴的对话式时间线方案，被上文取代，留版本决策痕迹 |

### `docs/review/`

`README.md`（总览）+ `01-backend-security.md`、`02-frontend.md`、`03-engineering.md`、`04-docs-consistency.md`、`05-editor-interaction.md`、`06-editor-interaction-fixes.md`（六分册，含问题 ID 与验收标准，2026-10-27 评审）。

## 七、索引 · 归档（`docs/archive/`）

| 文件 | 原主题 | 完成状态 |
| --- | --- | --- |
| `archive/PLAN_job_tracking.md` | 岗位卡（Job Tracking）与求职漏斗 | 已上线（迁移 `g1b2c3d4e5f6`） |
| `archive/PLAN_feature_separation.md` | 话术与简历匹配功能解耦 | 已上线（迁移 `f1a2b3c4d5e6`） |
| `archive/PLAN_resume_backend_source.md` | 「我的简历」列表以后端为准 | 已上线 |

## 八、索引 · 视觉资产与工具产物

| 位置 | 内容 |
| --- | --- |
| `design-preview/index.html` + `design-preview/shots/` | 视觉系统样张（自包含 HTML）与逐区截图 |
| `screenshots/` | README「界面预览」截图（landing / workbench / jobs / analytics，WebP，虚构演示数据） |
| 根目录 `brand-board.png`、`editor-*-before-after.png` | 存量对比图（过渡期保留原位，新增图片统一进 `screenshots/`） |
| `superpowers/plans/` | 外部工具按日期生成的计划草稿，不属于正式规划索引，仅供追溯 |
