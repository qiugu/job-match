/**
 * /edit —— 游客（未登录）简历编辑器。
 *
 * 职责边界（docs/PLAN_guest_access.md §4）：
 * - 挂载期间进入游客模式：编辑器组件完全复用登录态的 WorkbenchPage，
 *   持久化由 useResumeStore 的游客分支切换为 localStorage（零后端请求）；
 * - 有本地草稿 → 恢复；无草稿 → 按可选 ?template= 新建；
 * - 已登录用户访问 /edit 一律重定向回控制台（避免双入口分裂）；
 * - 卸载时退出游客模式并清理草稿的内存副本（localStorage 保留，
 *   由登录后的导入弹窗承接）。
 */

import { useEffect, useRef, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";

import WorkbenchPage from "@/app/app/workbench/[id]/page";
import { GuestBanner } from "@/components/shared/guest/GuestBanner";
import { GuestLoginDialog } from "@/components/shared/guest/GuestLoginDialog";
import { readGuestDraft } from "@/lib/guestDraft";
import { useAuthStore } from "@/store/useAuthStore";
import { useResumeStore } from "@/store/useResumeStore";
import { isGuestModeActive, useGuestMode } from "@/store/useGuestMode";

export const Route = createFileRoute("/edit")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "免费试用简历编辑器 - JDMatch" },
      // 操作型动态页面：内容稀薄且因人而异，索引无意义
      { name: "robots", content: "noindex,nofollow" }
    ]
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    template:
      typeof search.template === "string" && search.template
        ? search.template
        : undefined
  }),
  beforeLoad: async () => {
    const { status, initialize } = useAuthStore.getState();
    if (status === "unknown") {
      await initialize();
    }
    if (useAuthStore.getState().status === "authenticated") {
      throw redirect({ to: "/app/dashboard/resumes" });
    }
  },
  component: GuestEditorRoute
});

function GuestEditorRoute() {
  const { template } = Route.useSearch();
  const [ready, setReady] = useState(false);
  // 初始化只跑一次：search 参数变化不重放（游客编辑器没有切换模板的路由语义）
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const setup = async () => {
      const store = useResumeStore.getState();
      const draft = readGuestDraft();

      if (draft) {
        // 恢复本地草稿：进入内存并视为「已保存」基准（脏标记口径与云端一致）
        const localId = store.addResume(draft.resume);
        useResumeStore.setState((state) => ({
          syncedIds: new Set(state.syncedIds).add(localId),
          savedSnapshots: {
            ...state.savedSnapshots,
            [localId]: JSON.stringify(draft.resume)
          }
        }));
        store.setActiveResume(localId);
        useGuestMode.getState().enter(localId);
      } else {
        // 无草稿：新建（游客分支跳过落库）。createResume 返回临时 id。
        const localId = await store.createResume(template ?? null, false);
        useGuestMode.getState().enter(localId);
      }
      setReady(true);
    };
    void setup();

    return () => {
      // 卸载（离开 /edit）：退出游客模式并清掉草稿内存副本（localStorage
      // 保留，由登录后的导入弹窗承接）。resumeId 在卸载时从 store 读取，
      // 不依赖本 effect 闭包。
      const guest = useGuestMode.getState();
      if (guest.resumeId) {
        useResumeStore.getState().removeLocalResume(guest.resumeId);
      }
      guest.exit();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 刷新/关闭前提示未保存变更（PLAN §4.1，仅游客态）：脏标记走 I2 契约
  // （hasUnsavedChanges = 内存快照 ≠ 保存基准）。防抖窗口内（600ms 未落盘）
  // 同样视为未保存，提示后用户可留页等自动落盘或放弃尾部编辑。
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isGuestModeActive()) return;
      if (!useResumeStore.getState().hasUnsavedChanges()) return;
      e.preventDefault();
      // 现代浏览器忽略自定义文案，returnValue 仅为触发原生确认弹窗
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // 草稿恢复/新建完成前不渲染工作台：activeResume 未就绪时面板会拿空数据
  if (!ready) return null;

  return (
    <>
      <WorkbenchPage />
      <GuestBanner />
      <GuestLoginDialog />
    </>
  );
}
