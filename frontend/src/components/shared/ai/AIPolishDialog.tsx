import { useEffect, useState, useRef } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/compat/client";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { createMarkdownExit } from "markdown-exit";
import TurndownService from "turndown";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { authHeaders, handleUnauthorized } from "@/lib/auth";

interface AIPolishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  content: string;
  onApply: (content: string) => void;
}

// markdown-exit 实例，用于将 AI 返回的 Markdown 转换为 Tiptap 兼容的 HTML
const md = createMarkdownExit({
  html: true,       // 允许 HTML 标签透传
  breaks: true,     // 将换行符转换为 <br>
  linkify: false,   // 简历内容不需要自动识别链接
});

// turndown 实例，用于将 Tiptap HTML 转换为 Markdown 发给 AI
const turndownService = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
});

export default function AIPolishDialog({
  open,
  onOpenChange,
  content,
  onApply
}: AIPolishDialogProps) {
  const t = useTranslations("aiPolishDialog");
  const [isPolishing, setIsPolishing] = useState(false);
  const [polishedContent, setPolishedContent] = useState("");
  const [customInstructions, setCustomInstructions] = useState("");
  const abortControllerRef = useRef<AbortController | null>(null);
  const polishedContentRef = useRef<HTMLDivElement>(null);

  const getPolishErrorMessage = async (response: Response) => {
    const fallback = `${t("error.polishFailed")} (${response.status})`;

    try {
      const contentType = response.headers.get("content-type") || "";
      const rawText = await response.text();

      if (!rawText) {
        if (response.status === 401) {
          return "认证失败（401），请检查 API Key、模型和 API Endpoint 配置。";
        }
        return fallback;
      }

      if (contentType.includes("application/json") || rawText.startsWith("{")) {
        const data = JSON.parse(rawText) as {
          error?: string | { message?: string };
          message?: string;
          detail?: string;
        };

        if (typeof data.error === "string" && data.error.trim()) {
          return data.error.trim();
        }
        if (typeof data.error === "object" && data.error?.message?.trim()) {
          return data.error.message.trim();
        }
        if (data.message?.trim()) {
          return data.message.trim();
        }
        if (data.detail?.trim()) {
          return data.detail.trim();
        }
      } else if (rawText.trim()) {
        return rawText.trim();
      }
    } catch {

    }

    if (response.status === 401) {
      return "认证失败（401），请检查 API Key、模型和 API Endpoint 配置。";
    }

    return fallback;
  };

  const handlePolish = async () => {
    try {
      setIsPolishing(true);
      setPolishedContent("");

      abortControllerRef.current = new AbortController();

      if (!authHeaders().Authorization) {
        handleUnauthorized();
        return;
      }

      const response = await fetch("/api/ai/polish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders()
        },
        body: JSON.stringify({
          content: turndownService.turndown(content),
          customInstructions: customInstructions.trim() || undefined
        }),
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) {
        const errorMessage = await getPolishErrorMessage(response);
        throw new Error(errorMessage);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        setPolishedContent((prev) => prev + chunk);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.log("Polish aborted");
        return;
      }
      console.error("Polish error:", error);
      toast.error(error instanceof Error ? error.message : t("error.polishFailed"));
    } finally {
      setIsPolishing(false);
    }
  };

  // 自动滚动到底部
  useEffect(() => {
    if (polishedContent && polishedContentRef.current) {
      const container = polishedContentRef.current;
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  }, [polishedContent]);

  useEffect(() => {
    if (!open) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      setPolishedContent("");
      setCustomInstructions("");
    }
  }, [open]);

  const handleClose = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    onOpenChange(false);
    setPolishedContent("");
  };

  const handleApply = () => {
    const htmlContent = md.render(polishedContent);
    onApply(htmlContent);
    handleClose();
    toast.success(t("error.applied"));
  };

  const handleOpenChange = (open: boolean) => {
    if (!open && !isPolishing) {
      onOpenChange(open);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn(
          "sm:max-w-[1000px]",
          "bg-white dark:bg-background",
          "border-border dark:border-border",
          "rounded-2xl shadow-2xl dark:shadow-none"
        )}
        onPointerDownOutside={(e) => {
          e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
        }}
        onInteractOutside={(e) => {
          e.preventDefault();
        }}
      >
        <DialogHeader className="pb-6">
          <DialogTitle
            className={cn(
              "flex items-center gap-2 text-2xl",
              "text-foreground dark:text-foreground"
            )}
          >
            <Sparkles
              className={cn(
                "h-6 w-6 text-primary animate-pulse",
                "dark:text-primary-400"
              )}
            />
            {t("title")}
          </DialogTitle>
          <DialogDescription
            className={cn(
              "text-base",
              "text-muted-foreground dark:text-muted-foreground"
            )}
          >
            {isPolishing
              ? t("description.polishing")
              : polishedContent
                ? t("description.finished")
                : t("description.ready")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label
            htmlFor="custom-instructions"
            className={cn(
              "text-sm font-medium",
              "text-muted-foreground dark:text-muted-foreground"
            )}
          >
            {t("customInstructions")}
          </Label>
          <Textarea
            id="custom-instructions"
            placeholder={t("customInstructionsPlaceholder")}
            value={customInstructions}
            onChange={(e) => setCustomInstructions(e.target.value)}
            disabled={isPolishing}
            rows={2}
            className={cn(
              "resize-none rounded-xl border",
              "bg-muted dark:bg-muted/50",
              "border-border dark:border-border",
              "text-foreground dark:text-foreground",
              "placeholder:text-muted-foreground dark:placeholder:text-muted-foreground"
            )}
          />
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2 px-3">
              <div
                className={cn(
                  "w-1.5 h-1.5 rounded-full",
                  "bg-muted0 dark:bg-muted-foreground"
                )}
              ></div>
              <span
                className={cn(
                  "text-sm font-medium",
                  "text-muted-foreground dark:text-muted-foreground"
                )}
              >
                {t("content.original")}
              </span>
            </div>
            <div
              className={cn(
                "relative rounded-xl border",
                "bg-muted dark:bg-muted/50",
                "border-border dark:border-border",
                "p-6 h-[400px] overflow-auto shadow-sm"
              )}
            >
              <Streamdown
                className={cn(
                  "prose dark:prose-invert max-w-none",
                  "text-foreground dark:text-foreground"
                )}
              >
                {turndownService.turndown(content)}
              </Streamdown>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 px-3">
              <div
                className={cn(
                  "w-1.5 h-1.5 rounded-full",
                  "bg-primary animate-pulse"
                )}
              ></div>
              <span
                className={cn(
                  "text-sm font-medium",
                  "text-primary dark:text-primary-400"
                )}
              >
                {t("content.polished")}
              </span>
            </div>
            <div
              ref={polishedContentRef}
              className={cn(
                "relative rounded-xl border",
                "bg-primary/[0.03] dark:bg-primary/[0.1]",
                "border-primary/20 dark:border-primary/30",
                "p-6 h-[400px] overflow-auto shadow-sm scroll-smooth"
              )}
            >
              <Streamdown
                animated
                isAnimating={isPolishing}
                className={cn(
                  "prose dark:prose-invert max-w-none",
                  "text-foreground dark:text-foreground"
                )}
              >
                {polishedContent}
              </Streamdown>
            </div>
          </div>
        </div>

        <DialogFooter className="mt-6 flex items-center gap-3">
          <Button
            onClick={handlePolish}
            disabled={isPolishing}
            className="flex-1 bg-gradient-to-r from-[#9333EA] to-[#EC4899] hover:opacity-90 text-white border-none h-11 shadow-lg shadow-purple-500/20"
          >
            {isPolishing ? (
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("button.generating")}
              </div>
            ) : !polishedContent ? (
              t("button.start")
            ) : (
              t("button.regenerate")
            )}
          </Button>

          <Button
            onClick={handleApply}
            disabled={!polishedContent || isPolishing}
            className="flex-1 bg-primary hover:bg-primary/90 text-white h-11 shadow-lg shadow-primary/20"
          >
            {t("button.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
