# 简历匹配 Agent — 需求清单与检查单

> 机制：开发启动时生成需求清单作为验收基线；每次改动后回到本检查单逐项验证；
> 全部项标记 [x] 通过，方可判定任务完成。

## 一、需求清单（Requirement List）

- R1 简历管理：支持上传 **PDF** 简历，提取文本并存储（SQLite），作为匹配时可选择的简历。
- R2 创建匹配简历：根据粘贴的 JD 文本，对所选简历进行匹配优化并生成衍生简历。
- R3 匹配模式自动判断：匹配方式（`rewrite` 全部重写 / `optimize` 关键词优化）由 AI 在匹配时自动判断，前端不再提供选择。
- R4 关键词提取：Agent 从 JD 提取关键词，用于优化/记录。
- R5 求职信：创建时可选项，生成约 200 字纯文本求职信。
- R6 匹配入口：直接传入所选简历的 markdown 文本（`resumeText`），不再有「主简历」溯源概念。
- R7 二次编辑：前端加载衍生简历进编辑器可二次编辑，并回写后端。
- R8 PDF 输出：前端预览并下载生成的简历为 PDF（复用现有 exportToPdf）。
- R9 后端技术栈：独立 Python 后端（FastAPI + LangChain + LangGraph + SQLite），先接国产大模型。
- R10 数据契约：前后端共用 ResumeData 结构化 JSON，与前端 src/types/resume.ts 对齐。

## 二、检查单（Checklist）

### 后端骨架与依赖

- [x] B1 后端目录结构 backend/ 建立（app/{core,api,models,schemas,services}）
- [x] B2 requirements.txt / .env.example 就绪，依赖可安装
- [x] B3 FastAPI 应用可启动，/health 返回 ok

### 数据模型与持久化（SQLite）

- [x] B4 master_resumes 表：id/title/raw_text/resume_json/时间字段
- [x] B5 derived_resumes 表：match_mode/jd_text/resume_json/keywords/has_cover_letter（不含主简历溯源字段）
- [x] B6 cover_letters 表：derived_resume_id/content
- [x] B7 数据库初始化建表成功（init_db 执行无报错）

### 主简历 API（R1）

- [x] B8 POST /api/master-resumes 仅接受 PDF，拒绝非 PDF（400）
- [x] B9 上传后能用 pypdf 提取文本，空文本返回 422
- [x] B10 结构化 ResumeData 存储为 JSON
- [x] B11 GET 列表 / 详情 / PUT 更新 接口正常

### 匹配 Agent 与 API（R2-R6, R9, R10）

- [x] B12 POST /api/derived-resumes 触发 LangGraph 工作流
- [x] B13 模式 rewrite：AI 判断为全部重写时，产出重写后的 markdown 简历文本（mock 验证链路）
- [x] B14 模式 optimize：AI 判断为关键词优化时，基于关键词优化描述、产出 markdown 简历文本（mock 验证链路）
- [x] B15 提取 JD 关键词并返回
- [x] B16 衍生简历不再含主简历溯源字段（匹配直接传 resumeText）
- [x] B17 withCoverLetter=true 时产出约200字纯文本求职信
- [x] B18 withCoverLetter=false 时不产出求职信
- [x] B19 GET /api/derived-resumes 列表与详情正常
- [x] B20 PUT 二次编辑回写更新 resume_json（衍生简历 resume_json 现为 markdown 文本）
- [x] B21 匹配方式无需前端传入（由 AI 判断）；请求不含 matchMode 不再 400；resumeText 为空时返回 400
- [x] B22 LLM 未配置时返回明确错误（不崩溃）

### 前端（R7, R8）

