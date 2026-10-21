# 简历编辑浮动按钮交互修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复并修复简历编辑器右侧浮动 Dock 的所有桌面端操作，使每个可见按钮都有明确、可触发且可验证的行为。

**Architecture:** 保留现有 `PreviewDock` 作为操作编排层，将模板/导出这类复合触发器收敛为单一可点击的原生按钮；恢复语法检查和自动一页纸操作，并让编辑/预览按钮直接控制当前实际渲染的 `MarkdownWorkbench`。移除没有对应可见面板的旧侧栏按钮语义，让预览内容 ref 连接到真实的 `MarkdownPreview`。通过 Node 环境下的源码契约回归测试覆盖按钮存在、回调接线和可访问性属性，再用 TypeScript/Vite 构建验证实际组合。

**Tech Stack:** React 18、TanStack Start、Radix Tooltip/Dialog/Sheet、Framer Motion、Vitest、pnpm。

## Global Constraints

- 所有后端路由和数据契约不变，本次只修改前端编辑器交互。
- 新分支必须基于 `main` 创建，分支名为 `codex/fix-workbench-floating-actions`。
- 前端依赖继续使用仓库已锁定的 pnpm 版本，不新增依赖。
- 浮动按钮必须保留桌面端隐藏规则 `hidden md:flex`，移动端仍由 `MobileWorkbench` 负责布局。
- 交互触发器使用 `button type="button"`，并保留可读的 `aria-label` 或现有 Tooltip 文案。

---

### Task 1: 建立浮动 Dock 交互回归测试

**Files:**
- Create: `frontend/tests/preview-dock-actions.test.ts`
- Read: `frontend/src/components/preview/PreviewDock.tsx`
- Read: `frontend/src/app/app/workbench/[id]/page.tsx`

**Interfaces:**
- Consumes: `PreviewDock` 的按钮和回调接线、Workbench 对 `PreviewPanel` 的 ref 传递。
- Produces: 可在后续修改中重复运行的按钮交互源码契约。

- [x] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("workbench floating dock actions", () => {
  it("renders every desktop dock action as an explicit button", () => {
    const dock = source("src/components/preview/PreviewDock.tsx");

    expect(dock).toContain('onClick={handleGrammarCheck}');
    expect(dock).toContain('onClick={toggleSidePanel}');
    expect(dock).toContain('onClick={toggleEditPanel}');
    expect(dock).toContain('onClick={togglePreviewPanel}');
    expect(dock).toContain('onClick={handleCopyResume}');
    expect(dock).toContain('router.push("/app/dashboard")');
    expect(dock).toContain('updateGlobalSettings({ autoOnePage: !globalSettings?.autoOnePage })');
    expect(dock.match(/<button\b/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(dock).not.toContain("{/* <DockIcon>");
  });

  it("connects the preview content ref used by the grammar action", () => {
    const workbench = source("src/app/app/workbench/[id]/page.tsx");

    expect(workbench).toContain("ref={resumeContentRef}");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd frontend && pnpm test -- preview-dock-actions.test.ts`

Expected: FAIL because grammar/auto-one-page/side-panel/edit-panel actions are commented or absent, and `PreviewPanel` does not receive `ref={resumeContentRef}`.

- [x] **Step 3: Commit test only**

```bash
git add frontend/tests/preview-dock-actions.test.ts
git commit -m "test: 增加编辑器浮动按钮交互回归"
```

### Task 2: 恢复并接通 PreviewDock 的全部操作

**Files:**
- Modify: `frontend/src/components/preview/PreviewDock.tsx`
- Modify: `frontend/src/app/app/workbench/[id]/page.tsx`
- Modify: `frontend/src/components/editor/MarkdownWorkbench.tsx`

**Interfaces:**
- Consumes: Task 1 的失败回归测试；现有 `PreviewDockProps`、`useGrammarCheck`、`useResumeStore` 和路由回调。
- Produces: 模板切换、语法检查、自动一页纸、导出、复制简历、编辑/预览面板、返回仪表盘、帮助弹窗均可操作的桌面 Dock。

- [x] **Step 1: Restore the previously removed actions**

在 `PreviewDock` 中恢复语法检查与自动一页纸 `DockIcon`，保留当前真实 Markdown 布局对应的编辑面板和预览面板两个 `DockIcon`；没有实际渲染目标的旧侧栏按钮不再展示。所有触发器改成：

```tsx
<button type="button" aria-label={label} onClick={action} className={...}>
  <Icon className="h-4 w-4" />
</button>
```

面板按钮使用现有状态文案：`sidePanelCollapsed ? t("sidePanel.expand") : t("sidePanel.collapse")`、`editPanelCollapsed ? t("editPanel.expand") : t("editPanel.collapse")`、`previewPanelCollapsed ? t("previewPanel.expand") : t("previewPanel.collapse")`。自动一页纸继续调用 `updateGlobalSettings` 并显示已有成功 Toast；语法检查继续调用 `handleGrammarCheck`。

- [x] **Step 2: Remove non-interactive click targets**

将复制简历和返回仪表盘的 `div onClick` 改成 `button type="button"`；模板和 PDF 自定义触发器也补上 `type="button"`、`aria-label`，保证点击目标是唯一且可聚焦的按钮。

- [x] **Step 3: Connect the preview ref and panel state**

让 `MarkdownWorkbench` 接收编辑/预览折叠状态和 `resumeContentRef`，按状态条件渲染两个真实面板，并将 ref 传给 `MarkdownPreview`，使 `PreviewDock` 的语法检查优先读取真实预览节点；保留现有 DOM id fallback。至少保留一个可见面板，避免两个面板同时卸载。

- [x] **Step 4: Run the focused test to verify it passes**

Run: `cd frontend && pnpm test -- preview-dock-actions.test.ts`

Expected: PASS。

### Task 3: 运行完整前端验证并检查差异

**Files:**
- Modify: `docs/superpowers/plans/2026-10-21-fix-workbench-floating-actions.md`（仅勾选已完成步骤）

- [x] **Step 1: Run all frontend tests**

Run: `cd frontend && pnpm test`

Expected: PASS，不能出现由本次修改引入的新失败。

- [x] **Step 2: Run production build/type validation**

Run: `cd frontend && pnpm build`

Expected: Vite client 与 SSR 构建成功。

- [x] **Step 3: Inspect final diff and working tree**

Run: `git diff --check && git status --short && git diff --stat`

Expected: 仅包含浮动 Dock、Workbench ref、回归测试和本计划文件的改动；无生成产物、数据库或环境文件。

- [ ] **Step 4: Commit implementation and verification changes**

```bash
git add frontend/src/components/preview/PreviewDock.tsx frontend/src/app/app/workbench/[id]/page.tsx frontend/tests/preview-dock-actions.test.ts docs/superpowers/plans/2026-10-21-fix-workbench-floating-actions.md
git commit -m "fix: 修复简历编辑浮动按钮交互"
```
