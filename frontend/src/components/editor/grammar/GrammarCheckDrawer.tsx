
import { useGrammarCheck } from "@/hooks/useGrammarCheck";
import { useResumeStore } from "@/store/useResumeStore";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet-no-overlay";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, ArrowRight, Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTranslations } from "@/i18n/compat/client";

export function GrammarCheckDrawer() {
  const t = useTranslations("grammarCheck");
  const {
    errors,
    isChecking,
    hasChecked,
    checkGrammar,
    clearErrors,
    selectError,
    selectedErrorIndex,
    dismissError,
    remarkErrors,
  } = useGrammarCheck();

  const { activeResume, updateResume } = useResumeStore();

  const [isOpen, setIsOpen] = useState(false);

  // 打开抽屉的唯一来源是「用户点了校对入口」：runCheck 内部会先 setIsOpen(true)。
  // 旧版额外用 `errors.length > 0` 的 effect 兜底自动打开，但 errors 只能由
  // checkGrammar 产生、而 checkGrammar 只被 runCheck 调用，因此该 effect 既冗余，
  // 又会在用户主动关闭抽屉（ESC / 点击外部）后把它强行弹回来。已移除。

  // 点击「校对」→ 打开抽屉并立即对预览正文发起 AI 校对。
  // 此前只有展示逻辑、无人调用 checkGrammar（69f3036 删除浮动按钮时断链），
  // 导致抽屉永远显示空态「太棒了」，用户以为检查过其实从未请求过 AI。
  const runCheck = useCallback(async () => {
    clearErrors();
    // I3：拼合所有分页的可见正文，避免旧实现只读第一页（#resume-preview）
    // 导致 2 页简历的后半段等于没有校对。
    const roots = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".md-page-sheet .resume-markdown-preview"
      )
    );
    const text = (
      roots.length
        ? roots.map((root) => root.innerText).join("\n")
        : activeResume?.markdownContent || ""
    ).trim();
    if (!text) {
      toast.error(t("check_failed_desc"));
      return;
    }
    try {
      await checkGrammar(text);
    } catch {
      // checkGrammar 内部已置 hasChecked=false 并 toast，这里吞掉避免 unhandledrejection
    }
  }, [activeResume, checkGrammar, clearErrors, t]);

  useEffect(() => {
    const handleOpenDrawer = () => {
      setIsOpen(true);
      void runCheck();
    };
    document.addEventListener("open-grammar-drawer", handleOpenDrawer);
    return () => {
      document.removeEventListener("open-grammar-drawer", handleOpenDrawer);
    };
  }, [runCheck]);

  // I3：预览每次 markdown 变化都会重建 DOM（dangerouslySetInnerHTML），
  // 旧的 mark 会被整体抹掉。预览提交后广播该事件，这里把高亮重新套回所有分页，
  // 避免「敲一个字 → 波浪线全消失、抽屉里错误仍在」的割裂。
  useEffect(() => {
    const onPreviewUpdated = () => remarkErrors();
    window.addEventListener("resume-preview-updated", onPreviewUpdated);
    return () =>
      window.removeEventListener("resume-preview-updated", onPreviewUpdated);
  }, [remarkErrors]);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
  };

  const handleAccept = (index: number) => {
    const error = errors[index];
    if (!error || !activeResume) return;

    // I3：直接改 Markdown 单一真源（markdownContent）里的目标片段，
    // 而不是对整份简历对象递归替换 innerText。后者既可能误改标题等无关字段，
    // 又因为 context 来自渲染后文本、与 markdown 标记不一致而匹配率不稳定。
    const source = activeResume.markdownContent ?? "";
    const target = error.text;
    const suggestion = error.suggestion ?? "";
    if (!target) {
      toast.error(t("apply_error"));
      return;
    }

    let nextSource = source;
    if (
      error.context &&
      error.context.includes(target) &&
      source.includes(error.context)
    ) {
      // 有上下文时优先整段定位，把替换范围限制在 context 内。
      nextSource = source.replace(
        error.context,
        error.context.replace(target, suggestion)
      );
    } else if (source.includes(target)) {
      // 退化：仅在 markdown 源码中替换首个命中的目标片段。
      nextSource = source.replace(target, suggestion);
    }

    if (nextSource === source) {
      toast.error(t("apply_error"));
      return;
    }

    updateResume(activeResume.id, { markdownContent: nextSource });
    dismissError(index);
    toast.success(t("applied_success"));
  };

  const handleIgnore = (index: number) => {
    dismissError(index);
  };

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange} modal={false}>
      {/*
        遮挡问题的两个根因（此前「校对弹框被排版设置遮挡」的观感来源）：
        1. 背景曾是「muted 色 30% 不透明度」——底下的排版设置面板
           （滑块、色板）会整片透出来，看起来就像被外层面板压住。
           改为不透明的 paper-2，抽屉自成一层。
        2. z-index 只有 50，与 PreviewDock 的 z-[50] 同级；同层时按 DOM 顺序
           决定堆叠，浮动的 Dock 会压在抽屉边缘上。抬到 z-[70]。
        另：`sm:max-w-sm`(384px) 是 cva 内置上限，会静默吃掉 w-[450px]，
        这里显式给出 max-w 上限，宽度才真的生效。
      */}
      <SheetContent
        side="left"
        className={cn(
          "z-[70] flex w-[400px] flex-col gap-0 p-0 sm:w-[450px] sm:max-w-[450px]",
          // 顶部让出 64px 的 EditorHeader：抽屉是非模态检查器，
          // 打开期间「保存 / 导出」仍应可点。
          // 底色用 paper-2（下沉控件区），错误卡片用 card（上浮），两者才分得开；
          // 若抽屉与卡片同为 card，卡片边界会糊成一片。
          "top-16 h-auto border-r border-line bg-paper-2"
        )}
      >
        <div className="sticky top-0 z-10 border-b border-line bg-card p-6 pb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Check className="w-5 h-5 text-primary" />
              </div>
              <div>
                <SheetTitle className="text-lg font-semibold">{t("title")}</SheetTitle>
                <SheetDescription className="text-xs">
                  {t("description", { count: errors.length })}
                </SheetDescription>
              </div>
            </div>
            <Button 
                variant="ghost" 
                size="icon" 
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={() => {
                    clearErrors();
                    setIsOpen(false);
                }}
            >
                <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <ScrollArea className="flex-1 px-6 py-6 h-full">
            <div className="space-y-6 pb-20">
              <AnimatePresence mode="popLayout">
                {errors.map((error, index) => (
                  <motion.div
                    key={`${error.text}-${index}`}
                    layout
                    initial={{ opacity: 0, y: 20, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
                    className={cn(
                      "group relative bg-card rounded-xl border border-border/50 transition-all duration-300 overflow-hidden",
                      "hover:border-primary/20",
                      selectedErrorIndex === index && "border-primary bg-primary/5"
                    )}
                    onClick={() => selectError(index)}
                  >
                    {/* 卡片头部 */}
                    <div className="px-4 py-3 border-b border-border/50 flex justify-between items-center bg-muted/20 rounded-t-xl">
                        <Badge 
                            variant="secondary" 
                            className={cn(
                                "text-[10px] px-2 py-0.5 h-5 font-normal tracking-wide",
                                error.type === "spelling" 
                                    ? "bg-butter text-amber-ink" 
                                    : "bg-mint text-green-ink"
                            )}
                        >
                            {error.type === "spelling" ? t("spelling") : t("punctuation")}
                        </Badge>
                        {/* 只有当 reason 与 Badge 内容不同时才显示 */}
                        {error.reason && error.reason !== "错别字" && error.reason !== "标点符号" && (
                            <span className="text-[10px] text-muted-foreground/70 italic max-w-[180px] truncate">
                                {error.reason}
                            </span>
                        )}
                    </div>

                    <div className="p-5 space-y-5">
                         {/* 内容对比区 */}
                         <div className="grid gap-3">
                            {/* 原文 */}
                            <div className="space-y-1.5 group/original">
                                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider pl-1">
                                    {t("original")}
                                </div>
                                <div className="p-3 rounded-lg bg-blush text-sm text-foreground/80 leading-relaxed transition-colors">
                                     <span className="line-through decoration-danger text-muted-foreground/80">
                                        {error.context}
                                     </span>
                                     {error.text && error.text !== error.context && (
                                        <div className="mt-2 text-xs flex items-center gap-1.5 text-danger font-medium">
                                            <span className="w-1 h-1 rounded-full bg-danger inline-block" />
                                            {error.text}
                                        </div>
                                     )}
                                </div>
                            </div>

                            {/* 箭头 */}
                            <div className="flex justify-center -my-1 text-muted-foreground/20">
                                <ArrowRight className="w-4 h-4 rotate-90" />
                            </div>

                            {/* 建议 */}
                            <div className="space-y-1.5 group/suggestion">
                                <div className="text-[10px] font-medium text-green-ink uppercase tracking-wider pl-1">
                                    {t("suggestion")}
                                </div>
                                <div className="p-3 rounded-lg bg-mint text-sm text-foreground leading-relaxed font-medium transition-colors">
                                    {error.suggestion}
                                </div>
                            </div>
                         </div>
                    
                        {/* 按钮区 */}
                        <div className="flex gap-3 pt-1">
                            <Button 
                                className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground transition-all"
                                size="sm"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleAccept(index);
                                }}
                            >
                                <Check className="w-4 h-4 mr-2" />
                                {t("accept")}
                            </Button>
                            <Button 
                                variant="outline" 
                                className="flex-1 border-muted-foreground/20 text-muted-foreground hover:text-foreground hover:bg-muted/50 hover:border-muted-foreground/30 transition-all" 
                                size="sm"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleIgnore(index);
                                }}
                            >
                                <X className="w-4 h-4 mr-2" />
                                {t("ignore")}
                            </Button>
                        </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
                
                {errors.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-20 text-center px-4">
                        {isChecking ? (
                            <>
                                <div className="w-20 h-20 bg-butter rounded-full flex items-center justify-center mb-6">
                                    <Loader2 className="w-10 h-10 text-amber-ink animate-spin" />
                                </div>
                                <h3 className="text-xl font-semibold mb-2">{t("checking")}</h3>
                                <p className="text-muted-foreground max-w-[250px]">
                                    {t("checking_desc")}
                                </p>
                            </>
                        ) : hasChecked ? (
                            <>
                                <div className="w-20 h-20 bg-mint rounded-full flex items-center justify-center mb-6 animate-in zoom-in duration-500">
                                     <Check className="w-10 h-10 text-green-ink" />
                                </div>
                                <h3 className="text-xl font-semibold mb-2">{t("no_errors_title")}</h3>
                                <p className="text-muted-foreground max-w-[250px]">
                                    {t("no_errors_desc")}
                                </p>
                            </>
                        ) : (
                            <>
                                <div className="w-20 h-20 bg-blush rounded-full flex items-center justify-center mb-6">
                                    <AlertCircle className="w-10 h-10 text-danger" />
                                </div>
                                <h3 className="text-xl font-semibold mb-2">{t("check_failed_title")}</h3>
                                <p className="text-muted-foreground max-w-[250px]">
                                    {t("check_failed_desc")}
                                </p>
                            </>
                        )}
                    </div>
                )}
            </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
