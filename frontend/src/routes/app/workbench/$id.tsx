import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import WorkbenchPage from "@/app/app/workbench/[id]/page";
import { useResumeStore } from "@/store/useResumeStore";
import { getMasterResume } from "@/lib/jobmatch";

export const Route = createFileRoute("/app/workbench/$id")({
  head: () => ({
    meta: [{ name: "robots", content: "noindex,nofollow" }]
  }),
  ssr: false,
  component: WorkbenchRoutePage
});

function WorkbenchRoutePage() {
  const { id } = Route.useParams();
  const setActiveResume = useResumeStore((state) => state.setActiveResume);
  const resumes = useResumeStore((state) => state.resumes);
  const syncedIds = useResumeStore((state) => state.syncedIds);

  useEffect(() => {
    // 已是内存中的简历（新建/导入草稿或已加载的）直接激活
    if (resumes[id]) {
      setActiveResume(id);
      return;
    }
    // 刷新后内存丢失：若该 id 是已落库的后端 id，则从后端拉取结构化数据再激活
    if (syncedIds.has(id)) {
      (async () => {
        try {
          const detail = await getMasterResume(id);
          useResumeStore.setState((state) => ({
            resumes: { ...state.resumes, [id]: detail.resumeJson },
          }));
          setActiveResume(id);
        } catch (err) {
          console.error("从后端加载简历失败:", id, err);
        }
      })();
      return;
    }
    // 既不在内存、也未落库（临时 id 刷新丢失）-> 仅激活（编辑器将为空/新建态）
    setActiveResume(id);
  }, [id, setActiveResume, resumes, syncedIds]);

  return <WorkbenchPage />;
}
