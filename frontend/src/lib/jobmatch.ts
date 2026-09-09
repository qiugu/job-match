// 简历匹配 Agent 后端 API 客户端。
// 后端为独立 Python(FastAPI) 服务，地址通过 VITE_JOBMATCH_API 配置，默认本地 8005。
// 所有接口都要求登录：请求统一携带 Bearer 令牌，401 时跳登录页。
import { ResumeData } from "@/types/resume";
import { API_BASE } from "./apiBase";
import { authHeaders, handleUnauthorized } from "./auth";

export { API_BASE };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401) {
    handleUnauthorized();
  }
  if (!res.ok) {
    let detail = `请求失败 (${res.status})`;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      /* ignore */
    }
    const error = new Error(detail) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return res.json() as Promise<T>;
}

// ---------- 简历（用户上传/保存的简历，作为匹配来源） ----------
export interface MasterResumeSummary {
  id: string;
  title: string;
  /** 简历正文：PDF 解析原文；编辑器保存的记录回退为 markdown 内容 */
  rawText: string;
  markdownContent: string | null;
  /** 导入 PDF 时由后端从版式元数据反推，使字体大小/间距贴合原文件 */
  globalSettings?: Record<string, any> | null;
  templateId?: string | null;
  /** 来源：pdf=上传的 PDF 解析；editor=编辑器保存 */
  source: "pdf" | "editor";
  createdAt: string;
  updatedAt: string;
}

export interface MasterResumeDetail extends MasterResumeSummary {
  rawText: string;
  resumeJson: ResumeData;
  updatedAt: string;
}

export interface CreateMasterResumeResult {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** 上传简历 PDF。标题（文件名）重复时后端返回 409，错误对象带 status */
export async function uploadMasterResume(file: File): Promise<MasterResumeSummary> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/api/master-resumes`, {
    method: "POST",
    body: form,
    headers: authHeaders(),
  });
  if (res.status === 401) {
    handleUnauthorized();
  }
  if (!res.ok) {
    let detail = `上传失败 (${res.status})`;
    try {
      detail = (await res.json()).detail || detail;
    } catch {
      /* ignore */
    }
    const error = new Error(detail) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return res.json();
}

export async function listMasterResumes(): Promise<MasterResumeSummary[]> {
  return request("/api/master-resumes");
}

/** 删除一份简历（后端按 id 删除；衍生简历不引用主简历，可安全删除） */
export async function deleteMasterResume(id: string): Promise<{ id: string }> {
  return request(`/api/master-resumes/${id}`, { method: "DELETE" });
}

export async function getMasterResume(id: string): Promise<MasterResumeDetail> {
  return request(`/api/master-resumes/${id}`);
}

export async function updateMasterResume(
  data: ResumeData,
  backendId?: string
): Promise<{ id: string }> {
  // PUT 目标 id 必须为真实后端记录 id：resume_json 内嵌的 id 可能为空（历史脏数据）
  // 或前端临时 uuid，应以 store 中的真实后端 id（backendId）为准。
  const targetId = backendId ?? data.id;
  return request(`/api/master-resumes/${targetId}`, {
    method: "PUT",
    body: JSON.stringify({ ...data, id: targetId }),
  });
}

/** 以结构化 JSON 创建简历（无需 PDF），返回后端生成的记录 id */
export async function createMasterResumeJson(
  data: ResumeData
): Promise<CreateMasterResumeResult> {
  return request("/api/master-resumes/json", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/**
 * 保存简历到后端数据库。简历 id 恒等于后端 master_resumes 记录 id：
 * - 已是后端 id -> PUT 更新；
 * - 仍是前端临时 id（后端无此记录，PUT 返回 404）-> 回退 POST 创建，返回新的后端 id。
 * 调用方（store.syncResumeToBackend）拿到返回 id 后会把临时 id 替换为后端 id。
 */
export async function saveResumeToBackend(
  data: ResumeData
): Promise<{ id: string }> {
  try {
    const updated = await request<{ id: string }>(
      `/api/master-resumes/${data.id}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      }
    );
    return { id: updated.id };
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    const isNotFound = status === 404;
    if (!isNotFound) throw err;
    // 临时 id 在后端不存在 -> 创建新记录
    const created = await createMasterResumeJson(data);
    return { id: created.id };
  }
}

// ---------- 衍生简历（匹配结果） ----------
export interface DerivedResumeSummary {
  id: string;
  title: string;
  createdAt: string;
}

/**
 * 匹配项：字段名与后端 `app/schemas/agent.py` 的 MatchItem 严格对齐。
 * 后端产出的是 requirement / evidence / strength / suggestion，
 * 早期前端误用 name / status / detail，导致匹配项全部读不到而显示成「缺失」。
 */
export interface MatchRequirement {
  requirement: string;
  evidence: string;
  strength: "matched" | "weak" | "missing" | "unspported";
  suggestion?: string | null;
}

