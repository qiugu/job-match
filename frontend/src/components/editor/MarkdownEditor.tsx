import React, { useEffect, useMemo, useRef } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ListKit } from "@tiptap/extension-list";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { useTranslations } from "@/i18n/compat/client";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
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
          "text-neutral-900 dark:text-neutral-100 leading-relaxed",
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
        "h-full min-h-0 overflow-y-auto bg-background",
        "border-border"
      )}
    >
      <EditorContent editor={editor} className="h-full" />
    </div>
  );
};

export default MarkdownEditor;
