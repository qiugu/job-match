import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ListKit } from "@tiptap/extension-list";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { Align } from "@/components/editor/extensions/align";
import { MARKDOWN_SAMPLE_ZH } from "@/config/markdownTemplates/samples";
import { renderMarkdownToHtml } from "@/utils/markdownRender";
// 真实编辑态样式（与 MarkdownEditor.tsx 共用），供截图模式使用
import "@/styles/tiptap.scss";

// 取真实内置模板做端到端往返：`modern` 是「紧凑配对」写法的唯一使用方
// （中文 5 处 + 英文 5 处，均落在 modern 模板内）
const MODERN_SAMPLE_ZH = MARKDOWN_SAMPLE_ZH.modern;

// 与 components/editor/MarkdownEditor.tsx 的扩展配置保持一致
const buildExtensions = () => [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    bulletList: false,
    orderedList: false,
    listItem: false,
    listKeymap: false,
  }),
  ListKit,
  Placeholder.configure({ placeholder: "placeholder" }),
  Markdown.configure({
    html: false,
    transformPastedText: true,
    transformCopiedText: true,
  }),
  Align,
];

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 创建编辑器并等到 create 事件真正触发（Align 的序列化器补丁在 onCreate 里） */
const createEditor = async (content) => {
  const editor = new Editor({ extensions: buildExtensions(), content });
  await nextTick();
  return editor;
};

const md = (editor) => editor.storage.markdown.getMarkdown().trim();