/**
 * 匹配分析：字段与后端 `app/schemas/agent.py` 的 MatchResult 严格对齐。
 *
 * 注意字段名是 snake_case：该对象由 `match_results.model_dump(exclude_none=True)`
 * 直接序列化（agent.py run_match），未走其他字段那样的手工 camelCase 映射。
 * 且 exclude_none=True 意味着值为 None 的字段不会出现在响应里，故全部可选。
 *
 * 话术（cover letter）已解耦为独立资源，不再内嵌在匹配分析里，
 * 由 `/api/cover-letters` 单独生成与存储（见下方 CoverLetter 类型）。
 */
export interface MatchAnalysis {
  role?: string;
  /** 匹配得分：后端约定为 0~1 的浮点数（0.595 表示 59.5%），展示时需要 ×100 */
  score?: number;
  requirements?: MatchRequirement[];
  summary?: string;
}

export interface MatchResult {
  id: string;
  title: string;
  keywords: string[];
  /** Agent 产出的匹配后简历，markdown 文本 */
  markdownContent: string;
  /** 匹配分析（岗位角色、得分、匹配项、总结），由后端 resume_match 节点产出 */
  matchAnalysis?: MatchAnalysis | null;
  /** 用户是否已确认接受该匹配结果 */
  accepted: boolean;
  /** 本次匹配后剩余的匹配次数（-1 表示无限制），失败时不存在 */
  remainingQuota?: number;
  /** 归属岗位卡 id（写链路自动挂载；未命中历史/未开启时为 null） */
  jobId: string | null;
  createdAt: string;
}

export interface CreateMatchPayload {
  /** 匹配基准简历文本（从已上传简历中选取的 markdown 文本） */
  resumeText: string;
  jdText: string;
  title?: string;
}

// ---------- 话术（JD 话术，与匹配解耦的独立资源） ----------
/** 话术场景：打招呼 / 跟进 / 邀约，与后端 COVER_LETTER_SCENES 取值一致 */
export type CoverLetterScene = "greeting" | "followup" | "interview";

/**
 * 话术资源：字段与后端 `app/schemas/agent.py` 的 CoverLetterResult 对齐。
 * 话术由 `/api/cover-letters` 独立生成、存储，不依赖匹配结果。
 */
export interface CoverLetter {
  id: string;
  content: string;
  scene: CoverLetterScene;
  /** 生成所用模型（审计用），可能为 null */
  model: string | null;
  /** 关联的衍生简历（匹配结果）id，可能为空 */
  derived_resume_id: string | null;
  /** 生成时快照的简历文本，可能为空 */
  resume_text: string | null;
  /** 生成时快照的岗位描述，可能为空 */
  jd_text: string | null;
  /** 归属岗位卡 id（写链路自动挂载；未命中历史/未开启时为 null） */
  job_id: string | null;
  created_at: string;
  updated_at: string;
  /** 本次生成/重生成后剩余匹配额度（-1=无限制）；非消耗型操作不返回 */
  remaining_quota?: number | null;
}

export interface CreateCoverLetterPayload {
  resume_text: string;
  jd_text: string;
  scene?: CoverLetterScene;
  /** 关联衍生简历（匹配结果）id，可选；传入时须为本人的记录 */
  derived_resume_id?: string;
}

export interface RegenerateCoverLetterPayload {
  scene?: CoverLetterScene;
}

