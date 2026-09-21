import { describe, expect, it } from "vitest";
import { getApplicationStageMeta, getTemplateCardLabel } from "@/app/app/dashboard/pagePresentation";
import { buildMarkdownTemplateResume, MARKDOWN_TEMPLATES } from "@/config";
import { THEME_COLORS } from "@/types/resume";

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

  it("keeps card positions stable when the gallery is rendered", () => {
    expect([0, 1, 2].map((index) => getTemplateCardLabel(index, 3))).toEqual([
      "Template 1 of 3",
      "Template 2 of 3",
      "Template 3 of 3",
    ]);
  });

  it("keeps closed opportunities out of the active progress rail", () => {
    expect(getApplicationStageMeta("closed")).toEqual({
      index: 0,
      label: "jobStatusClosed",
      tone: "closed",
    });
  });

  it("uses one global default theme color for every template", () => {
    const colors = MARKDOWN_TEMPLATES.map(
      (template) => buildMarkdownTemplateResume(template, "zh").globalSettings.themeColor
    );

    expect(new Set(colors)).toEqual(new Set([THEME_COLORS[0]]));
  });

  it("keeps the current ten-template library to two balanced desktop rows", () => {
    expect(MARKDOWN_TEMPLATES).toHaveLength(10);
    expect(MARKDOWN_TEMPLATES.some((template) => template.id === "impact")).toBe(true);
    expect(Math.ceil(MARKDOWN_TEMPLATES.length / 5)).toBe(2);
  });
});