window.__probe = async () => {
  const result = {};

  // 用例 1：单行内联配对（模板里「左电话 + 右城市」的写法）
  {
    const content =
      ":::left 138-0013-8000 · zhangsan@example.com ::: :::right 北京市朝阳区 :::";
    const editor = await createEditor(content);
    const after = md(editor);
    result.inlinePair = {
      before: content,
      after,
      editorHtml: editor.getHTML(),
      "段落数": editor.state.doc.childCount,
      "各段 align": JSON.stringify(
        Array.from({ length: editor.state.doc.childCount }, (_, i) =>
          editor.state.doc.child(i).attrs.align ?? null
        )
      ),
    };
    editor.destroy();
  }

  // 用例 1b：幂等性 —— 把序列化产物再喂回编辑器，应稳定不再变化
  {
    const first = await createEditor(
      ":::left 138-0013-8000 · zhangsan@example.com ::: :::right 北京市朝阳区 :::"
    );
    const once = md(first);
    first.destroy();
    const second = await createEditor(once);
    result.inlinePairIdempotent = { 第一次: once, 第二次: md(second) };
    second.destroy();
  }

  // 用例 1c：单段内联（只有一个 span）应保持「一个对齐段落」，不被误拆
  {
    const editor = await createEditor(":::left 138-0013-8000 :::");
    result.inlineSingle = {
      after: md(editor),
      段落数: editor.state.doc.childCount,
      "首段 align": editor.state.doc.child(0).attrs.align ?? null,
    };
    editor.destroy();
  }

  // 用例 1d：同一行内的三段（left + center + right）
  {
    const editor = await createEditor(":::left A ::: :::center B ::: :::right C :::");
    result.inlineTriple = {
      after: md(editor),
      段落数: editor.state.doc.childCount,
      "各段 align": JSON.stringify(
        Array.from({ length: editor.state.doc.childCount }, (_, i) =>
          editor.state.doc.child(i).attrs.align ?? null
        )
      ),
    };
    editor.destroy();
  }

  // 用例 1e：配对段落里含行内标记（strong），应被保留
  {
    const editor = await createEditor(
      ":::left **字节跳动** · 高级前端工程师 ::: :::right 2021.07 – 2024.12 :::"
    );
    result.inlinePairMarks = {
      after: md(editor),
      editorHtml: editor.getHTML(),
    };
    editor.destroy();
  }

  // 用例 1f：真实模板整篇往返（最高价值）—— 统计 ::: 容器与关键行的存活情况
  {
    const editor = await createEditor(MODERN_SAMPLE_ZH);
    const after = md(editor);
    const countContainers = (text) => (text.match(/:::(left|right|center)\b/g) || []).length;
    const lineWith = (text, keyword) =>
      (text.split("\n").find((l) => l.includes(keyword)) || "").trim();
    result.modernTemplate = {
      "原 ::: 容器数": countContainers(MODERN_SAMPLE_ZH),
      "往返后 ::: 容器数": countContainers(after),
      "原联系人行": lineWith(MODERN_SAMPLE_ZH, "138-0013-8000"),
      "往返后联系人行": lineWith(after, "138-0013-8000"),
      "原字节跳动行": lineWith(MODERN_SAMPLE_ZH, "字节跳动"),
      "往返后字节跳动行": lineWith(after, "字节跳动"),
      "是否出现粘连 'example.com北京市'": after.includes("example.com北京市"),
      "是否仍有 '北京市朝阳区'": after.includes("北京市朝阳区"),
    };
    editor.destroy();
  }

  // 用例 2：多行块容器
  {
    const content = ":::right\n宋哈娜\n:::";
    const editor = await createEditor(content);
    result.blockAlign = { before: content, after: md(editor) };
    editor.destroy();
  }

  // 用例 3：只选中一行里的部分文本，点「居右」
  {
    const editor = await createEditor("北京大学 · 计算机科学与技术（2013.09 – 2017.06）");
    editor.commands.setTextSelection({ from: 2, to: 5 });
    const selection = editor.state.selection;
    editor.chain().focus().setAlign("right").run();
    result.partialSelection = {
      选中字符数: selection.to - selection.from,
      "isActive({align:'right'})": editor.isActive({ align: "right" }),
      序列化结果: md(editor),
    };
    editor.destroy();
  }

  // 用例 4：工具栏 active 判定（MarkdownEditor.tsx 用的是带名字的那种写法）
  {
    const editor = await createEditor(":::right\n宋哈娜\n:::");
    editor.commands.setTextSelection(2);
    result.activeProbe = {
      'isActive("align", { align: "right" })': editor.isActive("align", { align: "right" }),
      'isActive({ align: "right" })': editor.isActive({ align: "right" }),
    };
    editor.destroy();
  }

  // 用例 5：序列化器补丁与「相邻 left+right 块合并成一行」的往返
  {
    const editor = await createEditor("宋哈娜");
    const s = editor.storage.markdown.serializer;
    result.patchProbe = {
      __alignPatched: s.__alignPatched,
      "paragraph 已被包装": Boolean(s.nodes.paragraph?.__alignWrapped),
    };
    editor.destroy();
  }

  {
    // 模拟编辑器里「上一段设居左 + 下一段设居右」，看序列化产物能否在预览里合并为同一行
    const editor = await createEditor(
      "138-0013-8000 · zhangsan@example.com\n\n北京市朝阳区"
    );
    const p1Size = editor.state.doc.child(0).nodeSize;
    editor.commands.setTextSelection(2);
    editor.chain().focus().setAlign("left").run();
    editor.commands.setTextSelection(p1Size + 2);
    editor.chain().focus().setAlign("right").run();
    result.adjacentBlocks = {
      序列化结果: md(editor),
      第二段attrs: JSON.stringify(editor.state.doc.child(1).attrs),
    };
    editor.destroy();
  }

  // 用例 6：同行左右分列按钮 —— 部分选区（选中行尾日期）拆 [前缀 | 选中]
  {
    const editor = await createEditor("字节跳动 · 高级前端工程师 2021.07 – 2024.12");
    const size = editor.state.doc.firstChild.content.size;
    const dateFrom = "字节跳动 · 高级前端工程师 ".length + 1; // doc 坐标 = 文本偏移 + 1
    editor.commands.setTextSelection({ from: dateFrom, to: size + 1 });
    const ok = editor.chain().focus().setAlignPair().run();
    const after = md(editor);
    result.alignPairSplit = {
      命令结果: ok,
      段落数: editor.state.doc.childCount,
      各段align: JSON.stringify(
        Array.from({ length: editor.state.doc.childCount }, (_, i) =>
          editor.state.doc.child(i).attrs.align ?? null
        )
      ),
      序列化结果: after,
      预览含mdPairRow: renderMarkdownToHtml(after).includes("md-pair-row"),
    };
    editor.destroy();
  }

  // 用例 6b：toggle 往返 —— 拆分后再点合并回单段，文本无损（接缝补一空格）
  {
    const editor = await createEditor("字节跳动 · 高级前端工程师 2021.07 – 2024.12");
    const size = editor.state.doc.firstChild.content.size;
    const dateFrom = "字节跳动 · 高级前端工程师 ".length + 1;
    editor.commands.setTextSelection({ from: dateFrom, to: size + 1 });
    editor.chain().focus().toggleAlignPair().run();
    const splitMd = md(editor);
    // 光标落在左列内再点 = 取消配对
    editor.commands.setTextSelection(2);
    const merged = editor.chain().focus().toggleAlignPair().run();
    result.alignPairToggle = {
      拆分后: splitMd,
      合并命令结果: merged,
      合并后段落数: editor.state.doc.childCount,
      合并后文本: editor.state.doc.textContent,
      合并后align: editor.state.doc.firstChild.attrs.align ?? null,
    };
    editor.destroy();
  }

  // 用例 6c：跨两段选区直接配对（内容不动，只落 align）
  {
    const editor = await createEditor("阿里巴巴\n\n2022 - 2025");
    const p1Size = editor.state.doc.child(0).nodeSize;
    editor.commands.setTextSelection({ from: 2, to: p1Size + 2 });
    const ok = editor.chain().focus().setAlignPair().run();
    result.alignPairTwoBlocks = {
      命令结果: ok,
      序列化结果: md(editor),
      两段align: JSON.stringify([
        editor.state.doc.child(0).attrs.align,
        editor.state.doc.child(1).attrs.align,
      ]),
    };
    editor.destroy();
  }

  return result;
};

window.__extensionOrder = buildExtensions().map((e) => e.name);

/**
 * 截图模式：把某个模板挂进 #visual-root，供 `run.mjs --shot` 截图。
 * 用真实 Editor + 真实 `.tiptap` 样式渲染，因此产出的是「修复前 / 修复后」的
 * **真实编辑区形态**，而非示意图。
 */
window.__mountVisual = async (markdown = MODERN_SAMPLE_ZH) => {
  const host = document.getElementById("visual-root");
  if (!host) throw new Error("缺少 #visual-root 容器");
  const editor = new Editor({
    element: host,
    extensions: buildExtensions(),
    content: markdown,
    editable: true,
  });
  await nextTick();
  window.__visualEditor = editor;
  return editor.getHTML();
};

window.__ready = true;
