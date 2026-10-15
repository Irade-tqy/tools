// CodeMirror 6 wrapper for the clipboard editor. Markdown mode + one-dark keeps the
// editor readable without shipping a theme of our own.

import { basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';

export interface ClipboardEditor {
  get(): string;
  set(text: string): void;
  focus(): void;
  onChange(fn: (text: string) => void): void;
  saveShortcut: (fn: () => void) => void;
  destroy(): void;
  insert(value: string | [string, string], atLineStart?: boolean): void;
  setReadOnly(readOnly: boolean): void;
  onSelection(fn: (line: number, column: number, selected: number, total: number) => void): void;
  scrollDOM: HTMLElement;
}

export function mountEditor(container: HTMLElement): ClipboardEditor {
  const listeners: Array<(text: string) => void> = [];
  let onSave: (() => void) | null = null;
  let onSelection: ((line: number, column: number, selected: number, total: number) => void) | null = null;
  const editable = new Compartment();

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      const text = update.state.doc.toString();
      for (const fn of listeners) fn(text);
    }
    if (update.selectionSet || update.docChanged) {
      const { head, from, to } = update.state.selection.main;
      const line = update.state.doc.lineAt(head);
      onSelection?.(line.number, [...update.state.sliceDoc(line.from, head)].length + 1,
        [...update.state.sliceDoc(from, to)].length, [...update.state.doc.toString()].length);
    }
  });

  const saveKeymap = keymap.of([
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        onSave?.();
        return true;
      },
    },
  ]);

  const view = new EditorView({
    parent: container,
    state: EditorState.create({
      doc: '',
      extensions: [basicSetup, markdown(), EditorView.lineWrapping, saveKeymap, updateListener,
        editable.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
        EditorView.contentAttributes.of({ 'aria-label': 'Markdown 编辑区域' })],
    }),
  });

  return {
    get: () => view.state.doc.toString(),
    set: (text: string) =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    focus: () => view.focus(),
    onChange: (fn) => listeners.push(fn),
    saveShortcut: (fn) => {
      onSave = fn;
    },
    destroy: () => view.destroy(),
    insert: (value, atLineStart = false) => {
      const { from, to } = view.state.selection.main;
      const start = atLineStart ? view.state.doc.lineAt(from).from : from;
      const selected = view.state.sliceDoc(from, to);
      const text = Array.isArray(value) ? value[0] + selected + value[1] : value;
      const anchor = start + (Array.isArray(value) && !selected ? value[0].length : text.length);
      view.dispatch({ changes: { from: start, to: atLineStart ? start : to, insert: text }, selection: { anchor }, scrollIntoView: true });
      view.focus();
    },
    setReadOnly: (readOnly) => view.dispatch({ effects: editable.reconfigure([
      EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
    ]) }),
    onSelection: (fn) => { onSelection = fn; },
    scrollDOM: view.scrollDOM,
  };
}