- [x] F1 新增"简历匹配"专区/路由，可上传简历 PDF（路由 /app/dashboard/match + 侧边栏入口，构建通过）
- [x] F2 简历列表与选择（listMasterResumes + 选中态）
- [x] F3 创建匹配简历表单：选简历 + 粘贴 JD + 求职信开关（匹配方式由 AI 自动判断，不再提供选择）
- [x] F4 调用后端 /match，加载返回 ResumeData 进编辑器二次编辑（addResume 接入现有编辑器）
- [x] F5 求职信纯文本展示（Card 渲染 coverLetter）
- [x] F6 复用 exportToPdf 预览/下载 PDF（对预览元素 jobmatch-preview 导出）
- [x] F7 配置后端 base URL（VITE_JOBMATCH_API，默认 localhost:8005）与 CORS 联调（curl 验证跨域头+上传成功）

### 联调与完成

- [x] I1 前后端数据流贯通：上传简历(CORS通过) → 创建匹配(Agent逻辑mock验证通过) → 编辑(addResume) → 导出 PDF(exportToPdf)
- [x] I2 全部检查项通过，无遗留阻塞问题（注：真实 LLM 生成质量需在配置 LLM_API_KEY 后人工体验；逻辑链路已全验证）

### 交互逻辑调整（2026-08-23）

- [x] X1 前端不再持有/配置任何 api_key：删除 useAIConfigStore、config/ai、lib/server/gemini；润色/语法/导入三个 server 路由改为透传至 Python 后端 /api/ai/\*（后端 env 持有 key）
- [x] X2 AI 设置页改为"由后端统一托管"说明页，移除厂商 key 输入
- [x] X3 后端新增 AI 代理层 app/services/ai_proxy.py + app/api/ai.py（polish 流式/grammar/resume-import），复用 get_llm()，已冒烟验证
- [x] X4 R6 匹配入口：匹配结果区不再展示来源主简历（已无主简历溯源概念）
- [x] X5 R7/B20 二次编辑回写：编辑器新增"保存匹配结果"按钮，调用 updateDerivedResume 回写后端 resume_json（useMatchEditingStore 记录来源 derivedId）
- [x] X6 R3/F3 展示：创建按钮上方展示已选简历（匹配方式由 AI 自动判断，不再提供选择）
- [x] X7 D 匹配专区无 api_key 配置（天然满足，AI 走后端）

### Markdown 编辑模式（所见即所得，2026-08-24）

- [x] M1 新增 `tiptap-markdown` + `markdown-it` + `@tiptap/extension-placeholder` 依赖（与 Tiptap v3.30 兼容）
- [x] M2 类型补充：`ResumeData.markdownContent` 字段（initialResumeData 四个初始对象均默认空串）
- [x] M3 Markdown 编辑器组件 `MarkdownEditor.tsx`：Tiptap + tiptap-markdown，实时输出 Markdown 文本
- [x] M4 Markdown Parser `markdownRender.ts`：markdown-it 将 Markdown 解析为 HTML（链接新窗口打开、安全 rel）
- [x] M5 React Renderer `MarkdownPreview.tsx`：A4 纸张渲染，应用全局排版设置（字体/字号/页边距/主题色），容器带 `id="resume-preview"` 以支持复用导出
- [x] M6 工作区布局 `MarkdownWorkbench.tsx`：左编辑器 / 右实时预览分栏（可拖拽），写入 store.markdownContent
- [x] M7 WorkbenchPage 顶部新增「表单编辑 / Markdown 编辑」切换，两种模式可切换且不破坏表单三栏布局
- [x] M8 复用既有 `exportToPdf`（服务端 Playwright）完成 Markdown 简历的 PDF 导出（所见即所得）
- [x] M9 i18n：zh/en 新增 `markdownEditor` 命名空间文案
- [x] M10 生产构建（vite build client+server）通过；tsc 新模块无类型错误
- [x] M11 修复预存构建阻断：补齐缺失的 `app/app/dashboard/settings/page.tsx` 占位页（原路由引用缺失导致 build/dev 依赖扫描失败）

---

验证记录：每次改动在对应 [ ] 打 [x]，并附注日期/改动点。
