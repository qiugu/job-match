import React, { useEffect, useMemo, useRef } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ListKit } from "@tiptap/extension-list";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { useTranslations } from "@/i18n/compat/client";
import { cn } from "@/lib/utils";
import {
  Loader2,
  Type,
  Heading1,
  Heading2,
  Heading3,
  Bold,
  Italic,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
} from "lucide-react";
import { Align } from "./extensions/align";
import "@/styles/tiptap.scss";

// tiptap-markdown 在 editor.storage.markdown 上暴露 getMarkdown()，
// 但默认 Storage 类型未声明该字段，这里做最小化的类型断言封装。
interface MarkdownStorage {
  getMarkdown: () => string;
}
const getEditorMarkdown = (editor: Editor): string => {
  const storage = editor.storage as unknown as Record<
    string,
    MarkdownStorage | undefined
  >;
  return storage.markdown?.getMarkdown() ?? "";
};

// 编辑工具栏：让光标/选区所在块在「正文(p) / 标题(h1/h2/h3)」之间切换，
// 并提供加粗、斜体、有序/无序列表。核心用途是用户把误识别的 h2 标题
// 一键降级为普通段落（p），或反过来升级成标题，无需手改 Markdown 源码。
interface ToolbarButtonProps {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}

const ToolbarButton = ({ onClick, active, disabled, title, children }: ToolbarButtonProps) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    aria-pressed={active}
    disabled={disabled}
    onMouseDown={(e) => e.preventDefault()} // 防止按钮抢走编辑器焦点
    onClick={onClick}
    className={cn(
      // 设计稿 03 .tb：27px 高、6px 圆角、hover 纸底；激活 = 墨色实底（唯一强态）
      "inline-flex items-center justify-center h-[27px] min-w-[27px] px-1.5 rounded-md shrink-0",
      "text-ink-2",
      "transition-colors duration-150",
      "hover:bg-paper-2 hover:text-ink",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt/40",
      "disabled:opacity-40 disabled:pointer-events-none",
      active && "bg-ink text-paper hover:bg-ink hover:text-paper"
    )}
  >
    {children}
  </button>
);

// 分组容器：组间用 1px 竖线分隔（设计稿 03 .tb__sep），不再用浮起 chip
const ToolbarGroup = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center gap-0.5 px-1 border-r border-line last:border-r-0">
    {children}
  </div>
);

const EditorToolbar = ({ editor }: { editor: Editor }) => {
  const t = useTranslations("markdownEditor");
  return (
    <div
      className={cn(
        // 设计稿 03 .md__tb：42px、卡片底、1px 底边，工具条本身不抢焦点
        "flex items-center gap-1 px-3 h-[42px] border-b shrink-0 select-none",
        "bg-card border-line",
        "overflow-x-auto"
      )}
    >
      <ToolbarGroup>
        <ToolbarButton
          title={t("toolbar.paragraph")}
          active={editor.isActive("paragraph") && !editor.isActive("heading")}
          onClick={() => editor.chain().focus().setParagraph().run()}
        >
          <Type className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          title={t("toolbar.heading1")}
          active={editor.isActive("heading", { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        >
          <Heading1 className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          title={t("toolbar.heading2")}
          active={editor.isActive("heading", { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          title={t("toolbar.heading3")}
          active={editor.isActive("heading", { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          <Heading3 className="w-4 h-4" />
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarGroup>
        <ToolbarButton
          title={t("toolbar.bold")}
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          title={t("toolbar.italic")}
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic className="w-4 h-4" />
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarGroup>
        <ToolbarButton
          title={t("toolbar.bulletList")}
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          title={t("toolbar.orderedList")}
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered className="w-4 h-4" />
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarGroup>
        {/* 对齐按钮的高亮判定必须用「只给属性」的 isActive 形式。
            不能用 isActive("align", { align })：align 是挂在 paragraph/heading 上的
            全局属性，schema 里并不存在名为 align 的节点或标记类型，Tiptap 的
            getSchemaTypeNameByName("align") 返回 null 后直接 return false
            —— 结果是三个按钮永远不高亮，用户看不出当前对齐状态（2026-09-11 实测确认）。
            对齐本身是块级的（text-align 无行内语义），高亮态由「光标所在块的 align 属性」
            决定，因此这里只需属性匹配。 */}
        <ToolbarButton
          title={t("toolbar.alignLeft")}
          active={editor.isActive({ align: "left" })}
          onClick={() => editor.chain().focus().setAlign("left").run()}
        >
          <AlignLeft className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          title={t("toolbar.alignCenter")}
          active={editor.isActive({ align: "center" })}
          onClick={() => editor.chain().focus().setAlign("center").run()}
        >
          <AlignCenter className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          title={t("toolbar.alignRight")}
          active={editor.isActive({ align: "right" })}
          onClick={() => editor.chain().focus().setAlign("right").run()}
        >
          <AlignRight className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          title={t("toolbar.alignNone")}
          onClick={() => editor.chain().focus().unsetAlign().run()}
        >
          <AlignJustify className="w-4 h-4" />
        </ToolbarButton>
      </ToolbarGroup>
    </div>
  );
};

interface MarkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
}

// Markdown 编辑器：采用 Tiptap + tiptap-markdown 扩展，
// 在"源码模式"下让用户以纯 Markdown 文本进行所见即所得的撰写。
// 每次内容变化将 Markdown 文本回传给父组件，驱动右侧实时预览。
const MarkdownEditor = ({ value, onChange, placeholder }: MarkdownEditorProps) => {
  const t = useTranslations("markdownEditor");
  const lastSyncedMarkdown = useRef<string>(value);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // 列表相关交给 ListKit 统一管理，避免与 StarterKit 内置列表扩展冲突
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
      }),
      ListKit,
      Placeholder.configure({
        placeholder: placeholder || t("placeholder"),
      }),
      // 关键扩展：让 Tiptap 以 Markdown 字符串作为内容源与输出
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      // 左/中/右对齐容器（:::left/center/right），与预览渲染管线打通
      Align,
    ],
    [placeholder, t]
  );

  const editor = useEditor({
    extensions,
    content: value,
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        class: cn(
          "tiptap max-w-none focus:outline-none min-h-[60vh] px-5 py-4",
          "text-foreground leading-relaxed",
          "font-mono text-sm"
        ),
        spellCheck: "false",
      },
    },
    onUpdate: ({ editor }) => {
      // 通过 tiptap-markdown 的 storage 取回标准 Markdown 文本
      const markdown = getEditorMarkdown(editor);
      if (markdown === lastSyncedMarkdown.current) return;
      lastSyncedMarkdown.current = markdown;
      onChange(markdown);
    },
  });

  // 外部 value 变化（如切换简历）时，同步到编辑器
  useEffect(() => {
    if (!editor) return;
    if (value === lastSyncedMarkdown.current) return;
    if (value === getEditorMarkdown(editor)) return;
    lastSyncedMarkdown.current = value;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [value, editor]);

  if (!editor) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "h-full min-h-0 flex flex-col overflow-hidden bg-background",
        "border-border"
      )}
    >
      <EditorToolbar editor={editor} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <EditorContent editor={editor} className="h-full" />
      </div>
    </div>
  );
};

export default MarkdownEditor;
