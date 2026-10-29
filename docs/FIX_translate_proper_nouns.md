# 简历翻译静默漏译：学校名与项目名被「专名保留」规则吞掉

> 触发问题（用户原话）：「简历编辑页面翻译，还存在一些问题：1.项目名称未翻译；2.教育经历的学校名称未翻译。」
>
> 日期：2026-10-29 ｜ 影响范围：`app/services/ai_proxy.py`（翻译 prompt）、`tests/test_ai_translate.py`、`docs/PLAN_resume_translate.md §2.4`

---

## 一、结论（TL;DR）

| # | 事项 | 判定 | 状态 |
| --- | --- | --- | --- |
| 1 | 字段是否未被提取 / 未上传 | **否**。`education.*.school`、`projects.*.name` 一直在字段清单内，实测正常发送 | 无需修改 |
| 2 | prompt 规则 3「专名保留原文」把学校名、产品名列进禁译清单 | **真实缺陷**：与字段清单互相撤销，LLM 优先服从显式禁令 | **已修复** |
| 3 | 服务层只校验 key 与值类型，不检测「译文 == 原文」 | **真实缺陷**：漏译被当作合法译文静默返回 | **已加护栏** |
| 4 | 测试断言 `assert "专名保留原文" in system` | **真实缺陷**：把错误行为固化成必须存在的契约 | **已修正** |

用户报告的两处漏译不是两个独立 bug，而是**同一条 prompt 规则**的两个暴露点。

---

## 二、根因

翻译链路的四段与断点位置：

| 段 | 位置 | 行为 | 判定 |
| --- | --- | --- | --- |
| 1. 字段提取 | `frontend/src/lib/resumeTranslate.ts` | 把 `education.{id}.school`、`projects.{id}.name` 摊进 `key → 原文` 映射并上传 | 正常 |
| 2. 服务层透传 | `app/services/ai_proxy.py::translate_fields` | 原样转发给 LLM，回传时只校验 key 存在 + 值为字符串 | 正常但不设防 |
| 3. **LLM 翻译** | `TRANSLATE_SYSTEM` 规则 3 | 原文：「公司名、**学校名**、**产品名**、机构名保留原文，不意译、不改写」 | **断点** |
| 4. 合并回写 | `frontend/src/lib/resumeTranslate.ts::applyTranslatedFields` | 值等于原文时照常写入（只在空值/非字符串时回退） | 静默放大 |

第 3 段与第 1 段契约冲突：字段层声明「这两个字段可译」，指令层声明「这两类名不许译」。LLM 对显式禁令的服从优先级高于对字段路径的推断，于是原样返回。

**为什么只有这两类字段中招**：规则 3 的禁译清单是「公司名、学校名、产品名、机构名」。`school` 命中「学校名」，`projects.name` 被模型归入「产品名」；而 `major`、`degree`、`position`、`role` 不在清单内，规则 5 又要求「按职场惯例翻译」，因此正常译出。

**为什么此前没有暴露**：该缺陷在翻译方向上不对称。

- 中 → 英：中文校名普遍有通行英文名（清华、复旦、安徽师大均能查），LLM 认为「使用既有译名不算改写」而译出；
- 英 → 中：「保留原文」与「不译专名」的直觉一致，LLM 100% 执行禁令。

同一份 prompt，两个方向的执行严格程度不同，测试又只覆盖了管道语义，所以缺陷长期潜伏。

---

## 三、证据（真实模型实测）

修复前，用 `.venv/bin/python` 直调 `ai_proxy.translate_fields()`，比对「译文 == 原文」（`SAME` 即漏译）：

| 方向 | 字段 | 原文 | 修复前 |
| --- | --- | --- | --- |
| en→zh | `education.a.school` | Fudan University | **SAME** |
| en→zh | `education.b.school` | Anhui Normal University | **SAME** |
| en→zh | `education.c.school` | University of California, Berkeley | **SAME** |
| en→zh | `projects.b.name` | Intelligent Resume Matching Platform | **SAME** |
| en→zh | `education.a.major` | Computer Science | 计算机科学（正常） |
| en→zh | `projects.a.role` | Project Lead | 项目负责人（正常） |
| en→zh | `menuSections.m1.title` | Work Experience | 工作经历（正常） |
| zh→en | `education.d.school` | 清华大学 | Tsinghua University（误导性的「正常」） |

最后一行为关键反证：同一字段在中→英方向能译，说明**不是字段没上传，也不是模型能力不足**，而是指令在该方向被绕过。

---

## 四、修复

