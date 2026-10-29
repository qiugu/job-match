/**
 * 简历翻译纯函数契约测试（PLAN_resume_translate.md §4.3）：
 *
 * 1. extractTranslatableFields 只提取「可翻译文本」——id/模板/排版/日期等
 *    非文本配置绝不进入 LLM 载荷；
 * 2. applyTranslatedFields 按 key 合并译文，缺失 key 回退原文（部分成功可用），
 *    多余 key 忽略，且不修改入参（返回新对象）；
 * 3. extract / apply 共用同一字段清单（forEachTranslatableField），
 *    两向路径对称——提取出的 key 必定能被合并回写。
 */
import { describe, expect, it } from "vitest";

import {
  TRANSLATE_LANGUAGES,
  applyTranslatedFields,
  extractTranslatableFields,
} from "@/lib/resumeTranslate";
import type { ResumeData } from "@/types/resume";

const buildResume = (): ResumeData =>
  ({
    id: "resume-1",
    title: "我的简历",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    templateId: "swiss",
    basic: {
      name: "张三",
      title: "前端工程师",
      email: "zhangsan@example.com",
      phone: "13800000000",
      location: "上海",
      employementStatus: "在职",
      birthDate: "1995-01-01",
      photo: "data:image/png;base64,xxxx",
      photoConfig: {
        width: 90,
        height: 120,
        aspectRatio: "1:1",
        borderRadius: "none",
        customBorderRadius: 0,
      },
      customFields: [
        { id: "cf-1", label: "博客", value: "https://blog.example.com" },
      ],
      icons: {},
      githubKey: "",
      githubUseName: "",
      githubContributionsVisible: false,
    },
    education: [
      {
        id: "edu-1",
        school: "复旦大学",
        major: "软件工程",
        degree: "学士",
        startDate: "2013-09",
        endDate: "2017-06",
        gpa: "3.8",
        description: "主修课程：操作系统",
      },
    ],
    experience: [
      {
        id: "exp-1",
        company: "Acme Corp",
        position: "高级工程师",
        date: "2020-01 - 至今",
        details: "- 负责前端架构\n- **主导**性能优化",
      },
    ],
    projects: [
      {
        id: "proj-1",
        name: "简历平台",
        role: "负责人",
        date: "2022",
        description: "### 核心贡献\n- 设计导出流水线",
        visible: true,
        link: "https://github.com/example/resume",
        linkLabel: "开源仓库",
      },
    ],
    certificates: [
      { id: "cert-1", url: "data:image/png;base64,yyyy", width: 45 },
    ],
    customData: {
      "sec-1": [
        {
          id: "item-1",
          title: "获奖",
          subtitle: "一等奖",
          dateRange: "2021",
          description: "校级竞赛",
          visible: true,
        },
      ],
    },
    skillContent: "- React\n- TypeScript",
    selfEvaluationContent: "热爱开源",
    markdownContent:
      "# 张三\n:::left\n前端工程师\n:::\n## 工作经历\n- 负责前端架构",
    activeSection: "basic",
    draggingProjectId: null,
    menuSections: [
      { id: "basic", title: "基本信息", icon: "user", enabled: true, order: 0 },
      { id: "exp", title: "工作经历", icon: "briefcase", enabled: true, order: 1 },
    ],
    globalSettings: {
      themeColor: "#0047AB",
      fontFamily: "Noto Sans SC",
      baseFontSize: 11,
      pagePadding: 48,
      lineHeight: 1.5,
    },
  }) as unknown as ResumeData;

