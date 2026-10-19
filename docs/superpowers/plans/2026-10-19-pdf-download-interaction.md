# 简历 PDF 下载交互优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让简历 PDF 导出拥有清晰可见的进行中状态，成功后自动关闭导出弹框并保留成功提示，失败时保留操作上下文并提供打印兜底。

**Architecture:** 保留现有服务端矢量 PDF 导出链路，只扩展导出函数的结果与阶段回调。`PdfExport` 负责把阶段映射成明显的状态面板、锁定不可中断的导出流程，并在成功结果返回后关闭弹框；i18n 文案覆盖中英文。

**Tech Stack:** React 18、TypeScript、Tailwind CSS、Radix Dialog、Sonner、Vitest。

## Global Constraints

- PDF 导出仍使用 `/api/export/pdf` 服务端矢量渲染，不新增依赖。
- 导出过程中不能重复点击或关闭弹框，失败时不能自动关闭弹框。
- 成功 toast 只出现一次，并且按钮、toast、状态文案使用一致的“导出/下载”词汇。
- 遵守 `prefers-reduced-motion`，不依赖细小或唯一的动画来传达状态。
- 中英文 locale 必须同步修改。

### Task 1: 固化导出结果与阶段契约

**Files:**
- Modify: `frontend/src/utils/pdfExportServer.ts`
- Test: `frontend/tests/pdf-export-server.test.ts`

**Interfaces:**
- Produces `PdfExportPhase = "preparing" | "generating" | "downloading"`。
- `exportToServerPdf` 返回 `Promise<boolean>`，成功下载返回 `true`，任何失败返回 `false`。
- `ExportToServerPdfOptions.onProgress` 在构建请求、服务端生成、收到文件三个阶段被调用。

- [x] **Step 1: Write the failing test**

  为导出契约添加最小的纯测试：阶段类型的顺序固定，成功结果与失败结果的语义清晰。

- [x] **Step 2: Run test to verify it fails**

  Run: `pnpm --dir frontend test -- pdf-export-server.test.ts`
  Expected: FAIL，因为当前导出函数没有返回成功布尔值与阶段契约。

- [x] **Step 3: Write minimal implementation**

  给服务端导出选项增加 `onProgress`，在准备 DOM、发起请求、收到 blob 后触发阶段回调；成功路径返回 `true`，catch 路径 toast 后返回 `false`，保留现有 finally 行为。

- [x] **Step 4: Run test to verify it passes**

  Run: `pnpm --dir frontend test -- pdf-export-server.test.ts`
  Expected: PASS。

### Task 2: 重做 PDF 导出中的状态反馈与完成收束

**Files:**
- Modify: `frontend/src/components/shared/PdfExport.tsx`
- Create: `frontend/src/utils/pdfExportInteraction.ts`
- Test: `frontend/tests/pdf-export-interaction.test.ts`

**Interfaces:**
- Consumes Task 1 的 `PdfExportPhase` 和 `exportToServerPdf` 返回值。
- Produces：`pdfExportInteractionReducer` 固化 PDF 卡片的阶段状态、成功关闭 Dialog、失败保持 Dialog 打开的契约；组件使用该 reducer 渲染清晰状态。

- [x] **Step 1: Write the failing test**

  覆盖导出交互 reducer 的状态转换：成功结果关闭弹框，失败结果保持打开，导出中状态被视为不可重复提交。

- [x] **Step 2: Run test to verify it fails**

  Run: `pnpm --dir frontend test -- pdf-export-interaction.test.ts`
  Expected: FAIL，因为当前组件不消费导出结果，也没有可测试的交互状态契约。

- [x] **Step 3: Write minimal implementation**

  在 `PdfExport` 内使用 reducer 加入阶段状态和明显的导出状态面板；导出中隐藏关闭按钮、禁用触发器与卡片；成功结果 dispatch 完成动作关闭弹框，失败完成动作保持弹框；保留服务端函数负责的成功/失败 toast。对自定义触发按钮补充 `disabled`、`aria-busy` 和可见的导出中文案。

- [x] **Step 4: Run test to verify it passes**

  Run: `pnpm --dir frontend test -- pdf-export-interaction.test.ts`
  Expected: PASS。

### Task 3: 补齐中英文界面文案并做整体验证

**Files:**
- Modify: `frontend/src/i18n/locales/zh.json`
- Modify: `frontend/src/i18n/locales/en.json`
- Test: `frontend/tests/pdf-export-interaction.test.ts`

- [x] **Step 1: Add locale strings**

  增加导出状态标题、说明和三个阶段标签，文案说明实际发生的动作，不使用模糊的“请稍候”。

- [x] **Step 2: Run focused tests**

  Run: `pnpm --dir frontend test -- pdf-export-server.test.ts pdf-export-interaction.test.ts`
  Expected: PASS。

- [x] **Step 3: Run full frontend checks**

  Run: `pnpm --dir frontend test && pnpm --dir frontend build`
  Expected: PASS，且构建不产生新的 TypeScript/Vite 错误。

## Self-review

- 需求覆盖：进行中状态、下载完成反馈、成功关闭弹框、失败可恢复、现有打印兜底和中英文文案均有对应任务。
- 视觉风险：状态信息不再依赖小型 spinner，主视觉只突出一个“正在生成 PDF”的状态面板，避免界面同时出现多处竞争动画。
- 可访问性：使用 `aria-busy`、禁用重复提交、保留 Dialog 标题/描述语义，并确保 reduced-motion 下信息仍完整可读。
