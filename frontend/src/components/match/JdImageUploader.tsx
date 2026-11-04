/**
 * JD Composer：AI 聊天框式的岗位描述输入容器。
 *
 * 设计意图（2026-11-04 用户指定）：截图不再是独立的虚线上传盒，而是像
 * ChatGPT / Claude 输入框那样「贴进同一个输入容器」——
 *   - 整块只有一个边框；focus-within 才出钴蓝（全站唯一信号色）；
 *   - 已附加的截图是输入区顶部的小方形附件 chip，带 × 移除、带 + 继续添加；
 *   - 底部工具条只有两个无框图标按钮 + 计数 + 粘贴快捷键提示；
 *   - 拖放 / 粘贴 / 链接三种入口都落在这个容器里，拖放时才出现瞬时浮层，
 *     不再常驻虚线框、不再堆两行近义说明文案。
 *
 * 文件名沿用 JdImageUploader：既有页面引用与源码字符串回归测试都指向它，
 * 重命名会平白扩大改动面；组件职责已是 composer 外壳。
 *
 * 交互契约不变：点击选择、拖拽、Ctrl/⌘+V 粘贴、添加图片链接（经 /image-proxy），
 * 0/4 计数、类型 / 格式 / 体积 / 总量 / 链接错误态；产出的仍是 data URL 列表，
 * 由父页面在匹配 / 话术请求里一并提交（单一提交点，图片与 JD 文本不会不同步）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ImageIcon, ImagePlus, Link2, Loader2, X } from "lucide-react";
import { useTranslations } from "@/i18n/compat/client";
import { cn } from "@/lib/utils";
import {
  ALLOWED_JD_IMAGE_MIME,
  MAX_JD_IMAGES,
  blobToDataUrl,
  buildImageProxyUrl,
  checkJdImageCapacity,
  estimateDataUrlBytes,
  imageFileToDataUrl,
  normalizeImageUrl,
  validateJdImage,
  type JdImageItem,
  type JdImageRejectReason,
} from "@/lib/jdImages";

interface JdImageUploaderProps {
  images: JdImageItem[];
  onChange: (images: JdImageItem[]) => void;
  disabled?: boolean;
  /** 输入框本体（Textarea）。父页面保留 ref / value / onBlur 契约。 */
  children: ReactNode;
}

