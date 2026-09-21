# Unify Dashboard Visual Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一简历匹配、我的投递、投递分析、我的简历、简历模板五个控制台页面的视觉语言，让它们像同一个求职工作台而不是五个独立页面。

**Architecture:** 保留现有 `theme-xai` 作用域作为控制台设计系统的唯一来源，收敛颜色、圆角、边框、阴影、字体和页面间距令牌；将投递分析从独立的纸张色板回收到同一套令牌。页面结构只做必要的语义类名补充，避免重写业务逻辑。

**Tech Stack:** React 18, TanStack Start, Tailwind CSS 3, shadcn/ui, Framer Motion, CSS custom properties.

## Global Constraints

- 五个页面必须继续使用 `theme-xai` 作用域，不能引入新的页面级主题系统。
- 主操作统一使用黑/白胶囊按钮，次操作统一使用细线胶囊按钮。
- 卡片统一使用 `--xai-surface`、`--xai-hairline` 和 12px 圆角，避免页面自定义阴影和独立颜色。
- 保留现有业务文案、路由、API 调用和数据结构；本次只调整视觉呈现和可复用样式。
- 支持响应式布局、键盘焦点和 `prefers-reduced-motion`。

---

### Task 1: Establish the shared workbench design tokens

**Files:**
- Modify: `frontend/src/app/globals.css`

**Interfaces:**
- Consumes: existing `theme-xai`, `xai-card`, `xai-pill-primary`, `xai-pill-outline` classes.
- Produces: shared `.workbench-page`, `.workbench-header`, `.workbench-panel`, and unified light/dark token mappings used by all dashboard pages.

- [ ] **Step 1: Add a failing contract check for the shared classes**

Create `frontend/tests/visual-language.test.ts` with a text-level contract that reads `globals.css` and asserts the shared classes and reduced-motion rule exist.

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("workbench visual language", () => {
  it("defines one shared surface vocabulary", () => {
    const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toContain(".workbench-page");
    expect(css).toContain(".workbench-panel");
    expect(css).toContain(".workbench-header");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `cd frontend && pnpm vitest run tests/visual-language.test.ts`

Expected: FAIL because the shared classes have not been added yet.

- [ ] **Step 3: Add the shared CSS vocabulary**

Add the workbench classes under `@layer components`, map both light and dark themes to the same semantic surface hierarchy, and add visible focus plus reduced-motion behavior. Override the old `.analytics-page` palette so analytics inherits the same tokens.

- [ ] **Step 4: Run the contract test and frontend typecheck**

Run: `cd frontend && pnpm vitest run tests/visual-language.test.ts && pnpm build`

Expected: PASS and a successful production build.

### Task 2: Normalize page headers and panel shells

**Files:**
- Modify: `frontend/src/app/app/dashboard/match/page.tsx`
- Modify: `frontend/src/app/app/dashboard/jobs/page.tsx`
- Modify: `frontend/src/app/app/dashboard/analytics/page.tsx`
- Modify: `frontend/src/app/app/dashboard/resumes/ResumeWorkbench.tsx`
- Modify: `frontend/src/app/app/dashboard/templates/page.tsx`
- Modify: `frontend/src/components/analytics/MatchingObservability.tsx`

**Interfaces:**
- Consumes: shared classes from Task 1.
- Produces: all five pages use the same header rhythm, kicker treatment, panel border, and empty/loading states.

- [ ] **Step 1: Add page-level semantic hooks**

Add `workbench-page` to the page roots, `workbench-header` to page headers, and `workbench-panel` to major content surfaces. Keep existing layout-specific grid and overflow behavior.

- [ ] **Step 2: Remove one-off analytics styling**

Replace analytics-only paper background, navy/coral icon shadow, and analytics-specific panel shadow with the shared neutral surface and a single accent dot.

- [ ] **Step 3: Normalize resume/template cards**

Use the shared 12px card radius, border, hover, and action row treatments for resume and template cards; keep the actual A4 preview white because it represents the document itself.

- [ ] **Step 4: Normalize match/jobs split panes**

Apply the same border, background, and header spacing to the match form/results and jobs list/detail panes without changing their functional controls.

- [ ] **Step 5: Run the build and inspect all route roots**

Run: `cd frontend && pnpm build`

Expected: PASS with no TypeScript or route compilation errors.

### Task 3: Visual QA and cleanup

**Files:**
- Modify: `frontend/src/app/globals.css` if screenshot review finds a shared-token issue.
- Modify: any of the five page files only for verified visual regressions.

**Interfaces:**
- Consumes: all normalized page surfaces from Tasks 1–2.
- Produces: responsive, keyboard-visible, motion-respecting dashboard pages with no accidental page-specific palette.

- [ ] **Step 1: Start the frontend and inspect desktop routes**

Run: `cd frontend && pnpm dev --host 127.0.0.1 --port 3005` and inspect `/app/dashboard/match`, `/app/dashboard/jobs`, `/app/dashboard/analytics`, `/app/dashboard/resumes`, and `/app/dashboard/templates`.

- [ ] **Step 2: Inspect the narrow viewport behavior**

Verify that headers wrap, split panes stack, card grids remain usable, and primary actions stay reachable at approximately 390px wide.

- [ ] **Step 3: Check interaction states**

Keyboard-tab through sidebar links, primary/secondary buttons, cards, and dialogs. Verify the shared focus ring is visible and reduced-motion CSS disables non-essential transitions.

- [ ] **Step 4: Run the final verification**

Run: `cd frontend && pnpm vitest run src/app/app/dashboard/visual-language.test.ts && pnpm build`

Expected: PASS with no new warnings caused by the visual refactor.