### 4.1 重写 prompt 规则（`app/services/ai_proxy.py::TRANSLATE_SYSTEM`）

把原先「专名保留原文」一条规则拆成三档，并新增一条针对学校名/项目名的硬性要求：

| 档位 | 覆盖字段 | 规则要点 |
| --- | --- | --- |
| 必须本地化 | `education.*.school`、`projects.*.name` | 存在通行名称必须译出；项目名只译语义部分；**纯代号/缩写（`JDMatch`、`JD-Match`、`V2X`）例外，保留原文** |
| 按职场惯例本地化 | `position`、`major`、`degree`、`role` | 不逐字硬译（「学士」→ `Bachelor's`） |
| 保留原文 | 公司名、人名、技术/产品代号、日期/URL/邮箱 | 不意译、不改写 |

其中「纯代号例外」是有意保留的：`JDMatch` 这类名称硬造中文译名会损伤简历可信度，且模型也无法可靠区分代号与语义名，因此给出明确边界而不是让模型自行判断。

### 4.2 增加服务层护栏（`_warn_if_group_unchanged`）

「保留原文」与「未翻译」在输出上完全同形，服务层无法逐字段判定。因此采用分组统计：按字段路径首段（`education` / `projects` / `experience` ...）分组，某组**全部**「译文 == 原文」且样本 ≥ 2 时记 warning。

- 只记分组名与计数，**不记简历正文**（日志会落盘，避免隐私外泄）；
- 阈值取「整组全未变化」而非单字段：单字段不变属正常现象（纯代号项目名、与目标语言同形的公司名），整组全不变才说明该类字段的策略失效；
- 空值不参与统计（整组空串无语义，避免误报）；组名取自前端提交的字段路径，打印前清洗非字母数字字符，防止换行注入伪造日志行；
- 不改变 API 响应契约，前端无需改动。

### 4.3 修正固化缺陷的测试

`tests/test_ai_translate.py` 原有一行 `assert "专名保留原文" in system`，把缺陷写成了「删掉就会失败」的契约。已替换为 `test_translate_system_prompt_localizes_school_and_project_names`，断言新策略在位、旧措辞消失。新增 4 例（prompt 策略 1 例、护栏 3 例），共 17 例。

### 4.4 文档同步

`docs/PLAN_resume_translate.md §2.4` 的专名约定整节重写为三档策略表（原写作「学校名、产品名保留原文」，是本次缺陷的源头文档）。若只改代码不改文档，下一次按文档实现的人会再次引入同一缺陷。

---

## 五、验证

单测：`tests/test_ai_translate.py` **17 passed**；后端全量 **254 passed**；前端全量 **227 passed**（28 文件，含 `tests/resume-translate-fields.test.ts` 9 例）。

真实模型复验（修复后，en→zh）：

| 字段 | 原文 | 修复后 |
| --- | --- | --- |
| `education.a.school` | Fudan University | 复旦大学 |
| `education.b.school` | Anhui Normal University | 安徽师范大学 |
| `education.c.school` | University of California, Berkeley | 加州大学伯克利分校 |
| `projects.a.name` | JDMatch Resume Matcher | JDMatch 简历匹配器 |
| `projects.b.name` | Intelligent Resume Matching Platform | 智能简历匹配平台 |
| `projects.c.name` | JD-Match | JD-Match（纯代号，按规则保留） |
| `experience.a.company` | ByteDance | ByteDance（公司名，按裁决保留） |

中 → 英方向回归复验：学校名、项目名、职位、描述全部正常译出，`JDMatch` 仍保留原文，无行为回退。

---

## 六、后续如何避免同类问题

1. **字段清单与翻译策略必须同源**。当前仍是「前端列举字段 + 后端 prompt 写策略」两处手写，靠人同步。新增可译字段时，必须同步确认 §2.4 的策略档位并更新 prompt，否则会重现本次「上了清单但整类被吞」的静默缺陷。
2. **翻译类改动必须双向测**。zh→en 与 en→zh 各一份样本，逐字段比对 `SAME / DIFF / MISS` 三态。单方向通过不构成证据——本次缺陷正是单方向「看起来正常」。
3. **依赖护栏而不是肉眼**。`_warn_if_group_unchanged` 会在整类字段漏译时留下日志线索，可作为线上巡检项（日志关键字：`简历翻译疑似未生效`）。
4. **测试不得为缺陷背书**。写 `assert "某规则" in prompt` 这类断言时，先确认该规则本身是产品意图而非历史遗留；断言对象应是**期望行为**（学校名必须本地化），而不是**实现字面量**。
