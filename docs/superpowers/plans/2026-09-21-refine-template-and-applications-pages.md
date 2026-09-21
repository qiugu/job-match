# Refine Resume Templates and Applications Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the resume template chooser and “My Applications” workspace feel like one concise, polished product surface while preserving their existing data flows and actions.

**Architecture:** Keep the existing dashboard shell, translation keys, API calls, and resume preview components. Refine only the two page compositions and their scoped visual tokens: template selection becomes a quiet paper-preview gallery with a clearer hero and color intent; applications becomes a compact opportunity timeline with a stronger list/detail hierarchy and paper-like reading surfaces. Use existing Tailwind utilities and the xai theme variables rather than adding a UI dependency.

**Tech Stack:** React 18, TanStack Router, Tailwind CSS, framer-motion, Lucide icons, Vitest.

## Global Constraints

- Preserve existing route paths, API behavior, actions, translation keys, and preview generation.
- Keep the existing `.theme-xai` dashboard shell and sidebar visual language.
- Maintain responsive behavior down to narrow mobile widths, visible keyboard focus, and reduced-motion behavior.
- Do not edit generated frontend build output.
- Use the existing font stack and colors as the base; introduce only scoped page tokens where they improve hierarchy.

### Task 1: Add behavior-level coverage for the page composition helpers

**Files:**
- Create: `frontend/src/app/app/dashboard/pagePresentation.ts`
- Create: `frontend/tests/page-presentation.test.ts`

**Interfaces:**
- Produces `getApplicationStageMeta(status)` for stable application status labels, accent colors, and step index.
- Produces `getTemplateCardLabel(index, total)` for accessible gallery position text.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { getApplicationStageMeta, getTemplateCardLabel } from "./pagePresentation";

