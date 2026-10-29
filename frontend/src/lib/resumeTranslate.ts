/**
 * 简历翻译的纯函数层：可翻译字段提取 / 译文合并。
 *
 * 设计决策（PLAN_resume_translate.md §2.1）：翻译采用「键值映射」而非整包
 * ResumeData 回传——id/模板/排版设置/日期等非文本配置从不离开客户端，LLM
 * 物理上无法破坏结构。本模块负责：
 *   1. extractTranslatableFields：把 ResumeData 中「可翻译文本」摊平为
 *      `字段路径 → 文本` 映射（key 含稳定 id 路径，如 `experience.{id}.details`）；
 *   2. applyTranslatedFields：把译文按 key 合并回简历副本，缺失 key 回退原文
 *     （LLM 部分成功时可用），绝不触碰非文本字段。
 *
 * 字段清单以 forEachTranslatableField 为单一事实源：extract 与 apply 共用同一
 * 遍历，避免两处清单漂移。纯函数、无副作用，可被单测完整覆盖
 * （frontend/tests/resume-translate-fields.test.ts）。
 */
import type { ResumeData } from "@/types/resume";

export interface TranslateLanguage {
  code: string;
  /** 语言名以目标语言自身书写（语言选择器惯例），不随 UI 语言变化 */
  label: string;
}

/** 目标语言白名单：与后端 ai_proxy.TRANSLATE_LANGUAGES 对齐（本期仅中英）。 */
export const TRANSLATE_LANGUAGES: TranslateLanguage[] = [
  { code: "en", label: "English" },
  { code: "zh", label: "简体中文" },
];

/** 待译文本字段的写回器 */
type FieldSetter = (value: string) => void;

/**
 * 遍历 ResumeData 中全部可翻译文本字段（单一事实源）。
 *
 * 刻意不包含：所有 id、createdAt/updatedAt、templateId、globalSettings、
 * photoConfig、日期字符串、gpa、邮箱/电话/URL、certificates、
 * menuSections 的 order/enabled/icon——这些非文本配置不上传 LLM。
 *
 * 注意：本模块只决定「发不发」，不决定「怎么译」——翻译策略在后端
 * `TRANSLATE_SYSTEM`（见 docs/PLAN_resume_translate.md §2.4 的三档策略表）：
 * 学校名/项目名必须本地化，公司名/人名/纯代号保留原文。**新增字段时必须同步
 * 确认后端策略档位**，否则会出现「进了清单却整类原样返回」的静默漏译
 * （2026-10-29 修复：`school` 与 `projects.name` 曾因 prompt 的专名保留规则
 * 在英译中方向 100% 未翻译，详见 docs/FIX_translate_proper_nouns.md）。
 */
function forEachTranslatableField(
  resume: ResumeData,
  visit: (key: string, value: string, set: FieldSetter) => void
): void {
  const put = (
    key: string,
    value: string | undefined | null,
    set: FieldSetter
  ) => {
    if (typeof value === "string" && value.length > 0) {
      visit(key, value, set);
    }
  };

  put("title", resume.title, (v) => (resume.title = v));

  const basic = resume.basic;
  put("basic.name", basic.name, (v) => (basic.name = v));
  put("basic.title", basic.title, (v) => (basic.title = v));
  put("basic.location", basic.location, (v) => (basic.location = v));
  put(
    "basic.employementStatus",
    basic.employementStatus,
    (v) => (basic.employementStatus = v)
  );
  for (const field of basic.customFields ?? []) {
    put(
      `basic.customFields.${field.id}.label`,
      field.label,
      (v) => (field.label = v)
    );
    put(
      `basic.customFields.${field.id}.value`,
      field.value,
      (v) => (field.value = v)
    );
  }

  for (const edu of resume.education ?? []) {
    put(`education.${edu.id}.school`, edu.school, (v) => (edu.school = v));
    put(`education.${edu.id}.major`, edu.major, (v) => (edu.major = v));
    put(`education.${edu.id}.degree`, edu.degree, (v) => (edu.degree = v));
    put(
      `education.${edu.id}.description`,
      edu.description,
      (v) => (edu.description = v)
    );
  }

  for (const exp of resume.experience ?? []) {
    put(
      `experience.${exp.id}.company`,
      exp.company,
      (v) => (exp.company = v)
    );
    put(
      `experience.${exp.id}.position`,
      exp.position,
      (v) => (exp.position = v)
    );
    put(`experience.${exp.id}.details`, exp.details, (v) => (exp.details = v));
  }

  for (const proj of resume.projects ?? []) {
    put(`projects.${proj.id}.name`, proj.name, (v) => (proj.name = v));
    put(`projects.${proj.id}.role`, proj.role, (v) => (proj.role = v));
    put(
      `projects.${proj.id}.description`,
      proj.description,
      (v) => (proj.description = v)
    );
    put(
      `projects.${proj.id}.linkLabel`,
      proj.linkLabel,
      (v) => (proj.linkLabel = v)
    );
  }

  put(
    "skillContent",
    resume.skillContent,
    (v) => (resume.skillContent = v)
  );
  put(
    "selfEvaluationContent",
    resume.selfEvaluationContent,
    (v) => (resume.selfEvaluationContent = v)
  );

  for (const [sectionId, items] of Object.entries(resume.customData ?? {})) {
    for (const item of items ?? []) {
      // 防御历史脏数据：缺失 id 的条目无法生成稳定 key，跳过以免污染 LLM 载荷
      if (!item.id) continue;
      put(
        `customData.${sectionId}.${item.id}.title`,
        item.title,
        (v) => (item.title = v)
      );
      put(
        `customData.${sectionId}.${item.id}.subtitle`,
        item.subtitle,
        (v) => (item.subtitle = v)
      );
      put(
        `customData.${sectionId}.${item.id}.description`,
        item.description,
        (v) => (item.description = v)
      );
    }
  }

  for (const section of resume.menuSections ?? []) {
    put(
      `menuSections.${section.id}.title`,
      section.title,
      (v) => (section.title = v)
    );
  }

  put(
    "markdownContent",
    resume.markdownContent,
    (v) => (resume.markdownContent = v)
  );
}

/**
 * 提取可翻译文本字段映射（`字段路径 → 原文`）。
 * 空字符串字段不进入映射（无内容可译，减小 LLM 载荷）。
 */
export function extractTranslatableFields(
  resume: ResumeData
): Record<string, string> {
  const fields: Record<string, string> = {};
  forEachTranslatableField(resume, (key, value) => {
    fields[key] = value;
  });
  return fields;
}

/**
 * 把译文映射合并进简历副本并返回新对象（不修改入参）。
 *
 * 缺失 key 回退原文：LLM 偶发漏字段时部分成功仍可用；fields 中的多余 key
 * 被忽略（服务层已丢弃，这里再兜一层），非文本字段绝不被触碰。
 */
export function applyTranslatedFields(
  resume: ResumeData,
  fields: Record<string, string>
): ResumeData {
  const next = structuredClone(resume);
  forEachTranslatableField(next, (key, _value, set) => {
    const translated = fields[key];
    if (typeof translated === "string" && translated.length > 0) {
      set(translated);
    }
  });
  return next;
}
