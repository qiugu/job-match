# 预览面板按钮与工作台 FAQ 优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复简历编辑右侧浮动栏的预览面板展开/收起按钮，使其真正控制当前 Markdown 工作台的预览面板，并将 FAQ 内容改为与当前编辑、预览、模板和 PDF 导出流程一致。

**Architecture:** 预览面板始终保留在 `react-resizable-panels` 的面板树中，通过 `ImperativePanelHandle` 的 `collapse/expand` 控制尺寸，避免条件卸载面板后 `defaultSize` 不重新生效。FAQ 继续复用现有 `FAQDialog` 与 `FAQ_KEYS`，只更新条目键和中英文文案，不改变浮动栏中当前隐藏按钮的显示范围。

**Tech Stack:** React 18、TanStack Start、TypeScript、react-resizable-panels、Vitest、现有 i18n JSON。

## Global Constraints

- 浮动栏只保留当前页面已经显示的模板、导出、复制、预览、返回和帮助入口；不得恢复语法检查、自动一页纸或编辑面板浮动按钮。
- 预览面板收起后编辑器仍保持可见；再次展开后恢复预览面板。
- FAQ 文案必须描述当前 Markdown 编辑器、实时预览、模板切换、PDF 导出和简历复制流程，不再引用已移除的左侧结构化编辑面板拖拽流程。
- 不新增依赖；后端 API、数据结构和移动端布局不在本次范围内。

---

### Task 1: 为预览面板控制和 FAQ 文案补充失败测试

**Files:**
- Modify: `frontend/tests/preview-dock-actions.test.ts`
- Create: `frontend/tests/workbench-faq.test.ts`

**Interfaces:**
- Tests consume the existing `PreviewDock`, `MarkdownWorkbench`, `FAQ_KEYS`, and locale JSON source files.
- Tests produce regression coverage for imperative preview panel control and current FAQ topics.

- [ ] **Step 1: Write the failing preview-control assertions**

Add assertions that `MarkdownWorkbench.tsx` imports `ImperativePanelHandle`, creates a preview panel ref, keeps a collapsible preview panel mounted, and calls `collapse()`/`expand()` from `previewPanelCollapsed`. Add an assertion that `page.tsx` uses a functional state updater for the toggle:

```ts
expect(markdownWorkbench).toContain("ImperativePanelHandle");
expect(markdownWorkbench).toContain("previewPanelRef");
expect(markdownWorkbench).toContain("collapsible");
expect(markdownWorkbench).toContain("collapsedSize={0}");
expect(markdownWorkbench).toContain("previewPanelRef.current?.collapse()");
expect(markdownWorkbench).toContain("previewPanelRef.current?.expand(50)");
expect(workbench).toContain(
  "setPreviewPanelCollapsed((collapsed) => !collapsed)"
);
```

- [ ] **Step 2: Add FAQ source coverage**

Create `workbench-faq.test.ts` that checks the FAQ keys are the four current topics and both locale files contain the current workflow terms while omitting the obsolete drag-and-drop wording:

```ts
expect(faqConfig).toContain('"markdown-editor"');
expect(faqConfig).toContain('"preview-panel"');
expect(faqConfig).toContain('"pdf-export"');
expect(faqConfig).toContain('"resume-management"');
expect(zh).toContain("Markdown 编辑器");
expect(zh).toContain("实时预览");
expect(zh).toContain("模板");
expect(zh).not.toContain("拖拽调整模块顺序");
expect(en).toContain("Markdown editor");
expect(en).toContain("live preview");
expect(en).toContain("template");
expect(en).not.toContain("drag and drop to reorder modules");
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
cd frontend
pnpm test -- --run tests/preview-dock-actions.test.ts tests/workbench-faq.test.ts
```

Expected: the new preview-control assertions and FAQ assertions fail because the current panel is conditionally mounted and the locale content still describes the old workflow.

### Task 2: Make the floating preview button control the live panel

**Files:**
- Modify: `frontend/src/app/app/workbench/[id]/page.tsx`
- Modify: `frontend/src/components/editor/MarkdownWorkbench.tsx`

**Interfaces:**
- `Home` continues to pass `previewPanelCollapsed` and `togglePreviewPanel` to `PreviewDock`.
- `MarkdownWorkbench` owns an `ImperativePanelHandle` for the always-mounted `markdown-preview-panel` and synchronizes its size with `previewPanelCollapsed`.

- [ ] **Step 1: Use a functional state transition**

Change the callback in `page.tsx` to avoid capturing a stale state value:

```tsx
const togglePreviewPanel = () => {
  setPreviewPanelCollapsed((collapsed) => !collapsed);
};
```

- [ ] **Step 2: Control the preview panel imperatively**

In `MarkdownWorkbench.tsx`, import `useEffect` and `ImperativePanelHandle`, create `previewPanelRef`, and synchronize it:

```tsx
const previewPanelRef = useRef<ImperativePanelHandle>(null);

useEffect(() => {
  if (previewPanelCollapsed) {
    previewPanelRef.current?.collapse();
  } else {
    previewPanelRef.current?.expand(50);
  }
}, [previewPanelCollapsed]);
```

Keep the preview `ResizablePanel` mounted with `ref={previewPanelRef}`, `collapsible`, `collapsedSize={0}`, and `defaultSize={50}`. Keep the resize handle mounted beside it. This gives the button a real panel API to operate on while preserving the editor panel.

- [ ] **Step 3: Run the focused tests and verify GREEN**

Run:

```bash
cd frontend
pnpm test -- --run tests/preview-dock-actions.test.ts tests/workbench-faq.test.ts
pnpm exec tsc --noEmit
```

Expected: focused tests pass and TypeScript reports no errors.

### Task 3: Rewrite FAQ for the current workbench

**Files:**
- Modify: `frontend/src/config/faq.tsx`
- Modify: `frontend/src/i18n/locales/zh.json`
- Modify: `frontend/src/i18n/locales/en.json`

**Interfaces:**
- `FAQDialog` continues to map `FAQ_KEYS` to `faqDialog.items.<key>`.
- The landing-page FAQ data remains untouched; only the floating workbench FAQ uses these keys.

- [ ] **Step 1: Replace obsolete FAQ keys**

Set `FAQ_KEYS` to:

```ts
export const FAQ_KEYS = [
  "markdown-editor",
  "preview-panel",
  "pdf-export",
  "resume-management",
];
```

- [ ] **Step 2: Add current Chinese and English questions and answers**

Use four topics in both locales:

1. Editing Markdown and seeing the live preview.
2. Expanding/collapsing the preview panel from the floating eye button.
3. Choosing the normal PDF export or browser print fallback.
4. Switching templates and duplicating the current resume.

Keep answers concise, avoid links to unrelated features, and make clear that changes are saved to the current resume through the editor/store flow.

- [ ] **Step 3: Run the full frontend validation**

Run:

```bash
cd frontend
pnpm test
pnpm exec tsc --noEmit
pnpm build
```

Expected: all tests pass, type-check passes, and both client and SSR builds complete successfully.

- [ ] **Step 4: Commit the completed change**

```bash
git add frontend/src/app/app/workbench/[id]/page.tsx frontend/src/components/editor/MarkdownWorkbench.tsx frontend/src/config/faq.tsx frontend/src/i18n/locales/zh.json frontend/src/i18n/locales/en.json frontend/tests/preview-dock-actions.test.ts frontend/tests/workbench-faq.test.ts docs/superpowers/plans/2026-10-21-preview-toggle-faq.md
git commit -m "fix: 修复预览面板切换并更新工作台FAQ"
```
