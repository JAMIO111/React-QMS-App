import { useEffect, useRef } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { BoldIcon, Heading1Icon, Heading2Icon, Heading3Icon, ItalicIcon, ListIcon, ListOrderedIcon, Redo2Icon, TableIcon, Undo2Icon } from "@/components/icons";
import { EMPTY_DOC } from "../../lib/documents";

/** How long typing pauses before a draft is saved. */
export const SAVE_DELAY_MS = 800;

const extensions = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, defaultProtocol: "https" } }),
  TableKit.configure({ table: { resizable: false } }),
];

const ToolButton = ({ label, active, disabled, onClick, children }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    aria-pressed={active ?? undefined}
    disabled={disabled}
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    className={`rounded-md p-1.5 text-primary-text transition-colors hover:bg-primary-text/10 disabled:opacity-40 ${active ? "bg-brand-primary/15 text-brand-primary" : ""}`}>
    {children}
  </button>
);

const Toolbar = ({ editor }) => {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      inTable: e.isActive("table"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-1 border-b border-border-color bg-secondary-bg px-2 py-1">
      <ToolButton label="Bold" active={state.bold} onClick={() => chain().toggleBold().run()}>
        <BoldIcon />
      </ToolButton>
      <ToolButton label="Italic" active={state.italic} onClick={() => chain().toggleItalic().run()}>
        <ItalicIcon />
      </ToolButton>
      <span className="mx-1 h-5 w-px bg-border-color" />
      <ToolButton label="Heading 1" active={state.h1} onClick={() => chain().toggleHeading({ level: 1 }).run()}>
        <Heading1Icon />
      </ToolButton>
      <ToolButton label="Heading 2" active={state.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()}>
        <Heading2Icon />
      </ToolButton>
      <ToolButton label="Heading 3" active={state.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()}>
        <Heading3Icon />
      </ToolButton>
      <span className="mx-1 h-5 w-px bg-border-color" />
      <ToolButton label="Bulleted list" active={state.bullet} onClick={() => chain().toggleBulletList().run()}>
        <ListIcon />
      </ToolButton>
      <ToolButton label="Numbered list" active={state.ordered} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrderedIcon />
      </ToolButton>
      <span className="mx-1 h-5 w-px bg-border-color" />
      <ToolButton label="Insert a table" disabled={state.inTable} onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
        <TableIcon />
      </ToolButton>
      {state.inTable && (
        <>
          {[
            ["Add a row", () => chain().addRowAfter().run()],
            ["Add a column", () => chain().addColumnAfter().run()],
            ["Delete the row", () => chain().deleteRow().run()],
            ["Delete the column", () => chain().deleteColumn().run()],
            ["Delete the table", () => chain().deleteTable().run()],
          ].map(([label, run]) => (
            <button key={label} type="button" onMouseDown={(e) => e.preventDefault()} onClick={run} className="rounded-md px-2 py-1 text-xs text-primary-text hover:bg-primary-text/10">
              {label}
            </button>
          ))}
        </>
      )}
      <span className="ml-auto" />
      <ToolButton label="Undo" disabled={!state.canUndo} onClick={() => chain().undo().run()}>
        <Undo2Icon />
      </ToolButton>
      <ToolButton label="Redo" disabled={!state.canRedo} onClick={() => chain().redo().run()}>
        <Redo2Icon />
      </ToolButton>
    </div>
  );
};

/**
 * The text of a text document, in TipTap. Editable for a draft (with a toolbar; `onChange(json)` is called once typing pauses),
 * read-only otherwise. What is stored is the editor's JSON, and it is shown through the same schema, so no HTML is ever stored or injected.
 */
const DocumentEditor = ({ value, editable = false, onChange, label = "Document text" }) => {
  const timer = useRef(null);
  const latest = useRef(onChange);
  latest.current = onChange;
  const editor = useEditor({
    extensions,
    content: value ?? EMPTY_DOC,
    editable,
    immediatelyRender: true,
    editorProps: { attributes: { "aria-label": label, class: "document-text min-h-64 px-4 py-3 outline-none" } },
    onUpdate: ({ editor: e }) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => latest.current?.(e.getJSON()), SAVE_DELAY_MS);
    },
  });

  // Save what is pending when the page closes the editor.
  useEffect(
    () => () => {
      if (timer.current && editor && !editor.isDestroyed) {
        clearTimeout(timer.current);
        latest.current?.(editor.getJSON());
      }
    },
    [editor],
  );
  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  if (!editor) return null;
  return (
    <div className="overflow-hidden rounded-xl border border-border-color bg-primary-bg">
      {editable && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
};

export default DocumentEditor;