describe("extractTranslatableFields", () => {
  it("提取全部可翻译文本字段（key 含稳定 id 路径）", () => {
    const fields = extractTranslatableFields(buildResume());

    expect(fields["title"]).toBe("我的简历");
    expect(fields["basic.name"]).toBe("张三");
    expect(fields["basic.title"]).toBe("前端工程师");
    expect(fields["basic.location"]).toBe("上海");
    expect(fields["basic.employementStatus"]).toBe("在职");
    expect(fields["basic.customFields.cf-1.label"]).toBe("博客");
    expect(fields["education.edu-1.school"]).toBe("复旦大学");
    expect(fields["education.edu-1.degree"]).toBe("学士");
    expect(fields["education.edu-1.description"]).toBe("主修课程：操作系统");
    expect(fields["experience.exp-1.company"]).toBe("Acme Corp");
    expect(fields["experience.exp-1.details"]).toBe(
      "- 负责前端架构\n- **主导**性能优化"
    );
    expect(fields["projects.proj-1.description"]).toBe(
      "### 核心贡献\n- 设计导出流水线"
    );
    expect(fields["projects.proj-1.linkLabel"]).toBe("开源仓库");
    expect(fields["skillContent"]).toBe("- React\n- TypeScript");
    expect(fields["selfEvaluationContent"]).toBe("热爱开源");
    expect(fields["customData.sec-1.item-1.subtitle"]).toBe("一等奖");
    expect(fields["menuSections.exp.title"]).toBe("工作经历");
    expect(fields["markdownContent"]).toContain(":::left");
  });

  it("绝不包含非文本配置：id / 日期 / 排版 / 联系方式 / 链接", () => {
    const fields = extractTranslatableFields(buildResume());

    expect(fields).not.toHaveProperty("id");
    expect(fields).not.toHaveProperty("createdAt");
    expect(fields).not.toHaveProperty("templateId");
    expect(fields).not.toHaveProperty("globalSettings");
    expect(fields).not.toHaveProperty("basic.email");
    expect(fields).not.toHaveProperty("basic.phone");
    expect(fields).not.toHaveProperty("basic.birthDate");
    expect(fields).not.toHaveProperty("education.edu-1.startDate");
    expect(fields).not.toHaveProperty("education.edu-1.gpa");
    expect(fields).not.toHaveProperty("experience.exp-1.date");
    expect(fields).not.toHaveProperty("projects.proj-1.link");
    expect(fields).not.toHaveProperty("projects.proj-1.date");
    expect(fields).not.toHaveProperty("certificates");
    expect(fields).not.toHaveProperty("menuSections.exp.order");

    // 兜底：任何值都不应是配置对象（全部为字符串）
    for (const value of Object.values(fields)) {
      expect(typeof value).toBe("string");
    }
  });

  it("空字符串字段不进入映射（无内容可译）", () => {
    const resume = buildResume();
    resume.basic.customFields[0].value = "";
    resume.selfEvaluationContent = "";
    const fields = extractTranslatableFields(resume);

    expect(fields).not.toHaveProperty("basic.customFields.cf-1.value");
    expect(fields).not.toHaveProperty("selfEvaluationContent");
    // 其余字段不受影响
    expect(fields["title"]).toBe("我的简历");
  });

  it("防御脏数据：customData 缺失 id 的条目被跳过，不生成 undefined key", () => {
    const resume = buildResume();
    // 注入一条历史脏数据（无 id 的 customData 条目）
    resume.customData["sec-2"] = [
      { id: "", title: "孤儿标题", subtitle: "", dateRange: "", description: "", visible: true },
    ];
    const fields = extractTranslatableFields(resume);

    // 不产生 customData.sec-2.undefined.* 这类无效 key
    for (const key of Object.keys(fields)) {
      expect(key).not.toContain("undefined");
    }
    expect(fields).not.toHaveProperty("customData.sec-2..title");
    // 正常的 sec-1 条目不受影响
    expect(fields["customData.sec-1.item-1.subtitle"]).toBe("一等奖");
  });
});

describe("applyTranslatedFields", () => {
  it("按 key 合并译文，返回新对象且不修改入参", () => {
    const resume = buildResume();
    const before = JSON.stringify(resume);
    const translated = applyTranslatedFields(resume, {
      title: "My Resume",
      "basic.name": "Zhang San",
      "experience.exp-1.details": "- Led frontend architecture\n- **Led** perf work",
      "menuSections.exp.title": "Experience",
      "markdownContent": "# Zhang San\n:::left\nFrontend Engineer\n:::\n## Experience",
    });

    expect(translated.title).toBe("My Resume");
    expect(translated.basic.name).toBe("Zhang San");
    expect(translated.experience[0].details).toBe(
      "- Led frontend architecture\n- **Led** perf work"
    );
    expect(translated.menuSections[1].title).toBe("Experience");
    expect(translated.markdownContent).toContain("## Experience");

    // 入参未被修改（纯函数）
    expect(JSON.stringify(resume)).toBe(before);
    expect(resume.title).toBe("我的简历");
  });

  it("缺失 key 回退原文（LLM 部分成功可用）", () => {
    const resume = buildResume();
    const translated = applyTranslatedFields(resume, {
      title: "My Resume",
      // 其余 key 故意缺失
    });

    expect(translated.title).toBe("My Resume");
    expect(translated.basic.name).toBe("张三");
    expect(translated.skillContent).toBe("- React\n- TypeScript");
    expect(translated.education[0].school).toBe("复旦大学");
  });

  it("忽略未知 key，绝不触碰非文本字段", () => {
    const resume = buildResume();
    const translated = applyTranslatedFields(resume, {
      title: "My Resume",
      ghost: "不该出现",
      id: "hacked",
      "templateId": "hacked",
    } as Record<string, string>);

    expect(translated.title).toBe("My Resume");
    expect(translated.id).toBe("resume-1");
    expect(translated.templateId).toBe("swiss");
    expect(translated.globalSettings.themeColor).toBe("#0047AB");
    expect(translated.basic.email).toBe("zhangsan@example.com");
    expect(translated.education[0].gpa).toBe("3.8");
    expect("ghost" in translated).toBe(false);
  });

  it("extract → apply 往返对称：提取出的 key 必定能回写", () => {
    const resume = buildResume();
    const fields = extractTranslatableFields(resume);
    // 模拟 LLM：全部值打上 [EN] 前缀
    const mocked: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      mocked[key] = `[EN]${value}`;
    }
    const translated = applyTranslatedFields(resume, mocked);

    for (const [key, value] of Object.entries(
      extractTranslatableFields(translated)
    )) {
      // LLM 原样回传 key 时，每个提取路径都应已写入译文
      expect(value.startsWith("[EN]") || mocked[key] === undefined).toBe(true);
    }
    expect(translated.title).toBe("[EN]我的简历");
    expect(translated.markdownContent).toBe(`[EN]${resume.markdownContent}`);
  });
});

describe("TRANSLATE_LANGUAGES", () => {
  it("本期仅中英，与后端白名单对齐", () => {
    expect(TRANSLATE_LANGUAGES.map((l) => l.code).sort()).toEqual(["en", "zh"]);
  });
});
