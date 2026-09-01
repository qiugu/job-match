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
 * 直接序列化（agent.py run_match），未走其他字段那样的手工 camelCase 映射，
 * 因此这里是 cover_letter，而不是 coverLetter。
 * 且 exclude_none=True 意味着值为 None 的字段不会出现在响应里，故全部可选。
 */
export interface MatchAnalysis {
  role?: string;
  /** 匹配得分：后端约定为 0~1 的浮点数（0.595 表示 59.5%），展示时需要 ×100 */
  score?: number;
  requirements?: MatchRequirement[];
  /**
   * resume_match 节点输出的打招呼话术。
   * 与顶层 coverLetter 同源：后者直接复用本字段（withCoverLetter=true 时随响应返回），
   * 不再由 generate_cover_letter 节点单独生成，两者内容一致。
   */
  cover_letter?: string;
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
  createdAt: string;
}

export interface CreateMatchPayload {
  /** 匹配基准简历文本（从已上传简历中选取的 markdown 文本） */
  resumeText: string;
  jdText: string;
  title?: string;
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
