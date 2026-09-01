/**
 * 回归测试（2026-08-31 PDF 导入「非列表行被加圆点」→ 内容无关渲染原则）：
 *
 * 背景：简历内容是灵活的（用户自行编写 或 PDF 上传），渲染规则不能依赖
 * 任何具体简历词汇或布局假设。此前 buildMarkdownContent 用「核心贡献/技术栈」
 * 等关键词猜测子标题/标签/段落，导致：
 *   - 以单份样例简历为准写死规则，换一份简历就失效；
 *   - 与用户手写路径（直接写 markdown 行）样式不一致。
 *
 * 内容无关原则：结构（列表 / 子标题 / 段落）由内容来源决定，前端只做
 * 「字符串数组 → markdown 行」的通用透传：
 *   - 手写路径：用户直接在 markdown 编辑器写带结构的行；
 *   - 上传路径：后端 LLM 依据实际内容输出带结构的 description 行。
 *
 * 本文件锁定 renderDescriptionRows 的透传契约与 buildMarkdownContent 的
 * 内容无关生成规则。
 */
import { describe, expect, it, vi } from "vitest";

// @/config 会引出组件注册表（templates/registry），测试环境无 DOM，mock 掉。
vi.mock("@/config", () => ({
  MARKDOWN_TEMPLATES: [],
}));

import {
  createResumeFromAIResult,
  renderDescriptionRows,
} from "@/app/app/dashboard/resumes/utils";

describe("renderDescriptionRows", () => {
  it("透传已带 markdown 结构的行（列表 / 子标题 / 段落）", () => {
    const input = [
      "- 负责 AI 对话模块及 Agent 工作流设计",
      "### 核心贡献",
      "负责企业级 AI 平台及业务系统研发",
    ];
    const lines = renderDescriptionRows(input);
    expect(lines[0]).toBe("- 负责 AI 对话模块及 Agent 工作流设计");
    expect(lines[1]).toBe("### 核心贡献");
    expect(lines[2]).toBe("负责企业级 AI 平台及业务系统研发");
  });

  it("空输入返回空数组", () => {
    expect(renderDescriptionRows([])).toEqual([]);
    expect(renderDescriptionRows(null)).toEqual([]);
    expect(renderDescriptionRows("")).toEqual([]);
  });
});

describe("createResumeFromAIResult（内容无关渲染）", () => {
  // 用户真实 PDF「毕友佳-AI全栈开发 (2).pdf」经后端导入接口返回的 resume 结构
  const realResult = {
    title: "AI全栈开发",
    basic: { name: "毕友佳", title: "AI全栈开发" },
    education: [
      {
        school: "安徽师范大学",
        major: "计算机科学与技术",
        degree: "本科",
        startDate: "2020-09",
        endDate: "2022-06",
        description: [],
      },
    ],
    experience: [
      {
        company: "上海爱数",
        position: "平台方向负责人",
        date: "2022-04 - 2026-05",
        details: [
          "负责企业级 AI 平台及业务系统研发，主导核心模块设计与交付；推动 Monorepo、微前端及 CI/CD 建设，累计输出 100+ 技术方案文档。",
        ],
      },
    ],
    projects: [
      {
        name: "告警与故障分析 Agent 应用",
        role: "负责人",
        date: "2025-11 - 2026-05",
        description: [
          "### 核心贡献",
          "- 负责 AI 对话模块及 Agent 工作流设计，完成前后端方案设计与核心功能开发。",
          "- 封装企业级 ChatUI 组件，支持多轮对话、Markdown、代码高亮、Mermaid 等能力",
          "### 项目成果",
          "- 实现自动根因分析、故障传播链分析及智能诊断能力",
        ],
      },
    ],
    skills: [
      "前端：React、TypeScript、JavaScript、Vite",
      "服务端：Node.js、Python、NestJS、FastAPI",
    ],
  };

  it("姓名区不强制任何对齐（与手写路径一致的通用 # 标题）", () => {
    const resume = createResumeFromAIResult(realResult, "毕友佳.pdf");
    const md = resume.markdownContent;
    expect(md).toContain("# 毕友佳 | AI全栈开发");
    // 不写死居中：:::center 由用户/模板决定，导入不应强加
    expect(md).not.toContain(":::center");
  });

  it("项目描述按后端提供的结构原样渲染（### 子标题 + - 列表 + 段落）", () => {
    const resume = createResumeFromAIResult(realResult, "毕友佳.pdf");
    const md = resume.markdownContent;
    expect(md).toContain("### 核心贡献");
    expect(md).toContain("### 项目成果");
    expect(md).toContain("- 负责 AI 对话模块及 Agent 工作流设计");
    // 子标题不带圆点
    expect(md).not.toMatch(/- 核心贡献/);
    expect(md).not.toMatch(/- 项目成果/);
  });

  it("工作经历描述原样渲染为段落（后端未加 - 前缀则不强制列表）", () => {
    const resume = createResumeFromAIResult(realResult, "毕友佳.pdf");
    const md = resume.markdownContent;
    expect(md).toContain("负责企业级 AI 平台及业务系统研发");
    expect(md).not.toMatch(/- 负责企业级 AI 平台及业务系统研发/);
  });

  it("教育经历用通用 ### 标题（学校 · 专业（日期）），不写死左右分布", () => {
    const resume = createResumeFromAIResult(realResult, "毕友佳.pdf");
    const md = resume.markdownContent;
    expect(md).toContain(
      "### 安徽师范大学 · 计算机科学与技术 本科（2020-09 - 2022-06）"
    );
    // 不强制 :::left/:::right（由用户/模板决定）
    expect(md).not.toContain(":::left");
    expect(md).not.toContain(":::right");
  });
});