describe("dashboard page presentation", () => {
  it("maps application stages to ordered progress metadata", () => {
    expect(getApplicationStageMeta("resume_ready")).toEqual({
      index: 2,
      label: "jobStatusResumeReady",
      tone: "ready",
    });
  });

  it("describes a template position for screen readers", () => {
    expect(getTemplateCardLabel(1, 4)).toBe("Template 2 of 4");
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run from `frontend/`: `pnpm vitest run tests/page-presentation.test.ts`

Expected: FAIL because `pagePresentation.ts` does not yet exist.

- [ ] **Step 3: Implement the minimal helper module**

```ts
import type { JobStatus } from "@/lib/jobmatch";

export function getApplicationStageMeta(status: JobStatus) {
  const stages: Record<JobStatus, { index: number; label: string; tone: string }> = {
    greeting_sent: { index: 1, label: "jobStatusGreetingSent", tone: "waiting" },
    resume_ready: { index: 2, label: "jobStatusResumeReady", tone: "ready" },
    applied: { index: 3, label: "jobStatusApplied", tone: "applied" },
    closed: { index: 0, label: "jobStatusClosed", tone: "closed" },
  };
  return stages[status];
}

export function getTemplateCardLabel(index: number, total: number) {
  return `Template ${index + 1} of ${total}`;
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run from `frontend/`: `pnpm vitest run tests/page-presentation.test.ts`

Expected: PASS.

### Task 2: Refine the resume template gallery

**Files:**
- Modify: `frontend/src/app/app/dashboard/templates/page.tsx`
- Modify: `frontend/src/app/app/dashboard/pagePresentation.ts`

**Interfaces:**
- The existing `TemplateCardItem` keeps its preview, dialog, and “use template” behavior.
- The page adds clearer content hierarchy, selected-color explanation, position labels, and a scoped paper-gallery layout.

- [ ] **Step 1: Add a failing assertion for the new accessible card label**

Extend `pagePresentation.test.ts` with:

```ts
it("keeps card positions stable when the gallery is rendered", () => {
  expect([0, 1, 2].map((index) => getTemplateCardLabel(index, 3))).toEqual([
    "Template 1 of 3",
    "Template 2 of 3",
    "Template 3 of 3",
  ]);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run from `frontend/`: `pnpm vitest run tests/page-presentation.test.ts`

Expected: FAIL until the helper is used to generate the exact labels.

- [ ] **Step 3: Implement the template page composition**

Update `templates/page.tsx` to:

- Replace the oversized utility header with a compact eyebrow/title/description block and a right-side theme control labeled as the color used when creating a resume.
- Add a thin progress rail under the intro that communicates “choose a layout → preview it → start editing” without adding a new flow.
- Give each card an accessible `aria-label` from `getTemplateCardLabel`, a quieter paper surround, and one distinct selected/hover state.
- Keep the primary action singular and explicit (“Use this template”); make preview a lower-emphasis action.
- Respect `prefers-reduced-motion` by reducing `motion` transitions on the page/card wrappers.

- [ ] **Step 4: Run focused tests and TypeScript/build checks**

Run from `frontend/`: `pnpm vitest run tests/page-presentation.test.ts` and `pnpm build`.

Expected: PASS with no TypeScript or Vite errors.

### Task 3: Refine the applications list/detail workspace

**Files:**
- Modify: `frontend/src/app/app/dashboard/jobs/page.tsx`
- Modify: `frontend/src/app/app/dashboard/pagePresentation.ts`

**Interfaces:**
- Existing listJobs/getJob/markJob/reopenJob/deleteJob flows remain unchanged.
- Existing `JobRow`, `JobDetailView`, `DerivedCard`, and `PitchCard` remain responsible for their existing data, but receive improved layout classes and stage metadata.

- [ ] **Step 1: Add a failing stage metadata assertion for the closed state**

Extend `pagePresentation.test.ts` with:

```ts
it("keeps closed opportunities out of the active progress rail", () => {
  expect(getApplicationStageMeta("closed")).toEqual({
    index: 0,
    label: "jobStatusClosed",
    tone: "closed",
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run from `frontend/`: `pnpm vitest run tests/page-presentation.test.ts`

Expected: FAIL until the helper exposes the closed-state metadata.

- [ ] **Step 3: Implement the applications composition**

Update `jobs/page.tsx` to:

- Add a small summary strip under the title showing active and archived counts, while keeping the existing “Start a new application” CTA.
- Turn the left column into a deliberate opportunity index with section labels, stronger selected-card treatment, a status rail, and readable empty/loading states.
- Turn the right panel into a paper-like reading surface: title/status/action header, a three-step stage rail for active opportunities, then JD, tailored resumes, and pitch history with consistent section labels.
- Use `getApplicationStageMeta` for status color/step data instead of duplicating stage mapping in the page.
- Improve mobile behavior by allowing the list/detail columns to stack and making the detail panel fill available width.
- Preserve all destructive actions and confirmation dialogs, but visually separate them as a quiet footer zone.

- [ ] **Step 4: Run focused tests and build**

Run from `frontend/`: `pnpm vitest run tests/page-presentation.test.ts && pnpm build`.

Expected: PASS with no TypeScript or Vite errors.

### Task 4: Visual self-review and cleanup

**Files:**
- Modify: `frontend/src/app/app/dashboard/templates/page.tsx`
- Modify: `frontend/src/app/app/dashboard/jobs/page.tsx`
- Modify: `frontend/src/app/globals.css` only if a shared scoped token is genuinely needed

- [ ] **Step 1: Run the dev app and inspect both routes at desktop and narrow widths**

Run: `pnpm --dir frontend dev --host 127.0.0.1`.

Inspect `/app/dashboard/templates` and `/app/dashboard/jobs` with keyboard focus visible and reduced motion enabled.

- [ ] **Step 2: Remove one non-essential decorative treatment**

Keep only the paper-preview/vertical-status-rail signature; remove any extra gradients, badges, or motion that compete with the page job.

- [ ] **Step 3: Run the final verification**

Run from `frontend/`: `pnpm vitest run tests/page-presentation.test.ts && pnpm build`.

Expected: PASS.