export async function createCoverLetter(
  payload: CreateCoverLetterPayload
): Promise<CoverLetter> {
  return request("/api/cover-letters", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function listCoverLetters(
  derivedResumeId?: string,
  jobId?: string
): Promise<CoverLetter[]> {
  const params = new URLSearchParams();
  if (derivedResumeId) params.set("derived_resume_id", derivedResumeId);
  if (jobId) params.set("job_id", jobId);
  const qs = params.toString();
  return request(`/api/cover-letters${qs ? `?${qs}` : ""}`);
}

export async function getCoverLetter(id: string): Promise<CoverLetter> {
  return request(`/api/cover-letters/${id}`);
}

export async function updateCoverLetter(
  id: string,
  patch: { content: string }
): Promise<CoverLetter> {
  return request(`/api/cover-letters/${id}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function deleteCoverLetter(
  id: string
): Promise<{ id: string; deleted: boolean }> {
  return request(`/api/cover-letters/${id}`, { method: "DELETE" });
}

export async function regenerateCoverLetter(
  id: string,
  payload?: RegenerateCoverLetterPayload
): Promise<CoverLetter> {
  return request(`/api/cover-letters/${id}/regenerate`, {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export async function createMatch(payload: CreateMatchPayload): Promise<MatchResult> {
  return request("/api/derived-resumes", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function listDerivedResumes(): Promise<DerivedResumeSummary[]> {
  return request("/api/derived-resumes");
}

export async function getDerivedResume(id: string): Promise<MatchResult> {
  return request(`/api/derived-resumes/${id}`);
}

export async function updateDerivedResume(
  id: string,
  patch: { markdownContent?: string; title?: string }
): Promise<{ id: string }> {
  return request(`/api/derived-resumes/${id}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/** 确认接受匹配结果（接受即落库为我的简历，返回落库的 master resume id） */
export async function acceptMatch(
  id: string,
  accepted = true
): Promise<{
  id: string;
  accepted: boolean;
  masterResumeId: string | null;
  deduped: boolean;
}> {
  return request(`/api/derived-resumes/${id}/accept`, {
    method: "POST",
    body: JSON.stringify({ accepted }),
  });
}

// ---------- 岗位卡（Job Tracking：以 JD 为中心的机会管理） ----------
/** 岗位状态枚举（V2 4 态），与后端 app/models/job.py::JOB_STATUSES 严格对齐 */
export type JobStatus = "greeting_sent" | "resume_ready" | "applied" | "closed";

/** 岗位卡下的话术子记录（详情内嵌） */
export interface JobCoverLetterBrief {
  id: string;
  scene: CoverLetterScene;
  content: string;
  created_at: string;
}

/** 岗位卡下的定制简历子记录（详情内嵌，含匹配分析回看） */
export interface JobDerivedResumeBrief {
  id: string;
  title: string;
  accepted: boolean;
  /** 匹配分析（MatchResult 结构）；V2 前历史记录为 None */
  analysis: MatchAnalysis | null;
  markdown_content: string;
  created_at: string;
}

/**
 * 岗位摘要：字段与后端 `app/schemas/job.py::JobSummary` 对齐。
 * 列表与详情结构一致（jd_text 全量返回，供「恢复 JD 上下文」直接使用）。
 */
export interface JobSummary {
  id: string;
  user_id: string;
  title: string;
  company: string;
  status: JobStatus;
  /** 归一化后的 JD 全文（前端「恢复 JD 上下文」直接回填此字段） */
  jd_text: string;
  created_at: string;
  updated_at: string;
  /** 聚合字段（列表一次返回，避免 N+1） */
  cover_letter_count: number;
  derived_count: number;
  /** 该卡子记录最大 created_at，无则取 jobs.updated_at */
  last_activity_at: string | null;
  /** 是否有已接受的衍生简历（前端决定徽章展示） */
  latest_acceptance: boolean;
}

/** 岗位详情：摘要 + 内嵌子记录（话术 / 定制简历含匹配分析），供详情区一次渲染 */
export interface JobDetail extends JobSummary {
  cover_letters: JobCoverLetterBrief[];
  derived_resumes: JobDerivedResumeBrief[];
}

/** 岗位更新：PATCH 仅允许元数据（title/company）；状态经 mark/reopen 语义端点 */
export interface JobUpdate {
  title?: string;
  company?: string;
}

/** 手动确认投递结果：applied=投递成功（须先有定制简历）；closed=失败/放弃归档 */
export type JobMarkOutcome = "applied" | "closed";

export interface JobDetectResult {
  job_id: string | null;
}

/**
 * 活跃岗位列表（归档 closed 不出现），按最近活跃 desc。
 * includeClosed=true 时额外返回已归档卡（置于列表后，供「重新开启」入口）。
 */
export async function listJobs(includeClosed = false): Promise<JobSummary[]> {
  const qs = includeClosed ? "?include_closed=true" : "";
  return request(`/api/jobs${qs}`);
}

export async function getJob(id: string): Promise<JobDetail> {
  return request(`/api/jobs/${id}`);
}

export async function updateJob(id: string, patch: JobUpdate): Promise<JobDetail> {
  return request(`/api/jobs/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** 手动确认投递结果（V2 仅剩的两个手动状态写入）；返回更新后的岗位摘要 */
export async function markJob(
  id: string,
  outcome: JobMarkOutcome
): Promise<JobSummary> {
  return request(`/api/jobs/${id}/mark`, {
    method: "POST",
    body: JSON.stringify({ outcome }),
  });
}

/** 重新开启已结束的岗位（按有无定制简历回 resume_ready / greeting_sent） */
export async function reopenJob(id: string): Promise<JobSummary> {
  return request(`/api/jobs/${id}/reopen`, { method: "POST" });
}

/**
 * 删除岗位卡。
 * - purge 缺省/ false：仅删卡片，子记录 job_id 置空转「未归类」，话术/匹配资产保留；
 * - purge=true：级联删除该卡下全部话术与匹配记录（已接受简历在「我的简历」的副本不受影响）。
 */
export async function deleteJob(
  id: string,
  purge = false
): Promise<{ id: string; purged: boolean; deleted: boolean }> {
  const qs = purge ? "?purge=true" : "";
  return request(`/api/jobs/${id}${qs}`, { method: "DELETE" });
}

/** 按归一化 jd_text 查重：命中返回 job_id，未命中返回 null */
export async function detectJob(jdText: string): Promise<JobDetectResult> {
  return request("/api/jobs/detect", {
    method: "POST",
    body: JSON.stringify({ jd_text: jdText }),
  });
}
