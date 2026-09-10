import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import WorkbenchPage from "@/app/app/workbench/[id]/page";
import { useResumeStore } from "@/store/useResumeStore";
import { getMasterResume } from "@/lib/jobmatch";

// noindex 统一由父布局路由 /app（routes/app/route.tsx）声明，此处不再重复。
export const Route = createFileRoute("/app/workbench/$id")({
  ssr: false,
  component: WorkbenchRoutePage
});

function WorkbenchRoutePage() {
  const { id } = Route.useParams();
  const setActiveResume = useResumeStore((state) => state.setActiveResume);
  const resumes = useResumeStore((state) => state.resumes);

  useEffect(() => {
    // 已是内存中的简历（新建/导入草稿或已加载的）直接激活
    if (resumes[id]) {
      setActiveResume(id);
      return;
    }
    // 内存中没有该简历：尝试从后端拉取。覆盖两类场景：
    // 1) 刷新后内存丢失、但已落库的后端 id（接受匹配落库、或列表页加载过的 id）；
    // 2) 跨页跳转进入（如「立即编辑」——匹配接受后端已建 MasterResume，但前端内存无此 id，
    //    也不能依赖 syncedIds，因为它由前端 save/load 流程写入，后端直接落库的记录不在其中）。
    // 直接尝试拉取；若后端 404（临时草稿 id）再回退为空白/新建态。
    (async () => {
      try {
        const detail = await getMasterResume(id);
        useResumeStore.setState((state) => ({
          resumes: { ...state.resumes, [id]: detail.resumeJson },
          syncedIds: state.syncedIds.add(id),
        }));
        setActiveResume(id);
      } catch (err) {
        // 后端无此记录（临时草稿 id 刷新丢失）：激活空态供用户编辑
        console.warn("后端无此简历，进入空白编辑态:", id, err);
        setActiveResume(id);
      }
    })();
  }, [id, setActiveResume, resumes]);

  return <WorkbenchPage />;
}
