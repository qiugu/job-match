# 计划：「我的简历」与「优化简历」列表统一以后端为准

## 背景与根因（已确认）

两个列表来自两套**互不同步**的数据源，导致不一致：

- 「我的简历」页 (`/dashboard/resumes`) 展示 `useResumeStore.resumes`，即 **localStorage 持久化的结构化 `ResumeData`**（新建/导入只写本地）。
- 「优化简历」匹配页下拉调用 `listMasterResumes()` → `GET /api/master-resumes`，即 **后端 `master_resumes` 表**。后端记录只在 PDF 上传、或编辑器显式「保存」时产生。

证据：
- `ResumeWorkbench.tsx:132,166` 新建/导入仅 `addResume`（写 localStorage，无后端调用）。
- `useResumeStore` 用 `persist` middleware 把 `resumes` 写入 localStorage。
- 匹配页下拉经 `jobmatch.listMasterResumes()` 只读后端，与 localStorage 无关联。

## 目标（用户已逐项确认）

1. **取消 localStorage 持久化**：store 保留为内存工作副本（编辑器实时编辑/撤销仍需），刷新后从后端重载。
2. **「我的简历」页也读后端** `GET /api/master-resumes`，与匹配下拉同一份数据 → 两列表天然一致。
3. **新建简历**：仅存内存 store（临时 id），首次保存/实质编辑才 POST 后端，拿到后端 id 后**替换** `resume.id` 与内存 key，之后统一以该后端 id 为准（q-4）。**不存在 `masterResumeId` 概念**——简历 id 恒等于后端 `master_resumes.id`。
4. **进入匹配页**：批量补同步内存 store 中仍为「临时 id」（即尚未写后端）的历史简历到后端，POST 后同样替换为后端 id（q-1）。
5. **取消本地目录文件同步** `useResumeDirectorySync`/`resumeFileSync`，注释说明（q-5）。
6. 删除：两页统一调用后端 `DELETE /api/master-resumes/{id}`。

## 后端现状评估（无需改动，已具备能力）

- `GET /api/master-resumes` 已按 content_hash 去重、跳过空记录、返回 `id/title/rawText/markdownContent/source/createdAt/updatedAt`。
- `POST /api/master-resumes/json` 写入并去重，返回 `id/title/updatedAt/deduped`。
- `PUT /api/master-resumes/{id}` 接受 `ResumeData`（含 `markdownContent`）、重算 hash。
- `GET /api/master-resumes/{id}` 返回 `resumeJson`(结构化) + `markdownContent`，供编辑器加载。
- `DELETE /api/master-resumes/{id}` 已存在。

结论：**后端零改动**，全部工作在前端。

## 前端改动清单

### 1. `frontend/src/store/useResumeStore.ts` — 去持久化 + 后端对齐
- 移除 `persist` middleware（含 `name: "magic-resume-resumes"`、partialize、onRehydrateStorage、storage `createJSONStorage(() => localStorage)`）。store 变为纯内存。
- 保留 `resumes: Record<string, ResumeData>` 作为内存缓存，key = 简历 `id`（临时 uuid 或后端 id，二者统一为同一字段）。
- **`ResumeData` 类型移除 `masterResumeId` 字段**（types/resume.ts）。workbench 路由、$id、deleteResume 等统一用 `resume.id` 作为后端 id。
- `createResume`（line 967）：仅写内存，临时 `id = uuid()`，**不**写后端（符合 q-4）。返回新 id。
- 新增 `syncResumeToBackend(id)`：对内存 `resumes[id]`，调用 `saveResumeToBackend(resume)`（jobmatch.ts）；首次（临时 id）走 `createMasterResumeJson` 拿后端 id，随后把 `resume.id` 改为后端 id、迁移缓存 key（删除临时 key、写入后端 id key）。
- `saveActiveResumeToBackend`（line 989）：改用 `syncResumeToBackend(activeResumeId)`，并把返回的后端 id 写回 `resume.id`。
- `deleteResume`（line 515）：改为异步、调用 `jobmatch.deleteMasterResume(resume.id)`，成功后再从内存 `resumes` 移除并清 active。
- `loadResumesFromBackend()`：新增，调用 `listMasterResumes()`，对每条 summary 调用 `getMasterResume(id)` 取结构化 `resumeJson`，以 `id` 为 key 填充内存 `resumes`（保留 `markdownContent`）。供「我的简历」页与刷新后初始化使用。
- 移除 `syncResumeToFile`/`debouncedSyncToFile`/`clearPendingSync`/`_isMounted`/`_pendingSyncId` 等与文件同步相关的方法（q-5），改注释说明。

### 2. `frontend/src/app/app/dashboard/resumes/page.tsx` — 读后端
- 页面 mount 时调用 `loadResumesFromBackend()` 填充内存 store；用 store 渲染（保持现有卡片/预览 UI 不变，因为此时内存已含结构化数据）。
- 移除 `useResumeDirectorySync()` 调用（q-5），加注释说明取消本地目录同步。
- 删除走 `deleteResume`（已是后端）。

### 3. `frontend/src/components/editor/MarkdownWorkbench.tsx` — 同步调用
- `saveResumeToBackend` 调用改为经 store 的 `syncResumeToBackend(activeResumeId)`（确保 id 回填），其余不变。

### 4. `frontend/src/app/app/dashboard/match/page.tsx` — 补同步历史
- mount `useEffect`：先遍历内存 `resumes`，对仍为「临时 id」（非后端 id）的逐个 `syncResumeToBackend`（POST 后替换为后端 id），再 `listMasterResumes()` 刷新下拉，保证历史简历出现在下拉并去重。
- 其余下拉逻辑（`loadMasterResume`、`handleUploadResume`、`deleteMasterResume`）不变。

### 5. `frontend/src/routes/app/workbench/$id.tsx` — 加载后端数据
- `id` 即后端简历 id（来自后端列表）或新建的临时 id。
- 进入 workbench 时：若 `resumes[id]` 不存在（刷新后内存丢失，且 `id` 为后端 id），则 `getMasterResume(id)` 从后端拉取结构化数据并写入内存 + `setActiveResume`。保证刷新后能继续编辑已保存的后端简历；临时 id 刷新后自然丢失（符合 q-4）。

### 6. `frontend/src/hooks/useResumeDirectorySync.ts` 与 `frontend/src/utils/resumeFileSync.ts`
- 在调用处（`ResumeWorkbench`/`resumes page`）注释掉使用，并保留文件但顶部加注释「本地目录同步已取消（2026-08-29）：简历统一以后端 master_resumes 为准」。不在其它处调用即可。

## 验证

1. `pnpm -C frontend lint` 与 `tsc --noEmit` 通过。
2. 手动：新建简历 → 不刷新时编辑正常；点保存 → 后端出现该记录（id 替换为后端 id）；刷新页面 → 「我的简历」与匹配下拉均出现该简历。
3. 历史内存简历（首次进入匹配页）自动补同步到后端去重。
4. 删除在「我的简历」与匹配下拉均同步消失。
5. 确认本地目录文件（Downloads/简历）不再影响列表。

## 风险与回滚

- 移除 persist 后，未保存的新建草稿刷新即丢失（符合 q-4 预期）。
- 若后端不可达，列表为空、编辑仍可内存进行；保存时提示错误。可接受。
- 回滚：git revert 本次改动即可恢复 localStorage 行为。