/** 聊天框工具按钮：无边框，靠 hover 底色 + 钴蓝文字表态，避免又叠一个小卡片。 */
const TOOL_BUTTON =
  "inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-semibold leading-none tracking-normal normal-case text-ink-2 transition-colors hover:bg-paper-2 hover:text-cobalt disabled:cursor-not-allowed disabled:opacity-50";

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `jd-img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function JdImageUploader({
  images,
  onChange,
  disabled = false,
  children,
}: JdImageUploaderProps) {
  const t = useTranslations("jobmatch");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rejectMessage = useCallback(
    (reason: JdImageRejectReason | "limit" | "total"): string => {
      switch (reason) {
        case "limit":
          return t("jdImagesLimit", { max: String(MAX_JD_IMAGES) });
        case "total":
          return t("jdImagesTotalTooLarge");
        case "size":
          return t("jdImagesTooLarge");
        case "type":
        case "format":
          return t("jdImagesType");
        default:
          return t("jdImagesLoadFailed");
      }
    },
    [t]
  );

  /** 统一的追加路径：先做容量校验，再一次性提交，避免半更新状态。 */
  const appendImages = useCallback(
    (items: JdImageItem[]) => {
      const capacity = checkJdImageCapacity(
        images.map((item) => estimateDataUrlBytes(item.dataUrl)),
        items.map((item) => estimateDataUrlBytes(item.dataUrl))
      );
      if (!capacity.ok) {
        setError(rejectMessage(capacity.reason));
        return;
      }
      setError(null);
      onChange([...images, ...items]);
    },
    [images, onChange, rejectMessage]
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      if (disabled || busy || files.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        const items: JdImageItem[] = [];
        for (const file of files) {
          // File.type 为空时（部分拖拽场景）交给后续 data URL 校验兜底。
          if (
            file.type &&
            !(ALLOWED_JD_IMAGE_MIME as readonly string[]).includes(file.type)
          ) {
            setError(t("jdImagesType"));
            return;
          }
          let dataUrl: string;
          try {
            dataUrl = await imageFileToDataUrl(file);
          } catch {
            setError(t("jdImagesLoadFailed"));
            return;
          }
          const checked = validateJdImage(dataUrl);
          if (!checked.ok) {
            setError(rejectMessage(checked.reason));
            return;
          }
          items.push({
            id: makeId(),
            dataUrl,
            name: file.name || "pasted-image",
            source: file.name ? "file" : "paste",
          });
        }
        appendImages(items);
      } finally {
        setBusy(false);
      }
    },
    [appendImages, busy, disabled, rejectMessage, t]
  );

  const addLink = useCallback(async () => {
    const url = normalizeImageUrl(linkValue);
    if (!url) {
      setError(t("jdImagesInvalidUrl"));
      return;
    }
    if (disabled || busy) return;
    setBusy(true);
    setError(null);
    try {
      // 外链一律走服务端代理：既绕过防盗链/CORS，也避免把任意 URL
      // 直接交给业务后端（后端只接受 data URL）。
      const response = await fetch(buildImageProxyUrl(url));
      if (!response.ok) throw new Error(`proxy ${response.status}`);
      const blob = await response.blob();
      const dataUrl = await blobToDataUrl(blob);
      const checked = validateJdImage(dataUrl);
      if (!checked.ok) {
        setError(rejectMessage(checked.reason));
        return;
      }
      appendImages([
        { id: makeId(), dataUrl, name: url, source: "url" },
      ]);
      setLinkOpen(false);
      setLinkValue("");
    } catch {
      setError(t("jdImagesLoadFailed"));
    } finally {
      setBusy(false);
    }
  }, [appendImages, busy, disabled, linkValue, rejectMessage, t]);

  // 粘贴监听：聊天框语义是「聚焦输入区后 Ctrl/⌘+V」。焦点在本容器内、
  // 或落在 body（用户先点了空白处）时才接住；页面其它输入框不被劫持。
  useEffect(() => {
    if (disabled) return;
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      let hasText = false;
      for (const item of items) {
        if (item.kind === "string" && item.type === "text/plain") hasText = true;
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length === 0) return;
      // 图片 + 文本混合粘贴时让浏览器走默认行为：preventDefault 会把文本一起吞掉。
      // 纯图片粘贴才拦截并加入附件条；混合场景用户可单独粘贴纯图片。
      if (hasText) return;
      const active = document.activeElement;
      const inside =
        !active ||
        active === document.body ||
        containerRef.current?.contains(active);
      if (!inside) return;
      event.preventDefault();
      void addFiles(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [addFiles, disabled]);

  const removeImage = (id: string) => {
    setError(null);
    onChange(images.filter((item) => item.id !== id));
  };

  return (
    <div className="space-y-1.5">
      <div
        ref={containerRef}
        role="group"
        aria-label={t("jdImagesHint")}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled && !busy) setDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          // 仅当指针真正离开整个输入容器时才复位，避免在子元素间移动时闪烁。
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          if (disabled || busy) return;
          void addFiles(Array.from(event.dataTransfer.files));
        }}
        className={cn(
          "relative overflow-hidden rounded-lg border bg-card transition-colors focus-within:border-cobalt",
          dragActive ? "border-cobalt" : "border-line-strong",
          disabled && "opacity-60"
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="sr-only"
          disabled={disabled || busy}
          onChange={(event) => {
            void addFiles(Array.from(event.target.files ?? []));
            // 允许连续选择同一个文件
            event.target.value = "";
          }}
        />

        {/* 附件条：只在有图时出现，像聊天框里已附加的图片，而非一个上传面板 */}
        {images.length > 0 && (
          <div
            role="group"
            aria-label={t("jdImagesLabel")}
            className="flex flex-wrap gap-2 border-b border-line px-3 pb-2.5 pt-3"
          >
            {images.map((item) => (
              <div
                key={item.id}
                className="jd-chip-in relative h-14 w-14 shrink-0 overflow-hidden rounded-md border border-line-strong bg-paper"
              >
                <img
                  src={item.dataUrl}
                  alt={item.name}
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeImage(item.id)}
                  disabled={disabled}
                  aria-label={t("jdImagesRemove")}
                  title={item.name}
                  className="absolute right-0.5 top-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-ink text-paper transition-colors hover:bg-danger disabled:cursor-not-allowed"
                >
                  <X className="h-2.5 w-2.5" aria-hidden="true" />
                </button>
              </div>
            ))}
            {images.length < MAX_JD_IMAGES && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || busy}
                aria-label={t("jdImagesAdd")}
                title={t("jdImagesHint")}
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-dashed border-line-strong text-ink-3 transition-colors hover:border-cobalt hover:text-cobalt disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ImagePlus className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        {/* 输入区本体：Textarea 由父页面传入，自身无边框、透明底，融进同一个容器 */}
        {children}

        {/* 链接入口展开时贴在工具条上方，仍属于同一个 composer */}
        {linkOpen && (
          <div className="flex flex-wrap gap-2 border-t border-line px-3 py-2">
            <input
              type="url"
              value={linkValue}
              onChange={(event) => setLinkValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void addLink();
                }
              }}
              placeholder={t("jdImagesLinkPlaceholder")}
              aria-label={t("jdImagesLinkPlaceholder")}
              className="min-w-0 flex-1 rounded-md border border-line-strong bg-paper px-2 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:border-cobalt focus:outline-none"
            />
            <button
              type="button"
              className="rounded-md bg-cobalt px-3 text-xs font-semibold text-paper hover:bg-cobalt-deep disabled:opacity-60"
              disabled={disabled || busy}
              onClick={() => void addLink()}
            >
              {t("jdImagesLinkSubmit")}
            </button>
            <button
              type="button"
              className={TOOL_BUTTON}
              onClick={() => {
                setLinkOpen(false);
                setLinkValue("");
                setError(null);
              }}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              {t("jdImagesLinkCancel")}
            </button>
          </div>
        )}

        {/* 底部工具条：两个 ghost 按钮 + 计数 + 快捷键提示，无常驻说明文案 */}
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-line px-2 py-1.5">
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              className={TOOL_BUTTON}
              disabled={disabled || busy}
              title={t("jdImagesHint")}
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
              {t("jdImagesAdd")}
            </button>
            <button
              type="button"
              className={cn(TOOL_BUTTON, linkOpen && "bg-paper-2 text-cobalt")}
              disabled={disabled || busy}
              aria-expanded={linkOpen}
              onClick={() => {
                setError(null);
                setLinkOpen((open) => !open);
              }}
            >
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t("jdImagesAddLink")}
            </button>
          </div>
          <div className="flex items-center gap-2 pr-1">
            {busy && (
              <Loader2
                className="h-3 w-3 animate-spin text-cobalt"
                aria-hidden="true"
              />
            )}
            <span className="eb-zh tabular-nums text-ink-3" aria-live="polite">
              {images.length} / {MAX_JD_IMAGES}
            </span>
            <span
              aria-hidden="true"
              className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] leading-none text-ink-3"
            >
              Ctrl/⌘ V
            </span>
          </div>
        </div>

        {/* 拖放瞬时浮层：虚线只在拖放这一刻出现，不再常驻成一个上传面板 */}
        {dragActive && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 border-2 border-dashed border-cobalt bg-card">
            <ImageIcon className="h-5 w-5 text-cobalt" aria-hidden="true" />
            <span className="eb-zh text-[13px] font-semibold text-ink">
              {t("jdImagesEmpty")}
            </span>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export type { JdImageItem };
